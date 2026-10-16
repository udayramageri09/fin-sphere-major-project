# FinSphere

FinSphere is a student personal-finance web application. You record or import transactions, inspect spending, track savings goals and debts, record investment valuations, and request financial analysis. PostgreSQL stores the records. The optional language model explains results; it is not the source of financial totals.

**Faculty demo: October 17, 2026.** Use the [10-minute startup](#10-minute-faculty-demo-startup) and [troubleshooting guide](#troubleshooting--debugging). This checkout has local readiness changes; it has not been deployed or certified for public production use. Current release verification is in [RELEASE_VERIFICATION.md](docs/RELEASE_VERIFICATION.md); deployment, rollback and recovery steps are in [RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md). Earlier FINALIZATION reports are historical.

## What each part does

```text
Browser: React UI (5173)
    | JSON + HttpOnly session cookie
    v
Express API (5000) ----> PostgreSQL (usually 5432)
    |                         owns all persistent finance data
    +----> private FastAPI analysis service (8000)
    |          request-scoped models; no direct database access
    +----> optional Groq provider (explanations / extraction)
    +----> local Tesseract worker (image -> reviewable text)
    +----> optional Resend provider (password recovery email)
```

The API verifies the session and scopes queries to that owner. The browser's `X-FinSphere-User` header detects stale tabs; it never chooses the database owner. Switching accounts discards the previous account's component state. Analysis loads data on the server before sending it to Python. Keep Python private: it has no authentication.

Machine learning: linear regression forecasts, Isolation Forest anomaly detection, and Ward agglomerative spending clustering. Financial health scores and plans use deterministic rules. Models fit per request; no saved trained model or real-world accuracy guarantee is supplied. Refunds reduce spending, transfers count in neither analytical income nor spending, and raw balance includes every recorded money movement. See [financial rules](docs/FINANCIAL_LOGIC.md).

## Verified technology and versions

Versions below describe the inspected installed environment, not permanent minimum requirements. Node manifests allow some newer compatible versions; `npm ci` follows the lockfiles. Python requirements now pin the complete 25-package application closure validated in a separate clean Python 3.12 environment. The existing global demo interpreter was preserved.

| Component | Inspected version / location |
|---|---|
| Node.js / npm | 24.13.1 / 11.8.0 |
| React | 19.2.5 |
| Vite | 6.4.4; current root npm audit reports zero findings |
| Tailwind CSS / ESLint | 4.3.3 / 10.3.0 |
| Express / PostgreSQL driver | 4.22.2 / pg 8.23.1 |
| Multer / Tesseract.js | 2.4.0 / 7.0.0 |
| SheetJS | 0.20.3 vendor tarball, pinned in server lockfile |
| Python | 3.12.10 |
| Python libraries | Release venv: FastAPI 0.143.3, Uvicorn 0.40.0, NumPy 2.5.4, pandas 3.0.6, scikit-learn 1.9.1; `ml_service/requirements.txt` |
| PostgreSQL | connected maintenance server verified as 18.6; local 14 and 18 tools discovered; choose the service/port deliberately |

## Repository map

```text
README.md                    start here
package.json / package-lock.json   frontend tools, dependencies and test scripts
.env.example                 public frontend URL template
src/
  App.jsx                    navigation and per-account application boundary
  pages/                     Dashboard, Transactions, Goals, Liabilities,
                             Portfolio, Plans, Settings, Subscriptions
  context/                   authentication and shared financial state
  hooks/                     guarded requests, voice and navigation lifecycle
  components/analytics/      Transactions Insights, charts and drilldown
  components/                forms, onboarding, assistant, reusable UI
  utils/                     dates, money semantics, parsing and confirmations
server/
  server.js                  Express routes, auth, uploads, analysis interaction
  runtimeConfig.js           legacy migration and reverse-proxy configuration
  db/index.js / schema.sql    parameterized owner-scoped SQL and startup schema
  importDuplicates.js        matching and HMAC review integrity
  imageOcr.js                image validation, queue and local OCR workers
  assistantActions.js        proposal/confirmation state machine
  holdings.js                manual portfolio validation and routes
  passwordReset.js           token/delivery rules
  .env.example               private API configuration template
  tests/                     API, DB and pure-logic regressions
ml_service/
  main.py                    private FastAPI endpoints
  models/                    forecasting, clustering, anomalies and rule engines
  tests/                     Python unit tests
  evaluation/                synthetic evaluation and generated reference report
tests/                       frontend pure-logic and jsdom UI regressions
public/favicon.svg           referenced application icon
docs/                        architecture, API, security, database and evaluation
skills/                      retained project guidance/reference material
uploads/                     private legacy/runtime material; ignored, never publish
dist/ / node_modules/        generated build / installed packages; ignored
```

Legacy `server_db.json`, `server_users.json`, goal/liability JSON and `.env` files may exist locally. They are **data or credentials**, not disposable clutter. They were retained. Empty guidance files were retained too. Do not upload the whole working folder or delete ignored files to “clean” it. See [cleanup inventory](docs/CLEANUP_INVENTORY.md).

## Prerequisites

Install Node.js with npm, Python 3.12, and PostgreSQL with its command-line tools. The inspected Windows environment uses Node 24. PostgreSQL must be running, and you need a role allowed to create a development database. Automated API integration tests additionally need permission to create/drop their own disposable databases. A browser and a working internet connection are needed to install dependencies. Groq and Resend are optional.

All commands below are **Windows PowerShell**. Open the repository:

```powershell
Set-Location 'C:\Users\udayr\OneDrive\Desktop\fin-sphere\fin-sphere'
node --version
npm.cmd --version
python --version
Get-Service *postgres*
```

Use `npm.cmd` if PowerShell blocks `npm.ps1`; do not globally weaken execution policy. PostgreSQL tools may need their full path, for example `C:\Program Files\PostgreSQL\18\bin\psql.exe`. Choose 14 or 18 according to the server you actually use.

## Safe database separation

| Purpose | Database policy |
|---|---|
| Development | new `finsphere_dev_local` with synthetic records |
| Automated tests | unique disposable names created by the reviewed test harnesses |
| Faculty demonstration | existing `finsphere_faculty_demo_20261015`: protected; do not run cleanup, tests or migrations against it during finalization |
| Report kit | existing `finsphere_report_kit_20261016`: protected; do not modify |
| Production | a separate least-privilege role/database, verified TLS and tested backups |

`DATABASE_URL` in **server/.env** selects the API's database. A frontend port or login email does not select a database. Before starting any API, inspect the database name locally without sharing the full URL. Do not paste it into chat, screenshots or bug reports. Existing faculty/report configuration was not changed by finalization. Starting the API applies schema statements, so starting it against an existing protected database is not a read-only diagnostic.

For a first-time **new development** database only:

```powershell
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
& "$pgBin\pg_isready.exe" -h localhost -p 5432
# Prompts for the database administrator password; do not put it in command history.
& "$pgBin\createdb.exe" -h localhost -p 5432 -U postgres finsphere_dev_local
# Read-only check; use the correct local role.
& "$pgBin\psql.exe" -h localhost -p 5432 -U postgres -d finsphere_dev_local -c 'SELECT current_database(), current_user, version();'
```

If it already exists, investigate ownership and contents; do not drop it. No destructive SQL is required for setup. Startup applies `server/db/schema.sql` under an advisory lock. This is an idempotent startup schema mechanism, not a full versioned down-migration system. Back up before upgrades to any valuable database.

## First-time setup

1. Install the two Node dependency trees from their lockfiles:

   ```powershell
   npm.cmd ci
   npm.cmd --prefix server ci
   ```

2. Create environment files **only if absent**. Never overwrite existing credentials:

   ```powershell
   if (!(Test-Path .env)) { Copy-Item .env.example .env }
   if (!(Test-Path server/.env)) { Copy-Item server/.env.example server/.env }
   ```

3. Edit root `.env` to select the API. This URL includes `/api`:

   ```dotenv
   VITE_API_URL=http://localhost:5000/api
   ```

4. Edit `server/.env` privately. The following is a template, not working credentials:

   ```dotenv
   PORT=5000
   NODE_ENV=development
   DATABASE_URL=postgres://LOCAL_ROLE:URL_ENCODED_PASSWORD@localhost:5432/finsphere_dev_local
   DATABASE_SSL=false
   JWT_SECRET=REPLACE_WITH_A_PRIVATE_RANDOM_VALUE_AT_LEAST_32_CHARACTERS
   CORS_ORIGINS=http://localhost:5173
   TRUST_PROXY=false
   ML_SERVICE_URL=http://127.0.0.1:8000
   IMPORT_LEGACY_JSON=false
   GROQ_API_KEY=
   ```

   Generate a random JWT secret locally with Node's `crypto.randomBytes(48).toString('hex')`; keep its output private. URL-encode reserved characters in database passwords. Shell environment variables override dotenv values; close stale terminals or inspect variable **names**, not values, when configuration seems ignored.

5. Create the Python environment and install libraries:

   ```powershell
   if (!(Test-Path ml_service/.venv/Scripts/python.exe)) { python -m venv ml_service/.venv }
   & .\ml_service\.venv\Scripts\python.exe -m pip install -r ml_service/requirements.txt
   ```

   No environment activation is required with this explicit interpreter path. The release pins passed 42 tests and synthetic evaluation in a clean environment. Keep the prepared faculty interpreter separate and rerun tests on the target host.

## Start the application: three terminals

Start from the root directory above in each terminal. PostgreSQL is a background Windows service, not one of these three terminals.

**Terminal 1: private Python service**

```powershell
Set-Location ml_service
$env:ML_SERVICE_HOST='127.0.0.1'
$env:ML_SERVICE_PORT='8000'
& .\.venv\Scripts\python.exe main.py
# If using the already verified global environment instead: python main.py
```

**Terminal 2: Express API** (check the database name before starting)

```powershell
$env:IMPORT_LEGACY_JSON='false'
npm.cmd --prefix server start
```

The server loads `server/.env`, even when launched from the root. It refuses a missing/short JWT secret or unavailable database. Health check:

```powershell
Invoke-RestMethod http://localhost:5000/api/health
Invoke-RestMethod http://127.0.0.1:8000/health
```

API health checks database connectivity; it does not prove Python, Groq or email is available.

**Terminal 3: frontend**

```powershell
npm.cmd run dev -- --host localhost --port 5173 --strictPort
```

Open [FinSphere locally](http://localhost:5173). Use the same hostname consistently: `localhost` and `127.0.0.1` are different browser origins. Stop your own servers with Ctrl+C in their terminals. On Windows forced termination may bypass graceful signal handling; do not kill unrelated processes.

## Pages and sample workflows

| Page | What it does |
|---|---|
| Dashboard | recorded balance, monthly income/spending, cash flow and recent transactions |
| Transactions | manual entries, editing/categories, statement import and Insights |
| Insights | period totals, spending categories, comparisons and transaction drilldown |
| Goals | savings goals, contributions and emergency-fund records |
| Liabilities | entered debts, balances and repayments; repayment does not automatically add an expense |
| Portfolio | saved manual investment amounts, dated valuations and allocation; no live prices or fabricated return history |
| Financial Intelligence | Server-backed forecasts, categories, cluster examples, anomalies, health score and plan; optional narration. Analysis is limited to 3,000 saved transactions to bound clustering memory; nothing is silently truncated. |
| Settings | display name, photo, account settings and onboarding guide |
| SIPs & Subs | **static example cards**, not persisted subscription management or live investments |

For a new synthetic development account, register, skip or follow onboarding, then add an income and expense dated in the current month. Verify Dashboard and Transactions agree. Open Insights and select the matching month range; inspect a category to see its underlying transactions. Dates outside the selected period should produce an explicit empty-period message.

For imports, paste text or upload CSV/TXT/XLS/XLSX. Images use the separate JPG/JPEG/PNG OCR step: inspect the extracted text, correct amounts/dates, then continue. **OCR does not save a transaction by itself.** Duplicate review matches counts of existing records from the same account. Review likely/possible matches and select an import policy. A stale review receives 409 and must be reviewed again; do not blindly replay import-all. The reviewed path caps candidates at 500 rows; the legacy `duplicates=allow` API path remains a documented risk.

For the assistant, type a question such as “How much did I spend this month?” or a navigation request such as “Open transactions”. An action such as “Add a lunch expense of 450 today” must show a preview. Confirm only after checking the amount, date, account and destination. Voice uses the same proposal path. Editing the amount creates a new preview; speech recognition alone must not save anything. Text chat is the reliable fallback when microphone permissions or browser speech support fail.

For Portfolio, enter a holding with invested/current values and valuation date. Zero is an explicit value. Gains are differences between entered amounts, not annualized returns or live market performance. For Financial Intelligence, use several months of synthetic history for a meaningful forecast. A one-month sample cannot establish a credible trend.

## Tests and build

Run from the root. UI tests use jsdom and Vite; they are separate from real-browser smoke tests. Some tests deliberately simulate failures and print warnings even when assertions pass. Inspect exit status and final counts.

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run test:analytics
npm.cmd run test:analytics-ui
npm.cmd run test:assistant
npm.cmd run test:copilot   # allow up to 3 minutes: many intentional timer waits
npm.cmd run test:session
npm.cmd run test:portfolio
npm.cmd --prefix server run test:security
npm.cmd --prefix server run test:image-ocr
npm.cmd --prefix server run test:image-ocr-server
npm.cmd --prefix server run test:import-duplicates-server
Push-Location ml_service
python -m unittest discover -s tests -v
Pop-Location
```

There is no single root `npm test` script. List all named suites with `npm.cmd run` and `npm.cmd --prefix server run`. For the complete frontend file set:

```powershell
Get-ChildItem tests/*.test.mjs | ForEach-Object {
  node --test $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "Failed: $($_.Name)" }
}
```

Before database tests, use a local test-only role/server and set `IMPORT_LEGACY_JSON=false`. Most API harnesses create/drop their own PID-named throwaway databases via the `postgres` maintenance database. Read each harness before running. Never point an arbitrary test at valuable data. `passwordResetDb.test.mjs` is special: it requires `FINSPHERE_RESET_TEST_DATABASE_URL` naming a separately provisioned `finsphere_reset_test_<digits>` database; do not substitute a demo database. See [validation report](docs/FINALIZATION_REPORT.md) for actual results.

Synthetic model evaluation, with output outside committed reference results:

```powershell
python -m ml_service.evaluation.run_evaluation --out "$env:TEMP\finsphere-evaluation"
npm.cmd audit
npm.cmd --prefix server audit
npm.cmd audit --omit=dev
```

The reviewed Vite 6.4.4 update clears the previous Vite/esbuild findings. Both current npm audits report zero findings. Page loading also removes the previous large-chunk warning. Do not use `npm audit fix --force` as a substitute for reviewing an upgrade. `dist` is generated output. `npm run preview` serves a local build preview, not a complete production API or production web server. `VITE_API_URL` is baked into the build; changing it requires rebuilding.

## TROUBLESHOOTING / DEBUGGING

### Safe diagnostic sequence

1. Record the symptom, page, time, selected month, displayed account and browser URL. Use synthetic examples. Do not share bank statements or credentials.
2. Verify ports and each service's own terminal. Check API `/api/health`, Python `/health`, then the browser Developer Tools Console and Network tabs.
3. In Network inspect request URL, status and timing. Redact Cookie, Authorization, reset links, database URLs, names and financial bodies before sharing. Preserve error codes rather than dumping request bodies.
4. Check database **identity** and schema using read-only queries. Do not “fix” things by dropping tables, truncating records or replaying imports.
5. Change one setting at a time; restart only the affected service. Recheck with a synthetic record. Keep a copy/diff of the change so it can be reversed.

The normal logs are the three running terminals; the app does not supply a central rotating log directory. Redirect logs only to a private, ignored location and review for sensitive content before sharing. Browser Console warnings from extensions are distinct from application failures.

| Symptom | What to check / safe diagnostic | Fix or next step |
|---|---|---|
| Blank Transactions Insights | Console render error; Network transaction read; correct account; selected month and row dates; reload/revisit tab | Try a month containing data, then another page and back. If truly blank, capture a redacted stack and exact steps. Existing empty states are intentional. Do not delete transactions or change the locked layout based on an intermittent report alone. **Known mechanism (reproduced 16 Oct, one-line fix applied):** the reveal animation used to fade the panel in from opacity 0, so a browser that stopped producing frames left the fully rendered panel invisible; it now only slides. This is a demonstrated risk, **not** confirmed as the cause of the original report. If it still happens, in DevTools check the panel `.transaction-insights-panel` for `opacity`, `hidden` and its height before reloading, and note the account, origin, range and the `/api/transactions` status. |
| API down / fetch failed | `Invoke-RestMethod http://localhost:5000/api/health`; API terminal; JWT length; database name/reachability | Correct private API env, start PostgreSQL, restart API; distinguish refusal to start from a frontend URL error. |
| Login succeeds then returns to login | Network cookie, CORS origin, `credentials`, expiry, another tab switching accounts; same hostname | Use one account in the same browser profile; close stale tabs or use a separate profile for the second account. Production requires HTTPS and same-site frontend/API. |
| 409 `account_changed` | Account in another browser tab changed | Recheck/sign in to the intended account. No financial operation should be retried until identity is confirmed. |
| CORS blocked | Exact frontend origin including port vs `CORS_ORIGINS`; API terminal | Add only the intended origin and restart API. Do not use wildcard credentials or disable browser security. |
| PostgreSQL refused / schema missing | `pg_isready`; API error code; `SELECT current_database(), current_user();`; `\dt` in psql | Correct service, port, role and database. Use a new development DB for schema experiments; back up valuable data before any reviewed upgrade. |
| Financial Intelligence unavailable | `Invoke-RestMethod http://127.0.0.1:8000/health`; Python terminal/import errors; API `ML_SERVICE_URL` | Start the correct Python interpreter in `ml_service`; align the two service ports. API analysis has a 60-second upstream limit. Core ledger pages work without Python. |
| Groq unavailable / rate-limited | API log HTTP status only, key configured privately, outbound connection, model env names | Use deterministic local fallback. Never paste API keys or provider bodies. Provider retirement/model support must be checked with the provider. |
| Microphone blocked / voice silent | Browser site permission, supported speech API, input device, network, secure origin | Use typed chat. Grant mic only deliberately; local browser support varies. Do not rely on live voice for the entire demo. |
| OCR failed / too large / busy | Real JPG/PNG signature, 5 MB limit, dimensions 100–8000 px and <=20 MP; worker install; Python is unrelated | Use a clear smaller crop; wait for the queue. Two OCR jobs run, three can wait; a job/queue wait is bounded at 30 s. Reinstall server dependencies from lockfile if language data is missing. Review all extracted numbers. |
| Import 409 vs real error | Read JSON `code`/message; stale duplicate-review digest vs account change | Stale review: refresh review and decide again. Validation 400/422: correct source; 429: wait; 5xx: inspect API log. Never bypass duplicate checks merely to hide an error. |
| Password reset email absent | `PASSWORD_RESET_DELIVERY`, verified Resend sender, API key, reset URL, cooldown/spam folder | Production needs real delivery settings. Development-only `local` captures mail in memory at `/api/dev/password-reset-mail` from loopback; it sends no email and is refused in production. Protect reset links; see password recovery docs. |
| Wrong API used by frontend | Network full request URL and root `VITE_API_URL` with `/api`; old build | Restart Vite after env edits; rebuild `dist` for production. No secrets belong in `VITE_` variables. |
| Rate limits affect everyone / proxy startup error | Host's proxy topology and `TRUST_PROXY` | Use false locally, a verified hop count or valid subnet list behind a proxy. `true`, negative counts and invalid strings are refused. Do not guess a permissive setting. |
| Port already in use | `Get-NetTCPConnection -State Listen -LocalPort 5000,5173,8000 -ErrorAction SilentlyContinue` | Identify `OwningProcess` with `Get-Process -Id <PID>`. Stop only your own obsolete server from its terminal; otherwise choose new ports and align CORS/API/ML URLs. |
| Build fails / dependencies missing | Correct directory, Node version, separate root/server installs; full first error | Use lockfile-based `npm.cmd ci` in the appropriate directory; preserve env/data. Avoid deleting source or force-upgrading tools. |
| Stale page / old values | Hard reload, Network URL, frontend port, active account, request status | Restart own frontend; clear only localhost site cache if needed (this may sign you out). Do not clear real project data. |
| Wrong demo account / port | Browser address, visible profile, intended API process and database name | Return to recorded demo URL/account. Reusing a browser cookie across APIs on localhost can confuse sessions because cookies are not isolated by port. Use a separate browser profile for synthetic testing. |

## 10-minute faculty-demo startup

This assumes dependencies and the intended demonstration environment were prepared beforehand. Do not perform package upgrades or run database tests during these ten minutes.

| Time | Action |
|---|---|
| 0–2 min | Connect power; verify the recorded demo URL, account and intended database configuration. Keep faculty/report databases out of testing. Close unrelated browser profiles/tabs. |
| 2–4 min | Start the prepared PostgreSQL service, Python service, API and frontend in separate terminals. For any schema-changing startup against a valuable demo database, use the pre-approved prepared setup and backup. |
| 4–5 min | Check both health endpoints and sign in to the intended demo account. Confirm its name and expected transactions. |
| 5–7 min | Dashboard -> Transactions -> Insights with the correct date range -> one category drilldown. Check totals before presenting. |
| 7–9 min | Show Goals, Liabilities, manual Portfolio and Financial Intelligence. Explain which outputs are rules vs ML. Label subscriptions as examples. |
| 9–10 min | Test one typed assistant question; keep a harmless preview/cancel workflow ready. Open screenshots and architecture as fallback. |

**Contingencies:** If Groq or microphone fails, use typed deterministic questions and navigation. If Python fails, show transaction/goal/portfolio functionality and explain analysis is unavailable. If an import stalls, cancel and use a prepared synthetic text example; do not repeatedly submit. If the database is unavailable, show the architecture and saved synthetic screenshots, state that live persistence is unavailable, and do not fabricate results. Never reset or overwrite the faculty database to rescue a demo.

## Screenshots

These captures use an isolated synthetic account and contain no real bank data. They show the exercised sample, not proof of every workflow or production deployment.

![Transactions Insights with synthetic salary and grocery records](docs/screenshots/finsphere-insights-synthetic.png)

![Financial Intelligence for the same synthetic records](docs/screenshots/finsphere-intelligence-synthetic.png)

See [the validation report](docs/FINALIZATION_REPORT.md) for smoke-test scope and remaining issues.

## Production readiness, backups and rollback

Before publishing, configure HTTPS, static SPA hosting/fallback, the final build-time API URL, exact CORS origins, same-site secure cookies, the actual reverse-proxy topology, private Python networking, verified PostgreSQL TLS and a least-privilege role. Configure real email separately. `NODE_ENV=production` makes cookies Secure/SameSite=Strict; unrelated frontend/API sites may fail login. Do not loosen cookies without a reviewed CSRF design.

Production legacy JSON import defaults **off**. `IMPORT_LEGACY_JSON=false` explicitly disables it everywhere. Development retains historical auto-import behavior if unset; therefore set false for new/demo/test environments. Only a reviewed, backed-up one-time migration should set it true. Never enable it to repair a missing UI record.

Use a private backup destination outside the source tree. Example for an authorized valuable database backup, with its actual host/port/role and confirmed database name:

```powershell
# Substitute the confirmed database name; password is prompted, not embedded.
& "$pgBin\pg_dump.exe" -h localhost -p 5432 -U YOUR_ROLE -d CONFIRMED_DATABASE -Fc -f 'D:\PrivateBackups\finsphere-before-upgrade.dump'
& "$pgBin\pg_restore.exe" --list 'D:\PrivateBackups\finsphere-before-upgrade.dump'
```

A backup listing is not a successful restore test. Validate restoration to a **new isolated database** with an administrator before production upgrades. Keep backups encrypted/access-restricted. Do not blindly use restore `--clean`, DROP DATABASE, TRUNCATE, `git clean`, or `git reset --hard`. For source rollback, review `git diff` and reverse only the intended hunks; retain current data and credentials. See the release handoff for the actual commit and push status. No merge, public deployment or purchase is authorized.

Known limitations: the preserved global demo Python still has earlier dependency advisories (use the isolated pinned release environment for deployment), no distributed rate-limit store, no full migration rollback tool, no spreadsheet parsing sandbox, optional external providers, limited synthetic evaluation and manual portfolio valuations. Startup schema and shutdown behavior need host-specific rollout testing. A process crash after an assistant proposal is claimed may leave it executing; inspect resulting records before creating another action. Host TLS, proxy, backups, monitoring and production email remain deployment-owner tasks.

## Further reading

- [API notes](docs/API.md) (the Plans and holdings endpoints; the full route list is in `server/server.js`), database schema in [`server/db/schema.sql`](server/db/schema.sql)
- [Security and deployment](docs/SECURITY_DEPLOYMENT.md), [password recovery](docs/PASSWORD_RECOVERY.md)
- [ML architecture](docs/ML_ARCHITECTURE.md) (also the best system overview), [evaluation](docs/ML_EVALUATION.md)
- [Financial logic](docs/FINANCIAL_LOGIC.md), [validation report and test inventory](docs/FINALIZATION_REPORT.md) and its [independent-review addendum](docs/FINALIZATION_ADDENDUM_2026-10-16.md) (dependency staging, Insights investigation)

`docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/TESTING.md`, `docs/AI.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md`, `docs/PROJECT.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`, `docs/CURRENT_STATE.md` and `docs/SETU.md` are empty placeholder files in this checkout; do not rely on them.

Some older documentation describes earlier states. Prefer the current code and the dated validation report when claims disagree; never assume an old “zero vulnerabilities” statement covers today's development dependencies.
