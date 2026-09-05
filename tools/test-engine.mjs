#!/usr/bin/env node
/* test-engine.mjs — engine self-tests + positive control against the Python pipeline.
 *
 *   node tools/test-engine.mjs            # self-tests only
 *   node tools/test-engine.mjs --compare  # + diff fixture/health-data.json vs the Python daily_summary.csv
 *
 * The comparison is the "positive control" (02_RULES §2): the JS port must reproduce
 * the numbers the reviewed Python scripts produced from the same raw files, on every
 * date that has a single source file (dates with a " (1)" re-export are excluded
 * because the JS engine deliberately merges them while Python skipped them).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E = require(path.join(__dirname, '..', 'engine.js'));

let fails = 0, passes = 0;
function check(name, cond, detail) { if (cond) { passes++; console.log('  PASS', name); } else { fails++; console.log('  FAIL', name, detail || ''); } }

console.log('== readiness self-tests (ported from readiness.py --selftest) ==');
{
  // Case 1: RHR +6 & HRV -25% -> override forces Compromised at a mid score
  const r = { d: 'T', slp: 7.3, rhr: 61, hrv: 33.75, resp: 15, spo2: 97 };
  const b = { slp_base: 7.3, rhr_base: 55, hrv_base: 45, resp_base: 15 };
  const out = E.computeReadiness(r, b, null);
  check('override fires -> Compromised', out && out.state === 'Compromised' && out.override === true, JSON.stringify(out));
  check('mid score retained (40..85)', out && out.score >= 40 && out.score <= 85, out && out.score);
  // Case 2 (D1): partial day, HRV missing, RHR +6 & resp +1.5 -> Compromised, blank score, caveat
  const r2 = { d: 'T2', slp: 7.3, rhr: 61, resp: 16.5, spo2: 97 };
  const b2 = { slp_base: 7.3, rhr_base: 55, resp_base: 15 };
  const o2 = E.computeReadiness(r2, b2, null);
  check('partial-data override -> Compromised', o2 && o2.state === 'Compromised' && o2.override, JSON.stringify(o2));
  check('partial-data score is null', o2 && o2.score === null);
  check('partial-data caveat present', o2 && /partial data/.test(o2.explanation));
  // Case 3: one condition only, core signal missing -> unscored (null)
  const o3 = E.computeReadiness({ d: 'T3', slp: 7.3, rhr: 61, resp: 15 }, { slp_base: 7.3, rhr_base: 55, resp_base: 15 }, null);
  check('single condition + missing core -> unscored', o3 === null, JSON.stringify(o3));
  // Case 4: boundary — RHR exactly +5 and sleep exactly -60min fire; +4/-59 do not
  const ob = E.computeReadiness({ d: 'T4', slp: 6.3, rhr: 60, hrv: 45, resp: 15 }, { slp_base: 7.3, rhr_base: 55, hrv_base: 45, resp_base: 15 }, null);
  check('boundary RHR+5 & sleep-60 trip override', ob && ob.override && ob.conds.length === 2, JSON.stringify(ob && ob.conds));
  const ob2 = E.computeReadiness({ d: 'T5', slp: 6.32, rhr: 59, hrv: 45, resp: 15 }, { slp_base: 7.3, rhr_base: 55, hrv_base: 45, resp_base: 15 }, null);
  check('just-below boundary does not trip', ob2 && !ob2.override, JSON.stringify(ob2 && ob2.conds));
  // Case 5: high score, healthy day
  const og = E.computeReadiness({ d: 'T6', slp: 7.5, rhr: 54, hrv: 55, resp: 14 }, { slp_base: 7.3, rhr_base: 55, hrv_base: 50, resp_base: 14.5 }, null);
  check('healthy day -> Ready 100', og && og.state === 'Ready' && og.score === 100, JSON.stringify(og));
}

console.log('== baseline window ==');
{
  // 60 days of RHR 55 then the last 7 days at 70: baseline for the last day must ignore the 70s.
  const rows = {}; const start = '2026-01-01';
  for (let k = 0; k < 60; k++) { const d = E.util.addDays(start, k); rows[d] = { d, rhr: k >= 53 ? 70 : 55, hrv: 50, slp: 7, resp: 14, q: '' }; }
  const last = E.util.addDays(start, 59);
  const b = E.computeBaselines(rows, [last])[last];
  check('7-day exclusion: baseline stays 55', b.rhr_base === 55, JSON.stringify(b));
  check('window n = 28', b.rhr_n === 28, b.rhr_n);
  // excluded (partial) days don't count
  for (let k = 20; k < 45; k++) rows[E.util.addDays(start, k)].q = 'partial:hrv';
  const b2 = E.computeBaselines(rows, [last])[last];
  check('partial days excluded -> too thin -> no baseline', b2.rhr_base === undefined, JSON.stringify(b2));
}

console.log('== parser ==');
{
  const doc = { data: { metrics: [
    { name: 'resting_heart_rate', units: 'count/min', data: [{ qty: 58, source: 'Raffy\u2019s Apple\u00a0Watch', date: '2026-09-01 00:00:00 +0800' }] },
    { name: 'heart_rate', units: 'count/min', data: [{ Min: 50, Avg: 70, Max: 150, date: '2026-09-01 00:00:00 +0800', source: 'Watch' }] },
    { name: 'heart_rate_variability', units: 'ms', data: [{ qty: 40 }, { qty: 60 }, { qty: 50 }] },
    { name: 'sleep_analysis', units: 'hr', data: [{ core: 4, deep: 1, rem: 1.5, awake: 0.5, inBed: 0, asleep: 0, sleepStart: '2026-08-31 23:10:00 +0800', sleepEnd: '2026-09-01 06:40:00 +0800', source: 'Raffy\u00e2\u20ac\u2122s Apple\u00c2\u00a0Watch' }] },
    { name: 'step_count', units: 'count', data: [{ qty: 1000 }, { qty: 2500.4 }] },
    { name: 'walking_running_distance', units: 'mi', data: [{ qty: 1 }, { qty: 1 }] },
    { name: 'weight_body_mass', units: 'lb', data: [{ qty: 170, source: 'Zepp Life' }, { qty: 999, source: 'Health' }] },
    { name: 'apple_sleeping_wrist_temperature', units: 'degF', data: [{ qty: 96.8 }] },
    { name: 'respiratory_rate', units: 'count/min', data: [{ qty: 13.9 }, { qty: 14.3 }, { qty: 15 }] },
  ] } };
  const r = E.parseDaily(doc, '2026-09-01', 123);
  check('rhr mean', r.rhr === 58);
  check('hrv median', r.hrv === 50);
  check('hr min/avg/max', r.hrmin === 50 && r.hravg === 70 && r.hrmax === 150);
  check('sleep total = core+deep+rem', r.slp === 6.5 && r.sst === '23:10' && r.sen === '06:40');
  check('bedtime before midnight negative', r.bed === -50 && r.wake === 400, r.bed + '/' + r.wake);
  check('steps summed & rounded', r.steps === 3500);
  check('distance mi -> km', r.dist === 3.22, r.dist);
  check('weight prefers Zepp, lb -> kg', r.wt === 77.11, r.wt);
  check('wrist temp F -> C', r.wtemp === 36, r.wtemp);
  check('resp median 1dp', r.resp === 14.3);
  check('flags: none (has sleep/hrv/rhr)', r.q === '', r.q);
  const r2 = E.parseDaily({ data: { metrics: [{ name: 'step_count', units: 'count', data: [{ qty: 10 }] }] } }, '2015-01-01', 1);
  check('steps-only day -> watch_off', r2.q === 'watch_off', r2.q);
  check('dateFromDailyName handles (1)', E.dateFromDailyName('HealthAutoExport-2026-09-03 (1).json') === '2026-09-03' && E.dateFromDailyName('foo.json') === null);
  // merge: later export wins, earlier fills gaps
  const a = { d: 'x', rhr: 50, steps: 100, u: 1, nhr: 5, q: '' }, b = { d: 'x', steps: 900, u: 2, nhr: 1, q: '' };
  const m = E.mergeDailyRows(a, b);
  check('merge keeps later steps and earlier rhr', m.steps === 900 && m.rhr === 50 && m.nhr === 5, JSON.stringify(m));
}

console.log('== workout parser ==');
{
  const w = { id: 'A', name: 'Outdoor Run', start: '2026-09-02 06:40:41 +0800', end: '2026-09-02 07:08:24 +0800', duration: 1663.2,
    distance: { qty: 3.1, units: 'mi' }, activeEnergyBurned: { qty: 312.4, units: 'kcal' }, heartRate: { avg: { qty: 150.2 }, max: { qty: 175 }, min: { qty: 90 } },
    avgSpeed: { qty: 6.7, units: 'mi/hr' }, isIndoor: false, stepCadence: { qty: 168.4 },
    heartRateData: [{ Avg: 100, date: '2026-09-02 06:41:00 +0800' }, { Avg: 150, date: '2026-09-02 06:42:00 +0800' }, { Avg: 160, date: '2026-09-02 06:43:00 +0800' }, { Avg: 170, date: '2026-09-02 06:44:00 +0800' }] };
  const o = E.parseWorkout(w);
  check('workout basics', o.dur === 1663 && o.kcal === 312 && o.hravg === 150 && o.hrmax === 175 && o.indoor === false && o.cad === 168, JSON.stringify(o));
  check('distance mi->km', o.dist === 4.989, o.dist);
  check('pace min/km', Math.abs(E.paceMinKm(o) - 5.556) < 0.01, E.paceMinKm(o));
  const z = E.hrZones(o.hrh, 190);
  check('hr histogram -> zones sums to ~4 min', z && z.reduce((a, b) => a + b, 0) === 4, JSON.stringify(z));
  check('family detection', E.workoutFamily('Traditional Strength Training') === 'strength' && E.workoutFamily('Indoor Run') === 'run' && E.workoutFamily('High Intensity Interval Training') === 'hiit');
}

if (process.argv.includes('--compare')) {
  console.log('== positive control: JS seed vs Python daily_summary.csv ==');
  const seedPath = path.join(__dirname, '..', 'fixture', 'health-data.json');
  const pyPath = process.argv[process.argv.indexOf('--compare') + 1] && !process.argv[process.argv.indexOf('--compare') + 1].startsWith('--')
    ? process.argv[process.argv.indexOf('--compare') + 1]
    : 'C:/Users/raffy/Google Drive/0 AI Workspace/03 Health Tracker Assistant/daily_summary_readiness.csv';
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const csv = fs.readFileSync(pyPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const hdr = csv[0].split(',');
  const py = {};
  for (const line of csv.slice(1)) {
    // the python CSV quotes the explanation field; split respecting quotes
    const cells = []; let cur = '', inq = false;
    for (const ch of line) { if (ch === '"') inq = !inq; else if (ch === ',' && !inq) { cells.push(cur); cur = ''; } else cur += ch; }
    cells.push(cur);
    const o = {}; hdr.forEach((h, i) => o[h] = cells[i]); py[o.date] = o;
  }
  // dates that have a duplicate " (1)" export are excluded (JS merges, Python skipped)
  const dupDates = new Set(Object.keys(seed.sync.files).filter(n => / \(\d+\)\.json$/.test(n)).map(n => E.dateFromDailyName(n)).filter(Boolean));
  const pairs = [ // [js key, py col, tolerance, transform]
    ['rhr', 'resting_hr', 0.5], ['hrv', 'hrv_sdnn_ms', 0.5], ['slp', 'sleep_total_hr', 0.011], ['resp', 'resp_rate', 0.051], ['spo2', 'spo2_pct', 0.5],
    ['steps', 'steps', 0.5], ['akcal', 'active_kcal', 0.5], ['exmin', 'exercise_min', 0.5], ['vo2', 'vo2_max', 0.011],
    ['wt', 'weight_lb', 0.06, v => v / E.util.LB_KG], ['dist', 'distance_mi', 0.011, v => v / E.util.MI_KM], ['bmi', 'bmi', 0.051], ['bf', 'body_fat_pct', 0.051]
  ];
  const stats = {}; let compared = 0, worst = [];
  for (const d in py) {
    if (dupDates.has(d)) continue;
    const j = seed.daily[d]; const p = py[d]; if (!j) { worst.push([d, 'missing in JS']); continue; }
    compared++;
    for (const [jk, pk, tol, tf] of pairs) {
      const pv = p[pk] === '' || p[pk] == null ? null : parseFloat(p[pk]);
      let jv = j[jk] == null ? null : (tf ? tf(j[jk]) : j[jk]);
      const s = stats[jk] = stats[jk] || { n: 0, ok: 0, nullMismatch: 0, maxDiff: 0 };
      if (pv == null && jv == null) continue;
      s.n++;
      if (pv == null || jv == null) { s.nullMismatch++; if (worst.length < 40) worst.push([d, jk, 'null mismatch', pv, jv]); continue; }
      const diff = Math.abs(pv - jv);
      if (diff <= tol) s.ok++; else { s.maxDiff = Math.max(s.maxDiff, diff); if (worst.length < 40) worst.push([d, jk, 'diff', pv, +jv.toFixed(3)]); }
    }
    // readiness state parity
    const st = stats.readiness = stats.readiness || { n: 0, ok: 0, nullMismatch: 0, maxDiff: 0 };
    const pyState = p.readiness_state || null;
    if (pyState) { st.n++; }
  }
  console.log(`  compared ${compared} single-source dates (${dupDates.size} duplicate dates excluded)`);
  for (const k in stats) { const s = stats[k]; if (k === 'readiness') continue; console.log(`  ${k.padEnd(6)} n=${String(s.n).padStart(5)} within-tol=${String(s.ok).padStart(5)} null-mismatch=${s.nullMismatch} maxDiff=${s.maxDiff.toFixed(3)}`); }
  for (const w of worst.slice(0, 25)) console.log('   ', w.join(' | '));
  // readiness parity check on the derived table
  const der = E.deriveAll(seed.daily);
  let rn = 0, rok = 0, sok = 0, rmiss = [];
  for (const d in py) { if (dupDates.has(d)) continue; const p = py[d]; if (!p.readiness_state) continue; rn++; const j = der.readiness[d];
    if (j && j.state === p.readiness_state) { rok++; if (p.readiness_score === '' ? j.score === null : Math.abs(parseInt(p.readiness_score, 10) - j.score) <= 1) sok++; else if (rmiss.length < 10) rmiss.push([d, 'score', p.readiness_score, j.score]); }
    else if (rmiss.length < 10) rmiss.push([d, 'state', p.readiness_state, j && j.state]); }
  console.log(`  readiness: ${rn} python-scored days, state match ${rok}, score match ${sok}`);
  for (const m of rmiss) console.log('   ', m.join(' | '));
  const total = Object.values(stats).filter((s, i) => Object.keys(stats)[i] !== 'readiness').reduce((a, s) => a + s.n, 0);
  const totalOk = Object.values(stats).filter((s, i) => Object.keys(stats)[i] !== 'readiness').reduce((a, s) => a + s.ok, 0);
  check('>= 99.5% of compared values within tolerance', total && totalOk / total >= 0.995, `${totalOk}/${total}`);
  check('>= 99% readiness state parity', rn && rok / rn >= 0.99, `${rok}/${rn}`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
