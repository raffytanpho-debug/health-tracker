#!/usr/bin/env node
/* sync-to-drive.mjs — the nightly bridge between the iPhone's export folder and
 * the phone app.
 *
 * WHY THIS EXISTS
 * The PWA authenticates with the drive.file scope, which by design only exposes
 * files the same OAuth client created. The Health Auto Export files were created
 * by the iPhone app, so the PWA can never read them directly. Broadening to
 * drive.readonly would mean a Google verification review for a sensitive scope,
 * or living in "Testing" mode where refresh tokens die every 7 days — the exact
 * reconnect problem the Finance Tracker already had to fix once.
 *
 * So this script does the reading. It runs on the PC that already has the Drive
 * folder synced, parses the raw exports with the same engine.js the app uses,
 * and writes ONE compact health-data.json into the app's own Drive folder. The
 * app picks it up on next launch with no scope change and no verification.
 *
 * SETUP (once)
 *   1. Open the app on the desktop and connect Google Drive. That creates
 *      "Health Tracker Data/health-data.json" under this same OAuth client,
 *      which is what makes it visible to this script.
 *   2. Grab the session id: in the app's browser console run
 *        (await indexedDB.databases()) && await new Promise(r=>{const q=indexedDB.open('ht-kv');q.onsuccess=()=>{const t=q.result.transaction('kv').objectStore('kv').get('driveSession');t.onsuccess=()=>r(t.result)}})
 *      or read it off the "setup code" shown on the Worker's connected page.
 *   3. node tools/sync-to-drive.mjs --session <that-id>
 *      It is saved to .drive-session (gitignored) and reused from then on.
 *
 * USAGE
 *   node tools/sync-to-drive.mjs              # incremental: only new/changed days
 *   node tools/sync-to-drive.mjs --full       # reparse every export file
 *   node tools/sync-to-drive.mjs --dry-run    # parse and diff, upload nothing
 *   node tools/sync-to-drive.mjs --session ID # store the session id and exit
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'engine.js'));

const WORKER_BASE = 'https://claude-proxy.raffy-tanpho.workers.dev';
const DATA_FOLDER = 'Health Tracker Data';
const DATA_FILE = 'health-data.json';
const SESSION_PATH = path.join(ROOT, '.drive-session');
const STATE_PATH = path.join(ROOT, '.sync-state.json');
const DEFAULT_SRC = 'C:/Users/raffy/Google Drive/0 AI Workspace/03 Health Tracker Assistant/01 Data Inbox/Health Auto Export';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : d; };
const has = k => args.includes(k);
const SRC = opt('--src', DEFAULT_SRC);
const FULL = has('--full');
const DRY = has('--dry-run');

/* Timestamps are LOCAL with an explicit offset, not UTC.
 *
 * This used to log UTC, which on this machine reads 8 hours behind every other
 * timestamp you would compare it against -- file mtimes, Task Scheduler's
 * LastRunTime, the Drive file's modifiedTime. A log that disagrees with the
 * clock by a working day is worse than no log when you are trying to work out
 * whether an unattended run actually happened. */
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

/* Every run also appends to sync.log (gitignored). The scheduled task runs with
 * nobody watching and its stdout goes nowhere, so without this the only evidence
 * a run left behind is an exit code -- and an exit code cannot distinguish "there
 * was nothing to do" from "it did nothing". */
const LOG_PATH = path.join(ROOT, 'sync.log');
function writeLog(line) {
  try {
    // Trim at ~256 KB so an unattended daily task cannot grow this without bound.
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 262144) {
      const keep = fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-800).join('\n');
      fs.writeFileSync(LOG_PATH, keep, 'utf8');
    }
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch (e) { /* logging must never be the thing that breaks the sync */ }
}

const log = (...a) => { const line = stamp() + ' ' + a.join(' '); console.log(line); writeLog(line); };
function die(msg, code = 1) {
  const line = 'ERROR: ' + msg;
  console.error(line); writeLog(stamp() + ' ' + line);
  process.exit(code);
}

