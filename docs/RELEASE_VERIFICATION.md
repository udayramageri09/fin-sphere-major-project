# FinSphere release candidate verification — 16 October 2026

## Outcome

Development candidate verified locally. Public production approval is withheld pending the
host-specific items below. No public deployment, merge, domain or hosting purchase occurred.
Started on enhancement/profile-truthful-portfolio-20261015 at 65ff883 with the earlier
finalization edits already uncommitted. Those edits were preserved and reviewed. The final
commit/push SHA is recorded in the external release receipt (a report cannot contain its own
commit SHA). Only this enhancement branch is authorized as a push destination.

Neither finsphere_faculty_demo_20261015 nor finsphere_report_kit_20261016 was connected to
by this work's test/API processes or modified. Existing private credentials, demo scripts,
JSON and uploads were preserved. Test credentials were synthetic and tests used owned
PID-named disposable databases. Maintenance access selected postgres, never either protected
database. Transactions source/UI was not changed. The retained Insights animation fix was
part of the incoming edits, and its regression passes.

## Improvements and measured performance

Financial Intelligence now shows server-calculated category totals and shares, separate from
size clusters, with recorded transaction examples. Cluster descriptions use actual min/max
amounts instead of assumed merchant categories. Statistical flags have explicit caveats;
R² explains historical fit, not forecast probability. Missing projected savings displays
Unavailable rather than ₹0. Loading has an announced status and busy state, advisor input has
an accessible name, focus is visible and reduced-motion preferences disable page animations.
The existing keyboard/touch forecast chart and exact-value table are retained.

| Measurement | Before | Candidate | Interpretation |
|---|---:|---:|---|
| Main entry JS, minified | 771.18 kB | 287.31 kB | 62.75% smaller initial entry |
| Main entry JS, gzip | 237.77 kB | 88.97 kB | 62.58% smaller initial entry |
| One observed working-tree build | 7.33 s | 6.88 s | Uncontrolled wall time, no build-speed claim |
| Current clean-copy build | — | 7.68 s | Clean source/dependency reproduction |
| Three analysis components during one advisor round-trip | 6 renders without memo | 0 renders with memo | Instrumented real component bodies in jsdom |
| Authenticated 100-row transaction GET, median of 30 | 2.55 ms | 2.83 ms | No API speedup; local single sequential sample |
| Same GET p95 | 3.39 ms | 4.16 ms | Includes auth, SQL, JSON and loopback transport |
| SQL 100-row owner-filtered ordered read | 0.077 ms | 0.180 ms | Single EXPLAIN ANALYZE; too small/noisy for a speed claim |

Dashboard chart code now loads after sign-in instead of in the login entry. Total application
code has not shrunk by the entry percentage: Dashboard is 353.59 kB and a shared GoalTracker
chunk is 132.44 kB minified. The initial lazy-dashboard request is a tradeoff and browser
sign-in/loading was verified. Final build has no >500 kB chunk warning.

API baseline is source 65ff883 versus candidate with the same current installed server
dependencies, fresh equivalent synthetic DBs, 100 seeded rows, warmup then 30 sequential
fully parsed GETs. This does not measure deployment load, TLS or concurrent users. Existing
owner indexes and parameterized queries were retained; no speculative database refactor.

Python benchmark: 300 synthetic rows over 12 months, one warmup plus five timed runs/model.
Old global interpreter versus clean release venv, medians in milliseconds:

| Model | Global | Release |
|---|---:|---:|
| Forecaster | 11.90 | 11.64 |
| Anomalies | 130.40 | 131.55 |
| Clustering | 24.25 | 24.38 |
| Health rules | 10.94 | 10.91 |

These compare runtime dependency sets, not an algorithm speedup. No Python speed claim is
made. Ward clustering is quadratic: the API and Python now reject >3,000 rows explicitly,
without truncation or changing saved data. Forecast horizons are bounded to 1–12, transaction
amounts must be finite and financial context must be nonnegative/finite. The private Python
container template uses one process, concurrency 4, one CPU and 1.5 GiB memory.

OCR remains bounded to two active jobs, three queued jobs, 30 seconds/job, 5 MB input,
20 MP decoded images and offline language data. Its 23-test suite passes, including actual
recognition (~968 ms in this run) and timeout termination (~220 ms). These are test fixture
timings, not before/after OCR performance or process-memory measurements. No unmeasured
memory improvement is claimed.

## Security review and fixes

Verified existing boundaries through source review and exercised regressions: signed HS256
HttpOnly sessions, session-version reset invalidation, stale-tab account header checks,
owner-scoped financial operations, proposal ownership/single execution, upload validation,
rate limits, non-reflecting public errors and per-owner analysis snapshots. No response or
private statement content was sent to external providers by tests; provider calls were
stubbed or disabled. This is a bounded application review, not a penetration-test clearance.

