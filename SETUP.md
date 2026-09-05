# Setup — one time

Four steps. Steps 1 and 2 need your hands; 3 and 4 are commands you can paste.

---

## 1. Create the GitHub repo and turn on Pages

The app is not deployed yet. Nothing has been pushed anywhere. The `gh` CLI is
not installed on this machine and there is no stored GitHub API token, so the
repo has to be created from the browser — but only the creation does.

1. Go to **https://github.com/new**
2. Name it exactly **`health-tracker`**, owner `raffytanpho-debug`
3. **Public** (GitHub Pages on a private repo needs a paid plan)
4. Do **not** add a README, .gitignore or licence — the repo already has commits
   and an initialising commit would force a merge
5. Create it

Then push from here (git's credential helper already has your GitHub login, so
this needs no token):

```bash
cd C:/dev/health-tracker && git remote add origin https://github.com/raffytanpho-debug/health-tracker.git && git push -u origin main
```

Finally: **repo → Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.

It will be live at `https://raffytanpho-debug.github.io/health-tracker/`.

> The repo has to be public for free GitHub Pages, which is why `.gitignore`
> blocks every data shape. Verify before the first push:
> ```bash
> cd C:/dev/health-tracker && git ls-files | grep -Ei 'fixture|health-data|\.csv$'
> ```
> That must print nothing.

---

## 2. Update the Cloudflare Worker

The Worker's `APPS` allowlist decides which apps the Google OAuth flow will
return to. Health Tracker is not in it yet, so **Connect Google Drive will fail
until this is done**.

The file to paste is:

```
03 Developer Assistant/Health Tracker/worker/claude-worker_health-tracker_2026-09-05.js
```

Paste it into the `claude-proxy` Worker at dash.cloudflare.com and deploy.
(Cloudflare's editor runs in a cross-origin iframe, so this cannot be automated.)

**Read this before you paste.** That file is the pending
`2026-08_proxy-lockdown` hardening draft with one line added for Health Tracker.
Deploying it therefore also ships the security fix your learning log has had open
since 2026-08-22 — the proxy currently accepts requests from any origin with no
auth or rate limit. That is a good thing, but it is a change to **live Finance
Tracker infrastructure**, so:

- Read `2026-08_proxy-lockdown/DEPLOY_RUNBOOK_2026-08-31.md` first.
- After deploying, open Finance Tracker and confirm the AI assistant and Drive
  sync both still work before trusting it.
- If you would rather not couple the two, add this single line to the currently
  deployed Worker's `APPS` object instead and leave the hardening for later:

```js
'health-tracker':    { url: 'https://raffytanpho-debug.github.io/health-tracker/',    name: 'Health Tracker' },
```

> The deployed Worker does not currently accept an `?app=` parameter at all, so
> the one-line option only works if you are on a version that has the `APPS`
> table. If `/drive/start?app=health-tracker` sends you back to Finance Tracker,
> you are on the old one and need the full file.

---

## 3. Seed the data and connect Drive

On the desktop, with the app open:

1. **Settings → Connect Google Drive.** This creates
   `Health Tracker Data/health-data.json` in your Drive under the app's own
   OAuth client, which is what makes it visible to the sync script later.
2. Build a seed file and import it, so you start with all 11 years rather than
   waiting for the script:

```bash
cd C:/dev/health-tracker && node tools/build-fixture.mjs
```

Then **Settings → Import data file →** `fixture/health-data.json`.

3. Open the app on your phone, connect Drive there too, and it will pull
   everything down.

---

## 4. Arm the nightly sync

Get the session id — in the desktop app's browser console:

```js
await new Promise(r => { const q = indexedDB.open('ht-kv'); q.onsuccess = () => { const t = q.result.transaction('kv').objectStore('kv').get('driveSession'); t.onsuccess = () => r(t.result); }; })
```

Store it (this writes `.drive-session`, which is gitignored):

```bash
cd C:/dev/health-tracker && node tools/sync-to-drive.mjs --session PASTE_THE_ID_HERE
```

Check it before automating it:

```bash
cd C:/dev/health-tracker && node tools/sync-to-drive.mjs --dry-run
```

**The scheduled task is already registered** — "Health Tracker Drive Sync",
daily at 06:30, running `C:\Program Files\nodejs\node.exe tools/sync-to-drive.mjs`
from `C:\dev\health-tracker`. It was test-fired on 2026-09-05 and correctly
failed with "No session id", which confirms the node path, working directory and
script path are all wired right. It will start doing real work the moment the
session id above exists, with no further setup.

`-DontStopIfGoingOnBatteries` and `-AllowStartIfOnBatteries` were set
deliberately: a task that silently refuses to run on battery while still
reporting its last result as success is a known way for a sync to look healthy
while doing nothing.

To change the time, or to remove it:

```powershell
Get-ScheduledTask -TaskName "Health Tracker Drive Sync"
Unregister-ScheduledTask -TaskName "Health Tracker Drive Sync" -Confirm:$false
```

**Verify it by what it produced, not by its exit status.** After the first
scheduled run:

```powershell
Get-ScheduledTaskInfo -TaskName "Health Tracker Drive Sync" | Select LastRunTime, LastTaskResult, NextRunTime
```

and confirm the `Days` count in the app's Settings actually moved.

---

## What breaks this

| Symptom | Cause |
|---|---|
| Connect Drive returns you to Finance Tracker | Step 2 not done, or the deployed Worker has no `APPS` table |
| `Drive session rejected` from the sync script | Refresh token revoked or consent expired. Reconnect in the app, re-run with `--session`. |
| App shows old numbers after a deploy | Service worker cache. Bump `CACHE` in `sw.js`; expect 2-3 cold opens. |
| Sync script says "Nothing changed" but data is stale | Health Auto Export has not run on the phone. Check the iPhone app, not this one. |
| Readiness shows "No score" for recent days | Needs sleep, resting HR and HRV on the same day. Usually means the watch was off overnight. |