/* ── session bootstrap ─────────────────────────────────────────────────── */
const sessionArg = opt('--session', null);
if (sessionArg) {
  fs.writeFileSync(SESSION_PATH, sessionArg.trim(), 'utf8');
  log('Session id saved to', SESSION_PATH);
  process.exit(0);
}
if (!fs.existsSync(SESSION_PATH)) {
  // Passing the id as a bare argument is the easy mistake, and the generic
  // "no session id" message gives no hint that the flag is what is missing.
  const bare = args.find(a => !a.startsWith('--') && /^[0-9a-fA-F-]{16,}$/.test(a));
  if (bare) {
    die('That looks like a session id, but it needs the --session flag:\n' +
        '         node tools/sync-to-drive.mjs --session ' + bare.slice(0, 8) + '...\n' +
        '       Nothing was saved.');
  }
  die('No session id. Run:  node tools/sync-to-drive.mjs --session <id>\n' +
      '       See the SETUP block at the top of this file for where to get one.');
}
const SESSION = fs.readFileSync(SESSION_PATH, 'utf8').trim();

/* ── parse the local export folder ─────────────────────────────────────── */
const dailyDir = path.join(SRC, 'Daily Backup');
const woDir = path.join(SRC, 'Workout Backup');
if (!fs.existsSync(dailyDir)) die('Daily Backup folder not found at ' + dailyDir);

// Incremental by file mtime: reparsing 3,600 files every night is pointless when
// only a handful changed. --full forces everything.
let state = { lastRun: 0, seen: {} };
if (!FULL && fs.existsSync(STATE_PATH)) {
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { log('state file unreadable, doing a full pass'); }
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json'))
    .map(f => { const p = path.join(dir, f); return { f, p, mtime: fs.statSync(p).mtimeMs }; });
}

const dailyFiles = listJson(dailyDir);
const woFiles = listJson(woDir);
const changedDaily = dailyFiles.filter(x => FULL || (state.seen[x.f] || 0) < x.mtime);
const changedWo = woFiles.filter(x => FULL || (state.seen[x.f] || 0) < x.mtime);

log(`Export folder: ${dailyFiles.length} daily files (${changedDaily.length} new/changed), ` +
    `${woFiles.length} workout files (${changedWo.length} new/changed)`);

if (!changedDaily.length && !changedWo.length && !FULL) {
  log('Nothing changed since the last run. Exiting without touching Drive.');
  process.exit(0);
}

const rows = {};
let parseErrors = 0;
for (const x of changedDaily) {
  // dateFromDailyName also rejects files that are not daily exports at all,
  // and correctly handles the " (1)" duplicates the iPhone app re-drops.
  const d = E.dateFromDailyName(x.f);
  if (!d) continue;
  try {
    const j = JSON.parse(fs.readFileSync(x.p, 'utf8'));
    // srcMtime becomes the row's `u`, which is what makes newer-wins merging
    // work on both sides of the sync.
    const row = E.parseDaily(j, d, Math.floor(x.mtime));
    rows[d] = E.mergeDailyRows(rows[d], row);
  } catch (e) { parseErrors++; log('  skip', x.f, '-', e.message); }
}
const workouts = [];
for (const x of changedWo) {
  try { workouts.push(...E.parseWorkoutFile(JSON.parse(fs.readFileSync(x.p, 'utf8')))); }
  catch (e) { parseErrors++; log('  skip', x.f, '-', e.message); }
}
E.flagWeightJumps(rows);

const dates = Object.keys(rows).sort();
log(`Parsed ${dates.length} day rows` + (dates.length ? ` (${dates[0]} to ${dates[dates.length - 1]})` : '') +
    `, ${workouts.length} workouts` + (parseErrors ? `, ${parseErrors} files skipped` : ''));

if (!dates.length && !workouts.length) { log('Nothing parsed. Exiting.'); process.exit(0); }

/* ── Drive ─────────────────────────────────────────────────────────────── */
// The hardened Worker (2026-08 proxy lockdown) rejects POSTs whose Origin is
// absent or not allowlisted, which is right for a browser but blocks this script
// outright -- Node sends no Origin header, so /drive/token answered 403 and the
// nightly sync could never authenticate. Declaring the app's own origin is
// consistent with how that check is meant to work: the Worker's own notes say a
// non-browser client can set this header anyway, so the allowlist exists to stop
// drive-by browser abuse, with the rate limit as the real backstop. This is a
// first-party client of that same app, not a way around the control.
const APP_ORIGIN = 'https://raffytanpho-debug.github.io';

