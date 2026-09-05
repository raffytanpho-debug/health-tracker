# Health Tracker

A private, phone-first PWA that turns Apple Watch data into a calm daily read:
readiness, personal-baseline trends, and workouts.

Same architecture as the Finance and Mio trackers — one `index.html`, no build
step, `localStorage` on-device, Google Drive for sync, GitHub Pages for hosting.

**No health data lives in this repo.** `.gitignore` blocks `fixture/`, every
`health-data*.json`, every CSV and the session files. The repo is public because
GitHub Pages requires it; the data never is.

---

## How the data gets here

```
Apple Watch → iPhone Health → Health Auto Export (app)
    → Google Drive: "03 Health Tracker Assistant/01 Data Inbox/Health Auto Export/"
        → tools/sync-to-drive.mjs  (nightly, on the PC)
            → Google Drive: "Health Tracker Data/health-data.json"
                → the PWA, on any device
```

The middle step exists for a specific reason. The app authenticates with the
`drive.file` scope, which only exposes files **the same OAuth client created**.
The raw export files were created by the iPhone app, so the PWA can never see
them. The alternative — `drive.readonly` — is a sensitive scope needing a Google
verification review, or it stays in "Testing" mode where refresh tokens die every
7 days. That is the exact reconnect problem the Finance Tracker already had to
fix once, so it is not worth reintroducing.

---

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app: markup, styles, logic. Edit this. |
| `engine.js` | Parsing, personal baselines, readiness scoring. A 1:1 port of the reviewed Python pipeline. Runs in the browser and in Node. |
| `sw.js` | Service worker. Stale-while-revalidate for the shell. **Bump `CACHE` on every deploy.** |
| `manifest.json` | PWA manifest. |
| `tools/test-engine.mjs` | Engine self-tests, plus a comparison against the Python pipeline's output. |
| `tools/build-fixture.mjs` | Builds a seed `health-data.json` from the local export folder, for import via Settings. |
| `tools/sync-to-drive.mjs` | The nightly bridge described above. |
| `tools/make-icons.ps1` | Regenerates the icon set. |

---

## Working on it

```bash
node tools/test-engine.mjs            # 31 self-tests
node tools/test-engine.mjs --compare  # + diff against the Python daily_summary.csv
```

Serve it locally (the app skips the service worker on localhost, because it was
serving a stale shell and swallowing every edit):

```bash
py -m http.server 8942 --directory C:/dev/health-tracker
```

To work with real data locally: `node tools/build-fixture.mjs`, then import
`fixture/health-data.json` from Settings.

---

## Design rules this app follows

From the research in `03 Developer Assistant/Health Tracker/03 ChatGPT Research/`
and `04 Overall Plan.md`. These are requirements, not preferences.

- **Personal baseline is the unit of truth**, never population norms. Rolling
  28-day median, excluding the last 7 days so an ongoing problem cannot quietly
  become the new normal.
- **Every prominent panel resolves to one of four actions**: watch · continue ·
  change one thing · talk to a clinician. A metric that maps to none of them does
  not belong on the home view.
- **Baseline-relative, time-bounded language.** "Below your usual range 6 of 7
  nights", never "your HRV is bad".
- **The vanity tier stays demoted.** Sleep stages, basal calories, BMI, body fat
  and single SpO2 readings carry real measurement error on a watch. They live in
  a collapsed block.
- **Red is rare.** Neutral by default; green means stable, not virtuous.
- **Gaps are surfaced, never filled.** Watch-off days stay as gaps, and stale
  data says so on the home view.
- **Flag, don't diagnose.**

---

## Deploying

GitHub Pages serves `main`. Before pushing: bump `CACHE` in `sw.js`, or the
stale-while-revalidate worker will keep serving the old shell. Expect 2-3 cold
opens before a new worker installs.

See `SETUP.md` for the one-time Drive and scheduled-task setup.