New origin-write guard refuses untrusted Origin and cross-site browser writes before route
execution. CORS alone previously controlled response readability; SameSite alone did not
exclude same-site sibling origins. Exact CORS origins must be configured; current production
Strict cookies require app/api same-site HTTPS. No-Origin non-browser clients remain subject
to authentication. Health is rate limited to 60 requests/minute/IP. Incoming finalization
fixes validate proxy settings, disable implicit production legacy JSON imports, add no-store
responses/DB health and drain HTTP before closing DB on shutdown. The JWT env template now
has an empty required secret rather than a usable placeholder. Actual private .env untouched.

Root full npm audit: zero findings. API full npm audit: zero findings. Vite is pinned 6.4.4;
Multer incoming fix is pinned 2.4.0. Clean Python application closure: 25 exact pins, pip check
passes, pip-audit reports no known vulnerabilities. Scanner initially rejected an invalid
CLI flag combination; that attempt is not counted. The corrected explicit pinned-requirements
scan completed successfully. The old global faculty interpreter still contains the previously
reported AnyIO/idna/python-dotenv/Starlette advisories; it was not upgraded. Use a separately
installed release venv for deployment. Known-advisory scans are not a guarantee of safety.

Secret scan examined 314 text candidates/outgoing-history blobs before the final report,
including local-secret literal matching without printing values and high-confidence token/
private-key patterns: no matches. No outgoing .env or private runtime JSON history path was
found relative to origin/main. Final candidate is rescanned before commit/push. This is a
bounded scanner, not proof that every possible secret format is detected.

## Verification

- 26 frontend test files pass; Intelligence now has 67 checks, forecast and account-isolation
  suites pass. The memo-disabled comparison also passes and records six renders.
- 24 server test files pass after isolating the one fixed-port collision. Security: 75 checks.
  Full final runner initially failed the holdings registration because my concurrent browser
  fixture occupied port 5198; stopped that fixture and reran unchanged suite: 50 checks pass.
- Gated password-reset DB test: 1/1 passes on a newly provisioned reset-test database.
- Patched Python: 42/42 tests. Synthetic evaluation: 416 records, health rules 46/46,
  plan rules 36/36. These are synthetic rule checks, not financial prediction accuracy.
- Lint and production build pass; git diff --check passes.
- Fresh source-only copy without .env, runtime data, node_modules or dist: npm ci at root/API,
  lint and production build pass. Exact committed-checkout verification follows before push;
  its outcome is recorded in the release receipt.
- Synthetic backup/restore: complete schema plus one synthetic account, pg_dump custom
  archive and pg_restore into a different new DB, verified owner account restored, 806 ms.
  Not a production restore test. All three owned backup/restore/reset DBs were removed.
- Real browser: synthetic sign-in/onboarding, lazy Dashboard, six-month Financial Intelligence,
  forecast details, exact server categories and new amount-range descriptions through the
  upgraded private Python at port 8197. Account A: 30 transactions, income ₹60,000/month,
  spending ₹24,750/month. After logout and account B login: empty analysis, no A results/chat.
  Browser fixtures and owned databases were stopped/removed. Existing user ML service was
  left running; only my separate patched test service is stopped at handoff.

## Cleanup, retained tooling and exact inventory

See CLEANUP_INVENTORY.md. The only deleted source file is the pre-existing, independently
confirmed unused src/components/Sidebar.css. No additional source deletion, private-data
deletion or dependency removal based on guesses. Tracked empty AGENTS.md/CLAUDE.md/GEMINI.md
and both tracked skills files remain useful user-owned development entry points. No root
agent/agents/.agent/.agents/.claude/.codex/IDE instruction folder was found to remove.
.gitignore was checked against tracked files, and .dockerignore excludes local material
from container contexts independently. Generated dist and private runtime files remain
ignored/local. Earlier reports and synthetic screenshots are intentionally retained.

Changed/added/deleted paths in this combined release (includes incoming user work):

