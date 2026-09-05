/* Health Tracker — data engine
 *
 * Pure functions, no DOM, no network. Runs in the browser (loaded by index.html)
 * and in Node (tools/*.mjs) so the exact same code that builds the dashboard can
 * be tested against the Python pipeline's output.
 *
 * Responsibilities
 *   1. Parse Health Auto Export files (daily metrics JSON + workout JSON) into
 *      compact per-day rows / per-workout summaries.
 *   2. Personal baselines: rolling 28-day median, excluding the most recent 7 days,
 *      MAD for spread (ported 1:1 from scripts/compute_baselines.py).
 *   3. Daily readiness score + hard override (ported 1:1 from scripts/readiness.py).
 *   4. Small stats helpers used by the views.
 *
 * Unit policy: rows are stored in canonical metric units (km, kg, °C, km/h).
 * The export's own units are read from each metric's `units` field and converted
 * at parse time, so a later change of units in the iPhone app can't corrupt history.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HTEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2026.09.04';

  // ───────────────────────── helpers ─────────────────────────
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const round = (v, d) => (v == null ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));
  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const sum = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);
  function median(xs) {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const mad = (xs, med) => median(xs.map(x => Math.abs(x - med)));
  const LB_KG = 0.45359237, MI_KM = 1.609344, FT_M = 0.3048, IN_CM = 2.54;

  function toKg(v, units) { return units === 'lb' ? v * LB_KG : units === 'st' ? v * 6.35029 : v; }
  function toKm(v, units) { return units === 'mi' ? v * MI_KM : units === 'm' ? v / 1000 : units === 'yd' ? v * 0.0009144 : units === 'ft' ? v * FT_M / 1000 : v; }
  function toKmh(v, units) { return units === 'mi/hr' ? v * MI_KM : units === 'm/s' ? v * 3.6 : units === 'ft/s' ? v * FT_M * 3.6 : v; }
  function toC(v, units) { return units === 'degF' ? (v - 32) * 5 / 9 : v; }
  function toCm(v, units) { return units === 'in' ? v * IN_CM : units === 'm' ? v * 100 : v; }

  // "2026-09-02 06:20:00 +0800" -> "2026-09-02" / "06:20" (local wall clock as exported)
  const dateOf = s => (typeof s === 'string' ? s.slice(0, 10) : null);
  const hhmm = s => (typeof s === 'string' && s.length >= 16 ? s.slice(11, 16) : null);
  // minutes since midnight, allowing bedtimes before midnight to be represented as negative
  function clockMin(s) { const t = hhmm(s); if (!t) return null; return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10); }

  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function dow(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); } // 0=Sun
  function weekStart(iso) { const w = dow(iso); return addDays(iso, -((w + 6) % 7)); } // Monday

  // source-name matching is tolerant to the mojibake in older exports ("Raffyâ€™s AppleÂ Watch")
  const srcHas = (p, needle) => ((p && p.source) || '').toLowerCase().indexOf(needle) !== -1;

  // ───────────────────────── daily export parser ─────────────────────────
  // qty list, optionally preferring points from a given source substring
  function qtys(pts, prefer) {
    const all = [], pref = [];
    for (const p of pts) {
      if (!isNum(p.qty)) continue;
      all.push(p.qty);
      if (prefer && srcHas(p, prefer)) pref.push(p.qty);
    }
    return prefer && pref.length ? pref : all;
  }
  function metricsByName(doc) {
    const out = {};
    const list = (doc && doc.data && Array.isArray(doc.data.metrics)) ? doc.data.metrics : [];
    for (const m of list) if (m && m.name) out[m.name] = m;
    return out;
  }
  const pts = (m, name) => (m[name] && Array.isArray(m[name].data)) ? m[name].data : [];
  const unitOf = (m, name) => (m[name] && m[name].units) || '';

  /**
   * Aggregate one Health Auto Export daily file into a compact row.
   * Works for both file styles: minute-level samples (many points/metric) and
   * daily aggregates (one point/metric) — sums/means/medians reduce identically.
   * Mirrors scripts/build_daily_summary.py aggregate_day() decisions:
   *   sleep total = core + deep + rem (asleep/inBed unreliable), HRV median (SDNN),
   *   watch metrics prefer the Apple Watch source, body comp prefers the Zepp scale,
   *   flags: watch_off / partial:<missing> / outlier:rhr / outlier:sleep.
   */
  function parseDaily(doc, date, srcMtime) {
    const m = metricsByName(doc);
    const r = { d: date };
    const set = (k, v, dec) => { if (v != null && Number.isFinite(v)) r[k] = dec == null ? v : round(v, dec); };

    set('rhr', mean(qtys(pts(m, 'resting_heart_rate'), 'watch')), 0);
    set('hrv', median(qtys(pts(m, 'heart_rate_variability'), 'watch')), 0);
    set('whr', mean(qtys(pts(m, 'walking_heart_rate_average'), 'watch')), 0);
    const hrPts = pts(m, 'heart_rate');
    const mins = [], avgs = [], maxs = [];
    for (const p of hrPts) { if (isNum(p.Min)) mins.push(p.Min); if (isNum(p.Avg)) avgs.push(p.Avg); if (isNum(p.Max)) maxs.push(p.Max); }
    if (mins.length) set('hrmin', Math.min.apply(null, mins), 0);
    set('hravg', mean(avgs), 0);
    if (maxs.length) set('hrmax', Math.max.apply(null, maxs), 0);
    r.nhr = hrPts.length;

    // sleep: prefer the Watch record, else the first one
    const sp = pts(m, 'sleep_analysis');
    if (sp.length) {
      const s = sp.find(p => srcHas(p, 'watch')) || sp[0];
      const core = isNum(s.core) ? s.core : 0, deep = isNum(s.deep) ? s.deep : 0, rem = isNum(s.rem) ? s.rem : 0;
      const total = core + deep + rem;
      if (total > 0) {
        set('slp', total, 2); set('score', core, 2); set('sdeep', deep, 2); set('srem', rem, 2);
        if (isNum(s.awake)) set('sawake', s.awake, 2);
        if (isNum(s.inBed) && s.inBed > 0) set('sinbed', s.inBed, 2);
        const st = hhmm(s.sleepStart), en = hhmm(s.sleepEnd);
        if (st) r.sst = st; if (en) r.sen = en;
        // bedtime as minutes relative to midnight of the wake day (negative = before midnight)
        if (s.sleepStart && s.sleepEnd) {
          const sd = dateOf(s.sleepStart), ed = dateOf(s.sleepEnd);
          const off = daysBetween(sd, ed);
          const bm = clockMin(s.sleepStart) - off * 1440, wm = clockMin(s.sleepEnd);
          if (Number.isFinite(bm)) r.bed = bm; if (Number.isFinite(wm)) r.wake = wm;
        }
      }
    }

    set('steps', sum(qtys(pts(m, 'step_count'))), 0);
    const dist = sum(qtys(pts(m, 'walking_running_distance')));
    set('dist', dist == null ? null : toKm(dist, unitOf(m, 'walking_running_distance')), 2);
    set('akcal', sum(qtys(pts(m, 'active_energy'))), 0);
    set('bkcal', sum(qtys(pts(m, 'basal_energy_burned'))), 0);
    set('exmin', sum(qtys(pts(m, 'apple_exercise_time'))), 0);
    set('stand', sum(qtys(pts(m, 'apple_stand_hour'))), 0);
    set('standmin', sum(qtys(pts(m, 'apple_stand_time'))), 0);
    set('flights', sum(qtys(pts(m, 'flights_climbed'))), 0);
    set('spo2', median(qtys(pts(m, 'blood_oxygen_saturation'), 'watch')), 0);
    set('resp', median(qtys(pts(m, 'respiratory_rate'), 'watch')), 1);
    set('vo2', mean(qtys(pts(m, 'vo2_max'))), 2);
    set('daylight', sum(qtys(pts(m, 'time_in_daylight'))), 0);
    const ws = median(qtys(pts(m, 'walking_speed')));
    set('wspeed', ws == null ? null : toKmh(ws, unitOf(m, 'walking_speed')), 2);
    const wt = mean(qtys(pts(m, 'weight_body_mass'), 'zepp'));
    set('wt', wt == null ? null : toKg(wt, unitOf(m, 'weight_body_mass')), 2);
    set('bmi', mean(qtys(pts(m, 'body_mass_index'), 'zepp')), 1);
    set('bf', mean(qtys(pts(m, 'body_fat_percentage'), 'zepp')), 1);
    const lean = mean(qtys(pts(m, 'lean_body_mass'), 'zepp'));
    set('lean', lean == null ? null : toKg(lean, unitOf(m, 'lean_body_mass')), 2);
    const wtemp = mean(qtys(pts(m, 'apple_sleeping_wrist_temperature')));
    set('wtemp', wtemp == null ? null : toC(wtemp, unitOf(m, 'apple_sleeping_wrist_temperature')), 2);
    set('effort', mean(qtys(pts(m, 'physical_effort'))), 2);
    set('audio', mean(qtys(pts(m, 'environmental_audio_exposure'))), 0);
    set('recov', mean(qtys(pts(m, 'cardio_recovery'))), 0);
    set('sixmin', mean(qtys(pts(m, 'six_minute_walking_test_distance'))), 0);
    const cyc = sum(qtys(pts(m, 'cycling_distance')));
    set('cycle', cyc == null ? null : toKm(cyc, unitOf(m, 'cycling_distance')), 2);

    // data-quality flags (surfaced, never imputed)
    const flags = [];
    if (r.rhr == null && r.nhr < 10) flags.push('watch_off');
    const missing = [];
    if (r.slp == null) missing.push('sleep'); if (r.hrv == null) missing.push('hrv'); if (r.rhr == null) missing.push('rhr');
    if (missing.length && flags.indexOf('watch_off') === -1) flags.push('partial:' + missing.join('/'));
    if (r.rhr != null && (r.rhr < 30 || r.rhr > 120)) flags.push('outlier:rhr');
    if (r.slp != null && r.slp > 14) flags.push('outlier:sleep');
    r.q = flags.join(';');
    if (srcMtime) r.u = srcMtime;
    return r;
  }

  // Flag weight jumps > 5% vs the previous weigh-in across the whole ordered table.
  function flagWeightJumps(rows) {
    const dates = Object.keys(rows).sort();
    let prev = null;
    for (const d of dates) {
      const r = rows[d];
      let flags = (r.q || '').split(';').filter(x => x && x !== 'outlier:weight_jump');
      if (r.wt != null && prev != null && prev > 0 && Math.abs(r.wt - prev) / prev > 0.05) flags.push('outlier:weight_jump');
      if (r.wt != null) prev = r.wt;
      r.q = flags.join(';');
    }
  }

  // Merge two rows for the same date (e.g. "…09-03.json" and "…09-03 (1).json").
  // Later-exported file wins per field; earlier fills the gaps. Re-derives flags.
  function mergeDailyRows(a, b) {
    if (!a) return b; if (!b) return a;
    const [older, newer] = (a.u || 0) <= (b.u || 0) ? [a, b] : [b, a];
    const out = Object.assign({}, older, newer);
    // `nhr` should reflect the fuller export
    out.nhr = Math.max(older.nhr || 0, newer.nhr || 0);
    const flags = [];
    if (out.rhr == null && out.nhr < 10) flags.push('watch_off');
    const missing = [];
    if (out.slp == null) missing.push('sleep'); if (out.hrv == null) missing.push('hrv'); if (out.rhr == null) missing.push('rhr');
    if (missing.length && flags.indexOf('watch_off') === -1) flags.push('partial:' + missing.join('/'));
    if (out.rhr != null && (out.rhr < 30 || out.rhr > 120)) flags.push('outlier:rhr');
    if (out.slp != null && out.slp > 14) flags.push('outlier:sleep');
    out.q = flags.join(';');
    return out;
  }

  // "HealthAutoExport-2026-09-03 (1).json" -> "2026-09-03"; null if not an export file
  function dateFromDailyName(name) {
    const m = /^HealthAutoExport-(\d{4}-\d{2}-\d{2})(?: \(\d+\))?\.json$/i.exec(name || '');
    return m ? m[1] : null;
  }
  function isWorkoutName(name) { return /^WorkoutExport-\d{4}-\d{2}-\d{2}(?: \(\d+\))?\.json$/i.test(name || ''); }

  // ───────────────────────── workout parser ─────────────────────────
  const q = o => (o && isNum(o.qty)) ? o.qty : null;
  const HR_BIN0 = 40, HR_BINW = 5, HR_NBINS = 34; // 40..210 bpm

  /** Summarise one workout object from a WorkoutExport file. */
  function parseWorkout(w) {
    if (!w || !w.id || !w.start) return null;
    const o = { id: w.id, name: w.name || 'Workout', start: w.start.slice(0, 16), d: dateOf(w.start) };
    if (w.end) o.end = w.end.slice(0, 16);
    if (isNum(w.duration)) o.dur = Math.round(w.duration); // seconds
    else if (w.start && w.end) o.dur = Math.max(0, Math.round((Date.parse(w.end.replace(' ', 'T').replace(' +', '+')) - Date.parse(w.start.replace(' ', 'T').replace(' +', '+'))) / 1000));
    const dist = w.distance || w.walkingAndRunningDistance;
    if (dist && isNum(dist.qty)) o.dist = round(toKm(dist.qty, dist.units || 'mi'), 3);
    const ae = q(w.activeEnergyBurned); if (ae != null) o.kcal = Math.round(ae);
    const te = q(w.totalEnergy); if (te != null) o.tkcal = Math.round(te);
    if (w.heartRate) {
      if (q(w.heartRate.avg) != null) o.hravg = Math.round(w.heartRate.avg.qty);
      if (q(w.heartRate.max) != null) o.hrmax = Math.round(w.heartRate.max.qty);
      if (q(w.heartRate.min) != null) o.hrmin = Math.round(w.heartRate.min.qty);
    }
    if (o.hravg == null && q(w.avgHeartRate) != null) o.hravg = Math.round(w.avgHeartRate.qty);
    if (o.hrmax == null && q(w.maxHeartRate) != null) o.hrmax = Math.round(w.maxHeartRate.qty);
    if (q(w.avgSpeed) != null) o.spd = round(toKmh(w.avgSpeed.qty, w.avgSpeed.units || 'mi/hr'), 2);
    if (q(w.elevationUp) != null) o.elev = Math.round(w.elevationUp.units === 'ft' ? w.elevationUp.qty * FT_M : w.elevationUp.qty);
    if (q(w.intensity) != null) o.met = round(w.intensity.qty, 1);
    if (q(w.stepCadence) != null) o.cad = Math.round(w.stepCadence.qty);
    if (q(w.temperature) != null) o.temp = round(toC(w.temperature.qty, w.temperature.units), 0);
    if (q(w.humidity) != null) o.hum = Math.round(w.humidity.qty);
    if (typeof w.isIndoor === 'boolean') o.indoor = w.isIndoor;
    else if (w.location) o.indoor = /indoor/i.test(w.location);
    if (Array.isArray(w.stepCount)) { const s = sum(qtys(w.stepCount)); if (s != null) o.steps = Math.round(s); }
    // heart-rate histogram (minutes per 5-bpm bin) from the sample series, so HR
    // zones can be recomputed later for any max-HR setting without re-parsing.
    if (Array.isArray(w.heartRateData) && w.heartRateData.length > 1) {
      const hist = new Array(HR_NBINS).fill(0);
      const samples = w.heartRateData.filter(p => isNum(p.Avg) && p.date).map(p => ({ t: Date.parse(p.date.replace(' ', 'T').replace(' +', '+')), v: p.Avg })).filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
      let total = 0;
      for (let i = 0; i < samples.length; i++) {
        const next = i + 1 < samples.length ? samples[i + 1].t : samples[i].t + 60000;
        const mins = Math.min(5, Math.max(0, (next - samples[i].t) / 60000));
        const b = Math.max(0, Math.min(HR_NBINS - 1, Math.floor((samples[i].v - HR_BIN0) / HR_BINW)));
        hist[b] += mins; total += mins;
      }
      if (total > 0) o.hrh = hist.map(x => round(x, 1));
      // downsampled HR curve (<= 40 points) for a sparkline
      const N = 40;
      if (samples.length >= 4) {
        const step = samples.length / N, curve = [];
        for (let i = 0; i < Math.min(N, samples.length); i++) curve.push(Math.round(samples[Math.floor(i * step)].v));
        o.hrc = curve;
      }
    }
    if (Array.isArray(w.heartRateRecovery) && w.heartRateRecovery.length) {
      // recovery at ~1 min after the end, if present
      const endT = w.end ? Date.parse(w.end.replace(' ', 'T').replace(' +', '+')) : null;
      const rec = w.heartRateRecovery.filter(p => isNum(p.Avg) && p.date).map(p => ({ t: Date.parse(p.date.replace(' ', 'T').replace(' +', '+')), v: p.Avg }));
      if (endT && rec.length) {
        const at1 = rec.filter(p => p.t >= endT + 45000 && p.t <= endT + 90000);
        if (at1.length && o.hrmax != null) o.rec1 = Math.round(o.hrmax - mean(at1.map(p => p.v)));
      }
    }
    return o;
  }
  function parseWorkoutFile(doc) {
    const list = (doc && doc.data && Array.isArray(doc.data.workouts)) ? doc.data.workouts : [];
    return list.map(parseWorkout).filter(Boolean);
  }

  // HR zones from the histogram: 5 zones at 50/60/70/80/90% of maxHR (minutes each)
  function hrZones(hrh, maxHr) {
    if (!hrh || !maxHr) return null;
    const z = [0, 0, 0, 0, 0];
    const cuts = [0.5, 0.6, 0.7, 0.8, 0.9].map(f => f * maxHr);
    for (let i = 0; i < hrh.length; i++) {
      const bpm = HR_BIN0 + i * HR_BINW + HR_BINW / 2;
      if (bpm < cuts[0]) continue;
      let zi = 0; for (let k = 1; k < 5; k++) if (bpm >= cuts[k]) zi = k;
      z[zi] += hrh[i];
    }
    return z.map(x => round(x, 0));
  }

  // ───────────────────────── baselines ─────────────────────────
  const BASE_METRICS = ['slp', 'rhr', 'hrv', 'resp', 'akcal', 'wtemp', 'spo2'];
  const WINDOW_DAYS = 28, LAG_DAYS = 7, MIN_VALID = 10;
  const dayExcluded = r => { const f = r.q || ''; return f.indexOf('watch_off') !== -1 || f.indexOf('partial') !== -1; };

  /**
   * For every date in rows, compute {metric}_base / {metric}_mad over the window
   * [D-34 .. D-7] using only non-excluded days with >= MIN_VALID values.
   * Returns { date: { slp_base, slp_mad, ... } } (only keys that exist).
   */
  function computeBaselines(rows, dates) {
    dates = dates || Object.keys(rows).sort();
    const out = {};
    for (const D of dates) {
      const b = {};
      const vals = {}; for (const m of BASE_METRICS) vals[m] = [];
      for (let k = LAG_DAYS + WINDOW_DAYS - 1; k >= LAG_DAYS; k--) {
        const rr = rows[addDays(D, -k)];
        if (!rr || dayExcluded(rr)) continue;
        for (const m of BASE_METRICS) if (rr[m] != null) vals[m].push(rr[m]);
      }
      for (const m of BASE_METRICS) {
        const xs = vals[m];
        if (xs.length >= MIN_VALID) {
          const med = median(xs);
          const dec = (m === 'slp' || m === 'resp' || m === 'wtemp') ? 1 : 0;
          b[m + '_base'] = round(med, m === 'wtemp' ? 2 : dec);
          b[m + '_mad'] = round(mad(xs, med), m === 'wtemp' ? 2 : (dec || 1));
          b[m + '_n'] = xs.length;
        }
      }
      out[D] = b;
    }
    return out;
  }

  // ───────────────────────── readiness ─────────────────────────
  const WEIGHTS = { sleep: 30, rhr: 25, hrv: 25, resp: 10, strain: 10 };
  function subSleep(a, b) { if (a == null || b == null) return null; const s = (b - a) * 60; return s <= 30 ? 100 : s <= 60 ? 70 : s <= 90 ? 40 : 20; }
  function subRhr(a, b) { if (a == null || b == null) return null; const e = a - b; return e <= 2 ? 100 : e <= 5 ? 70 : e <= 8 ? 40 : 20; }
  function subHrv(a, b) { if (a == null || b == null || b === 0) return null; const x = (b - a) / b; return x <= 0 ? 100 : x <= 0.10 ? 90 : x <= 0.20 ? 70 : x <= 0.30 ? 40 : 20; }
  function subResp(a, b) { if (a == null || b == null) return null; const e = a - b; return e <= 0.5 ? 100 : e <= 1.5 ? 60 : 30; }
  function subStrain(prevK, kb, kmad, sR, sH) {
    if (prevK == null || kb == null) return 100;
    const high = kmad != null && prevK > kb + 1.5 * kmad;
    const poor = (sR != null && sR <= 70) || (sH != null && sH <= 90);
    return high && poor ? 50 : 100;
  }

  /**
   * Readiness for one day. r = row, b = baselines for that day, prevKcal = prior day's akcal.
   * Returns null when the day can't be scored AND the override doesn't fire.
   * Port of readiness.py compute_day() including the D1 partial-data rule.
   */
  function computeReadiness(r, b, prevKcal) {
    b = b || {};
    const sSleep = subSleep(r.slp, b.slp_base), sRhr = subRhr(r.rhr, b.rhr_base), sHrv = subHrv(r.hrv, b.hrv_base), sResp = subResp(r.resp, b.resp_base);
    const sStrain = subStrain(prevKcal, b.akcal_base, b.akcal_mad, sRhr, sHrv);
    const subs = { sleep: sSleep, rhr: sRhr, hrv: sHrv, resp: sResp, strain: sStrain };
    const conds = [];
    if (r.rhr != null && b.rhr_base != null && (r.rhr - b.rhr_base) >= 5) conds.push('RHR +' + Math.round(r.rhr - b.rhr_base));
    if (r.hrv != null && b.hrv_base != null && b.hrv_base > 0 && (b.hrv_base - r.hrv) / b.hrv_base >= 0.20) conds.push('HRV -' + Math.round((b.hrv_base - r.hrv) / b.hrv_base * 100) + '%');
    if (r.resp != null && b.resp_base != null && (r.resp - b.resp_base) >= 1.0) conds.push('resp +' + (r.resp - b.resp_base).toFixed(1));
    if (r.slp != null && b.slp_base != null && (b.slp_base - r.slp) * 60 >= 60) conds.push('sleep -' + Math.round((b.slp_base - r.slp) * 60) + 'min');
    if (r.spo2 != null && r.spo2 <= 94) conds.push('SpO2 ' + Math.round(r.spo2) + '%');
    const override = conds.length >= 2;
    const fully = !(sSleep == null || sRhr == null || sHrv == null);
    if (!fully && !override) return null;
    let score = null;
    if (fully) {
      let num = 0, den = 0;
      for (const k in subs) if (subs[k] != null) { num += WEIGHTS[k] * subs[k]; den += WEIGHTS[k]; }
      score = den ? Math.round(num / den) : null;
    }
    const state = override ? 'Compromised' : score >= 80 ? 'Ready' : score >= 60 ? 'Steady' : 'Compromised';
    const label = { sleep: 'sleep', rhr: 'resting HR', hrv: 'HRV', resp: 'resp rate', strain: 'strain' };
    const contrib = [];
    for (const k of ['sleep', 'rhr', 'hrv', 'resp', 'strain']) if (subs[k] != null && subs[k] < 70) contrib.push(label[k]);
    const bits = [];
    if (r.slp != null && b.slp_base != null) bits.push('sleep ' + r.slp.toFixed(1) + 'h vs usual ' + b.slp_base.toFixed(1) + 'h');
    if (r.rhr != null && b.rhr_base != null) bits.push('RHR ' + Math.round(r.rhr) + ' vs ' + Math.round(b.rhr_base));
    if (r.hrv != null && b.hrv_base != null) bits.push('HRV ' + Math.round(r.hrv) + ' vs ' + Math.round(b.hrv_base));
    let explanation = bits.join('; ');
    if (override) explanation += ' | override: ' + conds.join(', ');
    if (score == null) explanation += ' | based on partial data (some signals missing today)';
    return { score, state, override, conds, contributors: contrib, explanation, subs, partial: score == null };
  }

  /** Baselines + readiness for the whole table. Returns { baselines:{d:{}}, readiness:{d:{}} }. */
  function deriveAll(rows) {
    const dates = Object.keys(rows).sort();
    const baselines = computeBaselines(rows, dates);
    const readiness = {};
    let prevK = null, prevD = null;
    for (const d of dates) {
      // prior-day strain must be the calendar day before (a gap means no prior-day load)
      const pk = (prevD && addDays(prevD, 1) === d) ? prevK : null;
      const res = computeReadiness(rows[d], baselines[d], pk);
      if (res) readiness[d] = res;
      prevK = rows[d].akcal != null ? rows[d].akcal : null; prevD = d;
    }
    return { baselines, readiness, dates };
  }

  // ───────────────────────── stats helpers ─────────────────────────
  function lastN(rows, dates, n, endDate) {
    const end = endDate || dates[dates.length - 1];
    const out = [];
    for (let k = n - 1; k >= 0; k--) { const d = addDays(end, -k); if (rows[d]) out.push(rows[d]); }
    return out;
  }
  function avgOf(list, key) { const xs = list.map(r => r[key]).filter(isNum); return xs.length ? mean(xs) : null; }
  function sumOf(list, key) { const xs = list.map(r => r[key]).filter(isNum); return xs.length ? sum(xs) : null; }

  // Trailing-average weight (kg) over up to `days` days ending at endDate
  function weightAvg(rows, endDate, days) {
    const xs = [];
    for (let k = 0; k < days; k++) { const r = rows[addDays(endDate, -k)]; if (r && r.wt != null) xs.push(r.wt); }
    return xs.length ? mean(xs) : null;
  }

  // Nights below baseline in the last 7 (for "6 of the last 7 nights" language)
  function countBelow(rows, baselines, endDate, key, n, tol) {
    let cnt = 0, have = 0;
    for (let k = 0; k < n; k++) {
      const d = addDays(endDate, -k), r = rows[d], b = baselines[d];
      if (!r || r[key] == null || !b || b[key + '_base'] == null) continue;
      have++;
      if (r[key] < b[key + '_base'] - (tol || 0)) cnt++;
    }
    return { cnt, have };
  }

  // Weekly rollups: Monday-start weeks. Returns array oldest->newest.
  function weeklyRollup(rows, workouts, weeks, endDate) {
    const end = endDate; const out = [];
    const ws = weekStart(end);
    for (let w = weeks - 1; w >= 0; w--) {
      const s = addDays(ws, -7 * w), e = addDays(s, 6);
      const days = []; for (let k = 0; k < 7; k++) { const r = rows[addDays(s, k)]; if (r) days.push(r); }
      const wk = (workouts || []).filter(x => x.d >= s && x.d <= e);
      out.push({
        start: s, end: e, days: days.length,
        steps: avgOf(days, 'steps'), akcal: avgOf(days, 'akcal'), exmin: sumOf(days, 'exmin'),
        slp: avgOf(days, 'slp'), rhr: avgOf(days, 'rhr'), hrv: avgOf(days, 'hrv'),
        sessions: wk.length, wmin: Math.round(wk.reduce((a, x) => a + (x.dur || 0), 0) / 60),
        wkcal: wk.reduce((a, x) => a + (x.kcal || 0), 0), wdist: wk.reduce((a, x) => a + (x.dist || 0), 0),
        byType: wk.reduce((acc, x) => { acc[x.name] = (acc[x.name] || 0) + 1; return acc; }, {})
      });
    }
    return out;
  }

  // Monthly averages for long-range trends
  function monthlyAvg(rows, key, minReadings) {
    const buckets = {};
    for (const d in rows) { const v = rows[d][key]; if (v == null) continue; const m = d.slice(0, 7); (buckets[m] = buckets[m] || []).push(v); }
    return Object.keys(buckets).sort().map(m => ({ m, v: mean(buckets[m]), n: buckets[m].length, thin: buckets[m].length < (minReadings || 5) }));
  }

  // Pearson correlation of two aligned arrays (nulls dropped pairwise)
  function pearson(xs, ys) {
    const px = [], py = [];
    for (let i = 0; i < xs.length; i++) if (isNum(xs[i]) && isNum(ys[i])) { px.push(xs[i]); py.push(ys[i]); }
    const n = px.length; if (n < 8) return { r: null, n };
    const mx = mean(px), my = mean(py);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (px[i] - mx) * (py[i] - my); dx += (px[i] - mx) ** 2; dy += (py[i] - my) ** 2; }
    return { r: dx && dy ? num / Math.sqrt(dx * dy) : null, n };
  }

  // Workout type -> family for grouping/icons
  function workoutFamily(name) {
    const n = (name || '').toLowerCase();
    if (n.indexOf('run') !== -1) return 'run';
    if (n.indexOf('walk') !== -1 || n.indexOf('hiking') !== -1) return 'walk';
    if (n.indexOf('strength') !== -1 || n.indexOf('functional') !== -1 || n.indexOf('core') !== -1) return 'strength';
    if (n.indexOf('interval') !== -1 || n.indexOf('hiit') !== -1) return 'hiit';
    if (n.indexOf('cycl') !== -1 || n.indexOf('bike') !== -1) return 'cycle';
    if (n.indexOf('elliptical') !== -1 || n.indexOf('stair') !== -1 || n.indexOf('rowing') !== -1) return 'cardio';
    if (n.indexOf('yoga') !== -1 || n.indexOf('pilates') !== -1 || n.indexOf('stretch') !== -1 || n.indexOf('cooldown') !== -1 || n.indexOf('mind') !== -1) return 'mobility';
    if (n.indexOf('swim') !== -1) return 'swim';
    return 'other';
  }
  // pace in min per km for a distance workout
  function paceMinKm(w) { return (w && w.dist > 0.2 && w.dur) ? (w.dur / 60) / w.dist : null; }

  return {
    VERSION, BASE_METRICS, WINDOW_DAYS, LAG_DAYS, MIN_VALID, WEIGHTS, HR_BIN0, HR_BINW, HR_NBINS,
    parseDaily, flagWeightJumps, mergeDailyRows, dateFromDailyName, isWorkoutName,
    parseWorkout, parseWorkoutFile, hrZones,
    computeBaselines, computeReadiness, deriveAll,
    lastN, avgOf, sumOf, weightAvg, countBelow, weeklyRollup, monthlyAvg, pearson, workoutFamily, paceMinKm,
    util: { mean, median, mad, round, addDays, daysBetween, dow, weekStart, isNum, toKg, toKm, toKmh, toC, LB_KG, MI_KM, dateOf, hhmm }
  };
});
