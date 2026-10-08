# Security and deployment notes

What the current code does for production, what you must configure, and what is still open. Written from `server/server.js`, `server/db/index.js`, `ml_service/main.py` and the dependency audit run for Issue #67 (see section 9).

## 1. Required and recommended environment (API, `server/.env`)

| Variable | Purpose | Behaviour |
|---|---|---|
| `JWT_SECRET` | signs session tokens | **required**, at least 32 characters; the server refuses to start otherwise. There is no default. |
| `DATABASE_URL` | PostgreSQL connection | **required**; the server refuses to start without a reachable database. |
| `NODE_ENV=production` | production mode | cookie becomes `Secure` + `SameSite=Strict`; database TLS is on and verified. |
| `CORS_ORIGINS` | browser origins allowed to call the API | comma-separated exact origins (e.g. `https://app.example.com`). Unset in development: only `http://localhost:5173`. **Unset in production: no cross-origin browser access** (a warning is logged). `*` is refused at startup. |
| `TRUST_PROXY` | reverse-proxy hops in front of the API | set to e.g. `1` behind one load balancer so rate limits see real client IPs. Not set: `req.ip` is the proxy. A bare `true` is refused (it would let clients spoof their IP). |
| `DATABASE_SSL`, `DATABASE_SSL_CA` | database TLS | verified TLS is on in production; `DATABASE_SSL=false` for a private network without TLS; `DATABASE_SSL_CA` for a private CA. Verification is never disabled. An explicit `sslmode` in the URL is honoured. |
| `ML_SERVICE_URL` | where the API finds FastAPI | default `http://localhost:8000`. |
| `GROQ_API_KEY` | optional LLM | placeholder values are treated as "not configured". |

Frontend: `VITE_API_URL` is baked in at build time (`.env.example`). No secret may be placed in a `VITE_` variable.

Secrets live only in untracked `.env` files (`.gitignore` excludes `.env` and `.env.*` except `.env.example`); the example files hold placeholders only. Rotate any secret that was ever committed.

## 2. Authentication

* Session = JWT in an `httpOnly` cookie. Signed and verified with **HS256 only** (`algorithms` is pinned, so `none` and other algorithms are rejected). Expiry 1 hour. Malformed, expired, wrong-secret and wrong-algorithm tokens give 401.
* Every data route derives the owner from the verified token (`req.user.id`), never from the request body or URL.
* Passwords: bcrypt (cost 10), minimum 8 characters. Register and login are limited to 15 attempts per 15 minutes per IP.
* **Cross-site deployment caveat.** The cookie is `SameSite=Strict` in production. That works when the frontend and API are the same site (for example `app.example.com` and `api.example.com`). If they are on different registrable domains (for example two unrelated `*.onrender.com`-style hosts) the browser will not send the cookie and login will appear to fail. This is deliberately not loosened here, because `SameSite=None` weakens CSRF protection; choose a same-site layout, or treat it as a separate, reviewed change.
* There is no CSRF token. Protection rests on `SameSite=Strict` plus the exact-origin CORS list; JSON bodies are required for state changes.

## 3. Transport and headers

Helmet is enabled: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-*` policies, and `X-Powered-By` removed. The API serves JSON only, so these defaults do not affect the SPA, which is served separately. TLS itself must be terminated by the host or proxy.

## 4. Limits

| Surface | Limit |
|---|---|
| JSON body | 100 kB (413 above) |
| Statement upload | one file, 5 MB, `.csv` `.txt` `.xls` `.xlsx` only (other extensions: 400); memory storage, nothing written to disk |
| Register / login | 15 per 15 minutes per IP |
| Statement upload / parse | 10 per minute per signed-in user |
| Assistant (`/api/chat`, `/api/plan-chat`) | 30 per minute per signed-in user |
| ML analysis (`/api/ml/analyze`) | 10 per minute per signed-in user |
| Ordinary reads and writes | not limited |

Limits are in memory and per process; with several instances use a shared store (for example Redis). The extension check is by file name, not by content; the content is then parsed defensively and validated row by row.

## 5. Errors and logging

Responses never include stack traces or SQL; unhandled errors, malformed JSON, oversized bodies and bad uploads return JSON. Logs record error codes/messages, not request bodies, financial values, tokens or the database URL.

## 6. Database

All queries are parameterised. The pool is capped at 10 connections with a 10 s connect timeout. In production TLS to PostgreSQL is verified (see the table above). Use a least-privilege database role.

## 7. The FastAPI service is internal and unauthenticated

Express is the trust boundary. `ml_service` has **no authentication** and trusts any transactions it receives. It must never be reachable from the public Internet.

* When started with `python main.py` it binds to `127.0.0.1` and does not auto-reload. Override with `ML_SERVICE_HOST`, `ML_SERVICE_PORT`, `ML_SERVICE_RELOAD=true` (development only). If you set `ML_SERVICE_HOST=0.0.0.0` (needed in a container), you must restrict access with a private network, security group or firewall. If you start it with `uvicorn main:app` yourself, choose the `--host` deliberately.
* Its CORS list (`localhost:5173`, `localhost:5000`) is irrelevant to server-to-server calls and is not an access control.
* This repository does not provide network isolation. The deployment platform must.
* `POST /api/plan-chat` takes ML results from the client; they only change what the assistant says, not stored data.

## 8. Spreadsheet uploads

Statement parsing uses SheetJS (`xlsx`). The npm registry copy (0.18.5) has known high-severity advisories (prototype pollution, ReDoS) and no patched npm release; this project uses the vendor's patched **0.20.3** tarball from `cdn.sheetjs.com`, pinned by URL and integrity hash in `server/package-lock.json`. Residual risk: a small compressed `.xlsx` can expand when parsed (a "zip bomb"). Mitigations are authentication, the 5 MB limit, the per-user rate limit and the extension filter; there is no parser sandbox or row cap. Moving parsing to a worker/process with memory and time limits, or dropping spreadsheet support in favour of CSV, is the recommended follow-up.

## 9. Dependency audit status

`npm audit --omit=dev`: 0 vulnerabilities in the API (`server/`) and in the frontend (root). Re-run before each release. `ml_service/requirements.txt` uses minimum versions (`>=`) rather than pins and has no automated vulnerability scan; pin and scan it in CI for a real deployment.

## 10. Known remaining risks

See the final section of the Issue #67 report; in short: ML service isolation is a deployment responsibility, in-memory rate limits, no CSRF token beyond SameSite, no parser sandbox, CDN-hosted `xlsx` tarball, no Python vulnerability scanning, and Python `main.py` still labels clustering "KMeans" (wording only).