- `.dockerignore`
- `.gitignore`
- `README.md`
- `compose.yaml`
- `docs/CLEANUP_INVENTORY.md`
- `docs/FINALIZATION_ADDENDUM_2026-10-16.md`
- `docs/FINALIZATION_REPORT.md`
- `docs/RELEASE_RUNBOOK.md`
- `docs/RELEASE_VERIFICATION.md`
- `docs/SECURITY_DEPLOYMENT.md`
- `docs/screenshots/finsphere-insights-synthetic.png`
- `docs/screenshots/finsphere-intelligence-synthetic.png`
- `ml_service/Dockerfile`
- `ml_service/main.py`
- `ml_service/models/clustering.py`
- `ml_service/models/forecaster.py`
- `ml_service/requirements.txt`
- `ml_service/tests/test_request_limits.py`
- `package-lock.json`
- `package.json`
- `server/.env.example`
- `server/Dockerfile`
- `server/db/index.js`
- `server/db/schema.sql`
- `server/holdings.js`
- `server/imageOcr.js`
- `server/importDuplicates.js`
- `server/package-lock.json`
- `server/package.json`
- `server/runtimeConfig.js`
- `server/server.js`
- `server/tests/runtimeConfig.test.mjs`
- `server/tests/runtimeConfigDb.test.mjs`
- `server/tests/security.test.mjs`
- `src/App.jsx`
- `src/components/PageBoundary.jsx`
- `src/components/Sidebar.css`
- `src/components/analytics/Analytics.css`
- `src/components/plans/AnalysisDetails.jsx`
- `src/components/plans/CurrentState.jsx`
- `src/components/plans/TopFindings.jsx`
- `src/context/FinanceContext.jsx`
- `src/hooks/useVoiceSession.js`
- `src/pages/Plans.css`
- `src/pages/Plans.jsx`
- `src/pages/Portfolio.jsx`
- `src/utils/actionConfirmation.js`
- `src/utils/finance.js`
- `src/utils/planIntelligence.js`
- `tests/insightsRevealCss.test.mjs`
- `tests/plansIntelligence.test.mjs`
- `vite.config.js`

## Remaining deployment requirements and risks

1. Docker is not installed here. No container, compose runtime or Oracle ARM64 build/smoke was
   performed. bcrypt includes a packaged linux-arm64 binary, but that is not runtime proof.
   Verify scientific wheels, native modules and real OCR on the target ARM64 host.
2. Set up host HTTPS, exact same-site app/API domains, real proxy chain/direct-access firewall,
   verified database TLS, least-privilege role, secrets and isolated Python networking. The
   compose template exposes API only on host loopback, not a public HTTPS endpoint.
3. Confirm Oracle capacity and CPU/RAM, deploy to staging, exercise load, health and graceful
   shutdown on Linux. The 3,000-row limit is a bound, not a worst-case load benchmark.
4. Spreadsheet parsing remains in-process: compressed expansion/parser exhaustion risk
   remains. Do not represent the authenticated upload limit as a parser sandbox.
5. Rate limits and analysis snapshots are in-process; use one API instance until shared state
   and distributed limits are provided. No full versioned down-migration system exists;
   startup DDL must be rehearsed on restored staging data, with a reviewed rollback plan.
6. Establish encrypted off-host backups, retention/alerts and full production-sized restore
   rehearsal. The local synthetic restore is only a method check.
7. Real Groq, mail delivery, microphone permissions, production cookies/CORS, host monitoring
   and production shutdown are unverified. Optional provider regressions do not prove live
   credentials or service availability. Subscription page retains documented sample content;
   portfolio is manual valuation, forecast limitations remain.

Follow RELEASE_RUNBOOK.md and the README's faculty startup/contingency. Keep the prepared
faculty environment separate, private and unchanged. If free hosting is unavailable, present
locally; no purchase, merge or deployment is required or authorized for this handoff.

## Independent review addendum (17 Oct 2026, one Windows machine, synthetic data, disposable databases)

Changes: Python analytics service returns a clean 422 for invalid input (a non-finite amount was HTTP 500; an oversized history was echoed back);
plan step CL-01 and cluster descriptions no longer claim a purpose for amount groups; API parse-failure logs record only the error name;
holdings valuation date allows one day past the UTC date (users east of UTC could not save a holding dated their local today between
00:00 and 05:30 IST); `public/_headers` adds nosniff, frame denial, referrer and permissions policies (no full CSP, see the runbook);
compose gives the API `mem_limit: 1024m`; the ML image installs wheels only.

Measured (not a load test): 3,000-row analysis 0.5 to 1.2 s, Python peak about 304 MB, no growth over repeats; saturated OCR queue peak about
290 MB, back to about 77 MB. No speedup is claimed. Re-run after the changes: lint, build, all frontend and server scripts (one gated database
test via a disposable database), Python 47 tests, npm audits (0), pip-audit of pinned requirements (clean), secret scan (no hits), Node 22.23.3 build
and suites, synthetic browser checks (26/26).

Not verified: Docker/compose/Oracle ARM64 execution, host HTTPS/proxy/cookies/CORS, database TLS and roles, real Groq/email/microphone,
production restore, multi-instance behaviour (rate limits and snapshots are per process), spreadsheet decompression limits.