async function accessToken() {
  const r = await fetch(WORKER_BASE + '/drive/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': APP_ORIGIN },
    body: JSON.stringify({ session_id: SESSION })
  });
  if (!r.ok) {
    const body = await r.text();
    if (r.status === 403) die('The Worker rejected this client (' + body.slice(0, 120) + ').\n' +
      '       Its origin allowlist must include ' + APP_ORIGIN + '.');
    if (r.status === 401) die('Drive session rejected (' + body.slice(0, 120) + ').\n' +
      '       Reconnect Drive in the app, then re-run with --session <new id>.');
    die('Token request failed: ' + r.status + ' ' + body.slice(0, 200));
  }
  const j = await r.json();
  if (!j.access_token) die('Worker returned no access token');
  return j.access_token;
}
function hdr(tok, extra) { return Object.assign({ Authorization: 'Bearer ' + tok }, extra || {}); }
async function dj(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('Drive ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function findFolder(tok, name, parent) {
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : ''));
  const j = await dj(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`, { headers: hdr(tok) });
  if (j.files && j.files.length) return j.files[0].id;
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parent) meta.parents = [parent];
  const c = await dj('https://www.googleapis.com/drive/v3/files?fields=id',
    { method: 'POST', headers: hdr(tok, { 'Content-Type': 'application/json' }), body: JSON.stringify(meta) });
  return c.id;
}

async function findDataFile(tok) {
  const q = encodeURIComponent(`name='${DATA_FILE}' and trashed=false`);
  const j = await dj(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`, { headers: hdr(tok) });
  return j.files && j.files.length ? j.files[0].id : null;
}

async function main() {
  if (DRY) {
    log('DRY RUN — nothing will be uploaded.');
    log('Would merge', dates.length, 'day rows and', workouts.length, 'workouts into Drive.');
    if (dates.length) log('Sample row:', JSON.stringify(rows[dates[dates.length - 1]]).slice(0, 200));
    return;
  }

  const tok = await accessToken();
  let fileId = await findDataFile(tok);

  // Start from whatever is already in Drive so a day the phone logged and this
  // machine has never seen is not thrown away.
  let remote = { version: 1, settings: { units: { weight: 'lb', distance: 'mi', temp: 'F' }, updatedAt: 0 }, daily: {}, workouts: [], meals: [], sync: {}, meta: {} };
  if (fileId) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: hdr(tok) });
    if (r.ok) {
      try { remote = await r.json(); } catch (e) { log('WARNING: remote file was not valid JSON; starting from a fresh object'); }
    } else { log('WARNING: could not read the remote file (' + r.status + '); starting from a fresh object'); }
  } else {
    log('No health-data.json in Drive yet — creating it.');
  }
  if (!remote.daily) remote.daily = {};
  if (!Array.isArray(remote.workouts)) remote.workouts = [];

  const beforeDays = Object.keys(remote.daily).length, beforeWo = remote.workouts.length;
  let added = 0, updated = 0;
  for (const d of dates) {
    const cur = remote.daily[d];
    if (!cur) { remote.daily[d] = rows[d]; added++; }
    else { const m = E.mergeDailyRows(cur, rows[d]); remote.daily[d] = m; updated++; }
  }
  const seen = new Set(remote.workouts.map(w => w.id));
  let woAdded = 0;
  for (const w of workouts) if (w && w.id && !seen.has(w.id)) { remote.workouts.push(w); seen.add(w.id); woAdded++; }
  remote.meta = Object.assign({}, remote.meta, {
    lastSyncScript: new Date().toISOString(), engine: E.VERSION, sourceFiles: dailyFiles.length
  });

  const payload = JSON.stringify(remote);
  const kb = Math.round(payload.length / 1024);

  if (fileId) {
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      { method: 'PATCH', headers: hdr(tok, { 'Content-Type': 'application/json' }), body: payload });
    if (!r.ok) die('Upload failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  } else {
    const folderId = await findFolder(tok, DATA_FOLDER, null);
    const boundary = 'ht' + Date.now();
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: DATA_FILE, parents: [folderId] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + payload + `\r\n--${boundary}--`;
    const c = await dj('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: hdr(tok, { 'Content-Type': `multipart/related; boundary=${boundary}` }), body });
    fileId = c.id;
  }

  // Only record the files as seen AFTER a successful upload, so a failed run
  // retries the same files next time instead of skipping them forever.
  for (const x of [...changedDaily, ...changedWo]) state.seen[x.f] = x.mtime;
  state.lastRun = Date.now();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state), 'utf8');

  const afterDays = Object.keys(remote.daily).length;
  log(`Uploaded ${kb} KB. Days ${beforeDays} -> ${afterDays} (+${added} new, ${updated} refreshed). ` +
      `Workouts ${beforeWo} -> ${remote.workouts.length} (+${woAdded}).`);
  log('Done. Open the app and it will pick this up on next launch.');
}

main().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
