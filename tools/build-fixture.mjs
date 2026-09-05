#!/usr/bin/env node
/* build-fixture.mjs — run the engine over the LOCAL (Drive-synced) Health Auto Export
 * folder and write a seed file in the app's storage format.
 *
 * Usage:
 *   node tools/build-fixture.mjs [--src "<path to Health Auto Export folder>"] [--out fixture/health-data.json] [--csv]
 *
 * Default source: <Drive>/0 AI Workspace/03 Health Tracker Assistant/01 Data Inbox/Health Auto Export
 * The seed can be imported into the app via Settings -> Import backup (desktop or phone).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E = require(path.join(__dirname, '..', 'engine.js'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : d; };
const DEFAULT_SRC = 'C:/Users/raffy/Google Drive/0 AI Workspace/03 Health Tracker Assistant/01 Data Inbox/Health Auto Export';
const SRC = opt('--src', DEFAULT_SRC);
const OUT = opt('--out', path.join(__dirname, '..', 'fixture', 'health-data.json'));
const WANT_CSV = args.includes('--csv');
const NO_WORKOUTS = args.includes('--no-workouts');

const dailyDir = path.join(SRC, 'Daily Backup');
const woDir = path.join(SRC, 'Workout Backup');
if (!fs.existsSync(dailyDir)) { console.error('Daily Backup folder not found at', dailyDir); process.exit(1); }

const t0 = Date.now();
const daily = {}, files = {}, errors = [];
const names = fs.readdirSync(dailyDir).filter(n => E.dateFromDailyName(n)).sort();
let parsed = 0;
for (const n of names) {
  const p = path.join(dailyDir, n);
  const st = fs.statSync(p);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { errors.push([n, 'json: ' + e.message.slice(0, 60)]); files[n] = { size: st.size, mtime: Math.floor(st.mtimeMs), bad: true }; continue; }
  const d = E.dateFromDailyName(n);
  const row = E.parseDaily(doc, d, Math.floor(st.mtimeMs));
  daily[d] = E.mergeDailyRows(daily[d], row);
  files[n] = { size: st.size, mtime: Math.floor(st.mtimeMs) };
  parsed++;
  if (parsed % 500 === 0) console.log(`  ...${parsed}/${names.length} daily files`);
}
E.flagWeightJumps(daily);
console.log(`Daily: ${parsed} files -> ${Object.keys(daily).length} days in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${errors.length} unreadable`);
for (const e of errors.slice(0, 5)) console.log('   skip', e[0], e[1]);

const workouts = [];
if (!NO_WORKOUTS && fs.existsSync(woDir)) {
  const seen = new Set();
  const wn = fs.readdirSync(woDir).filter(n => E.isWorkoutName(n)).sort();
  let wp = 0;
  for (const n of wn) {
    const p = path.join(woDir, n);
    const st = fs.statSync(p);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { errors.push([n, 'json: ' + e.message.slice(0, 60)]); files[n] = { size: st.size, mtime: Math.floor(st.mtimeMs), bad: true }; continue; }
    for (const w of E.parseWorkoutFile(doc)) { if (!seen.has(w.id)) { seen.add(w.id); workouts.push(w); } }
    files[n] = { size: st.size, mtime: Math.floor(st.mtimeMs) };
    wp++;
  }
  workouts.sort((a, b) => a.start < b.start ? -1 : 1);
  console.log(`Workouts: ${wp} files -> ${workouts.length} unique workouts`);
}

const seed = {
  version: 1,
  settings: { units: { weight: 'lb', distance: 'mi', temp: 'F' }, maxHr: null, updatedAt: Date.now() },
  daily, workouts, meals: [],
  sync: { files, lastLocalImport: Date.now(), source: 'local-folder' },
  meta: { generated: new Date().toISOString(), engine: E.VERSION, note: 'Seed built by tools/build-fixture.mjs from the local Health Auto Export folder.' }
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(seed));
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`Wrote ${OUT} (${kb} KB)`);

// coverage summary (mirrors the Python run summary)
const dates = Object.keys(daily).sort();
const present = k => dates.filter(d => daily[d][k] != null).length;
const flag = s => dates.filter(d => (daily[d].q || '').includes(s)).length;
console.log(`Date range ${dates[0]} -> ${dates[dates.length - 1]}`);
for (const k of ['rhr', 'hrv', 'slp', 'resp', 'spo2', 'steps', 'wt', 'vo2', 'wtemp']) console.log(`   ${k.padEnd(8)} ${String(present(k)).padStart(5)} / ${dates.length}`);
console.log(`   watch_off ${flag('watch_off')}  partial ${flag('partial')}  outlier:rhr ${flag('outlier:rhr')}  outlier:sleep ${flag('outlier:sleep')}  weight_jump ${flag('outlier:weight_jump')}`);

const der = E.deriveAll(daily);
const st = { Ready: 0, Steady: 0, Compromised: 0 }; let ov = 0;
for (const d in der.readiness) { st[der.readiness[d].state]++; if (der.readiness[d].override) ov++; }
console.log(`Readiness: scored ${Object.keys(der.readiness).length} days — Ready ${st.Ready} / Steady ${st.Steady} / Compromised ${st.Compromised} (override ${ov})`);
const last = dates[dates.length - 1];
console.log('Latest day', last, JSON.stringify(daily[last]).slice(0, 300));
console.log('Latest readiness', JSON.stringify(der.readiness[last] || der.readiness[dates[dates.length - 2]] || null));

if (WANT_CSV) {
  const cols = ['d', 'rhr', 'hrv', 'whr', 'hrmin', 'hravg', 'hrmax', 'slp', 'sdeep', 'srem', 'score', 'sawake', 'sst', 'sen', 'steps', 'dist', 'akcal', 'bkcal', 'exmin', 'stand', 'spo2', 'resp', 'vo2', 'wt', 'bmi', 'bf', 'lean', 'wspeed', 'daylight', 'q'];
  const csv = [cols.join(',')].concat(dates.map(d => cols.map(c => daily[d][c] == null ? '' : daily[d][c]).join(','))).join('\n');
  const outCsv = OUT.replace(/\.json$/, '.csv');
  fs.writeFileSync(outCsv, csv);
  console.log('Wrote', outCsv);
}
