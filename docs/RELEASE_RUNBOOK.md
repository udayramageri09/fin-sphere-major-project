# Release rehearsal and deployment runbook

This is a deployment candidate, not a public deployment clearance. Never point checks at
`finsphere_faculty_demo_20261015` or `finsphere_report_kit_20261016`.

## Build and network topology

Use Node 22 and Python 3.12. Run `npm ci`, `npm --prefix server ci`, lint,
the frontend/backend suites and the Python suites before packaging. Install Python in a
fresh virtual environment; keep the faculty interpreter untouched. Run dependency audits.

For Cloudflare Pages: repository root, build command `npm run build`, output `dist`,
Node 22. Set `VITE_API_URL=https://api.YOUR-DOMAIN.in/api` **before** building.
VITE variables are public: never put secrets in them. Rebuild when changing this URL.
Cloudflare Pages' default SPA fallback applies when there is no top-level 404.html.
Verify direct navigation, login, cookies, account switches and a refreshed page on the
actual host before accepting a release.

`public/_headers` is copied to `dist/_headers` by the build and Cloudflare Pages applies it to
every path: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
strict-origin-when-cross-origin`, `Permissions-Policy` (camera, geolocation and payment off,
microphone allowed for this site because the voice assistant needs it) and `Content-Security-Policy:
frame-ancestors 'none'`. It is deliberately **not** a full Content-Security-Policy: a script/connect
policy needs the final API origin and has not been exercised in a browser against the real host.
Candidate to try in **staging** with the browser console open, then tighten or loosen from the
reported violations (never enable it unobserved): `default-src 'self'; script-src 'self'; style-src
'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'
https://api.YOUR-DOMAIN.in; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors
'none'`. `'unsafe-inline'` for styles is expected (React style props); `blob:` images are the profile
photo. This candidate is untested. Cloudflare Pages is separate from the API: the API's own
headers (Helmet) only protect API responses.

Use `app.YOUR-DOMAIN.in` and `api.YOUR-DOMAIN.in` over HTTPS. The current Strict cookie
requires the frontend and API to be same-site. A pages.dev frontend and unrelated Oracle
hostname are unsuitable for this cookie configuration. Use the custom frontend domain.
Set CORS_ORIGINS to the exact HTTPS app origin. Set TRUST_PROXY only after verifying the
actual proxy chain and blocking direct public access to port 5000. Browser write origins
are checked independently of CORS. No-Origin non-browser clients still require auth.

The compose template exposes only API loopback port 5000; Python has no published port,
uses an internal network and one process. A host HTTPS reverse proxy must be configured
separately. Set an external/reachable PostgreSQL URL; `localhost` in a container refers
to that container, not Windows or the Oracle host. Never copy demo .env into production.
Use verified PostgreSQL TLS and a dedicated database/role; secrets live outside Git.

From the repository root, review `docker compose config --quiet`, then build only after
approval to deploy. For ARM64, validate with `docker buildx build --platform linux/arm64
-f server/Dockerfile .` and the equivalent ML Dockerfile. Base images have no x86-only
platform override; actual native bcrypt/scientific wheel installation and OCR must be
tested on Oracle ARM64. Docker is unavailable on the current verification machine, so
these images and compose have not been executed. Do not treat the template as ARM64 proof.

What *was* checked without Docker (availability only, not runtime): PyPI metadata shows a prebuilt
Linux **aarch64 and x86_64** wheel (or a pure-Python wheel) for every one of the 25 pins in
`ml_service/requirements.txt`, including numpy, pandas, scipy, scikit-learn and pydantic-core;
the ML image therefore installs with `--only-binary=:all:` and fails loudly instead of compiling.
On the Node side `bcrypt` 6.0.0 ships `linux-arm64` glibc and musl prebuilds (the image is
Debian/glibc) and every other API dependency is pure JavaScript or WebAssembly (Tesseract.js).
`compose.yaml` was parsed as YAML (API published on loopback only, analytics on an internal
network with no published port). Verify on the target: `npm ci --omit=dev` in the API image,
`pip install` in the ML image, real OCR of an image, and `GET /api/health` / `/health`.

## Capacity bounds (measured on one Windows machine, synthetic data, not a load test)

* **Financial Intelligence, 3,000 rows (the limit):** one analysis took about 0.5 to 1.2 s; the
  private Python process peaked at about 304 MB and did not grow over three repeats; the API
  peaked at about 94 MB. The container limit for the analysis service is 1,536 MB. 3,001 rows are
  refused with HTTP 422 and the exact message "Analysis supports up to 3000 transactions per
  account."; the saved ledger is untouched. Ward clustering is quadratic, so do **not** raise the
  limit without repeating this measurement at the new size.
* **OCR, saturated queue:** two active plus three queued 20-megapixel images took the API from about
  72 MB idle to about 290 MB peak and back to about 77 MB six seconds later; jobs finished in
  1.9 to 4.4 s. `compose.yaml` sets the API to `mem_limit: 1024m`, about 3.5 times that peak. The
  limit is not container-verified; the timeout path (30 s per job) is covered by unit tests, not by
  this memory run.
* The private Python service now answers a refused request with a clean 422 that names the field
  and reason only. Previously a non-finite amount produced HTTP 500 and an oversized history was
  echoed back in full.

## Database migration, backup and restore

Startup executes idempotent schema DDL under an advisory lock. It is not a versioned down
migration framework. Review `server/db/schema.sql` against a disposable restored copy
before each release. Do not grant production startup credentials access to demo databases.
Set IMPORT_LEGACY_JSON=false explicitly. Never mount private legacy JSON into an image.

Use PostgreSQL service configuration or PGPASSFILE outside the repository instead of
putting passwords into command history. Select a production-only PG service name.
Before rollout: `pg_dump --dbname=service=finsphere_prod --format=custom --file=BACKUP_PATH`.
Store encrypted backups outside the host/repository with restricted access and retention.
Check the archive with `pg_restore --list BACKUP_PATH`; this alone is not a restore test.
Restore into a newly created disposable database with `pg_restore --dbname=service=RESTORE_TEST
--no-owner --no-acl BACKUP_PATH`, then verify account totals and all major workflows.
Do not restore over a live or protected database. Record recovery duration and retain
the backup until the release and restore exercise have been accepted.

## Rollout and rollback

No rollout is authorized yet. Record the reviewed Git SHA, immutable image IDs, env version,
database backup and frontend build. Rehearse on separate staging data first. Probe API
/api/health (database only) and private Python /health, then perform real HTTPS browser
checks, synthetic account isolation, import/OCR, analysis, provider and mail checks.
Use one API instance until rate limits/snapshot state have shared storage.

On failure stop new traffic, retain logs without financial payloads, and restore the prior
frontend build and API/ML image pair. Verify schema compatibility before starting the old
API. If incompatible, restore the pre-release backup into a **new** database and switch
the connection only after explicit owner approval; account for writes since the backup.
Do not run destructive rollback SQL or reset Git. Alert on health failures, restarts,
timeouts, queue saturation and disk/backup failures without recording statements or tokens.

## Faculty contingency

Keep the prepared faculty and report databases and their credentials/scripts unchanged.
For the presentation use the validated local interpreter and a fresh frontend build.
Keep localhost services private. If Oracle lacks free capacity, demonstrate locally and
schedule a paid-host decision later; no purchase is needed for the faculty demonstration.
When ML or an external provider is unavailable, show its unavailable/fallback state and
explain the limitation; never substitute invented analysis. Follow README troubleshooting.


Reference: [Cloudflare Pages serving and SPA fallback](https://developers.cloudflare.com/pages/configuration/serving-pages/),
[Vite 6 release and compatibility](https://vite.dev/blog/announcing-vite6).
