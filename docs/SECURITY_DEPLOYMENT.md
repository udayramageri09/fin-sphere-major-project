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
| `GROQ_ACTION_MODEL` | optional model for the assistant-action fallback (section 10) | defaults to `openai/gpt-oss-120b` (sent with `reasoning_effort: low`, which GPT-OSS models need to fit the 250-token cap). |
| `ASSISTANT_ACTION_LLM` | kill switch for that fallback | `off` (also `false`, `0`, `disabled`) turns the structured extractor off completely; the deterministic parser keeps working. |

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

## 10. Confirmed assistant actions (Issues #73, #75, #77 and #79)

When the assistant adds a transaction, adds to a goal, records a liability repayment or sets a budget, the chat message never writes anything by itself:

* **Server-issued proposals.** The server stores a proposal (the validated payload, the resolved goal id and an exact preview) in `assistant_action_proposals`, owned by the signed-in user. The payload and ownership stay server-side.
* **The client confirms only a proposal id.** `POST /api/assistant/actions/:id/confirm` and `/cancel` take the id from the URL; any request body is ignored, so a client cannot alter the amount, title, goal or owner.
* **Short-lived and single-use.** A proposal lives about 3 minutes (judged by the database clock) and can be executed once. Confirmation first does an atomic `pending` to `executing` update, so of any number of simultaneous confirmations exactly one runs. Confirming again returns the stored result and never writes twice.
* **Ownership.** Another user's proposal id behaves as not found (404), the same as a missing one.
* **Rate limiting.** Confirm and cancel share a per-user limit of 30 requests per minute.
* **Same validation as manual writes.** Execution calls the existing validators and owner-scoped database helpers, including the row lock that re-checks a goal's target at execution time.
* **Liability repayments use the existing locked execution.** A confirmed repayment runs the same `repayLiability` transaction as the manual route (owner-scoped row lock, exact numeric checks). If the balance moved after the preview but the user's exact amount is still valid, it executes and reports the actual resulting balance; if the amount no longer fits, it is refused and nothing is written. The amount is never resized, and a liability's monthly payment is never used as the amount. A repayment does **not** create an expense transaction.
* **Budgets: compare-and-set after a preview, plain upsert for the manual form.** An assistant budget write only happens if the budget still matches what the user was shown: a new budget is inserted only if none exists yet, and an update only applies while the amount is still the previewed one. Otherwise nothing is written and the user is told it changed. The manual `PUT /api/budgets` is unchanged: it remains an ordinary upsert that overwrites an existing budget (and its label).
* **Month names without a year always ask for the year.** The assistant resolves "this month", "next month" and "last month" from the browser's local date, and accepts `YYYY-MM` or "October 2026"; "October" alone is never given a year.
* **Proposal kinds are enforced by the database.** `assistant_action_proposals.kind` has a named check constraint that startup migrates idempotently, so a database created before #75 accepts the new kinds without manual steps.
* **Natural-language understanding (Issue #77) adds no authority.** The deterministic parser stays first and preferred. Before it runs, a normalization layer (`server/actionNormalization.js`) fixes typos and speech slips in action keywords (a curated alias table such as `payed`→`paid`, `lon`→`loan`, plus a small keyword-only edit-distance backstop), reads spoken amounts (`server/numberParser.js`: "five thousand", "one and a half lakh", "six five zero zero") with exact BigInt arithmetic, and keeps a log of every correction. It never touches digits or amounts, never rewrites the user's own goal, loan or budget names (they are passed in as protected), and never creates income, expense, refund, transfer or confirmation words. What was corrected or heard is shown on the preview card as an "Interpreted" row.
* **Money phrases fail safe.** A number followed by a dangling fraction ("2 and a half") is read as a whole phrase ("2 and a half thousand" = ₹2,500) or reported as unclear and asked about; it is never accepted as the bare leading number. Two spoken digits ("six five"), mixed forms ("6 five 00"), "million" and "billion" are asked about, never guessed. Number words only count in a money slot (a currency marker, a scale word such as thousand or lakh, or a payment verb right before them), so "Five Guys" or "Two Wheeler" are not amounts.
* **Fuzzy names are always a question.** Candidate goals, loans and budget labels are ranked by `server/entityMatcher.js` (exact, whole-word overlap, then edit-distance and trigram similarity; strong at 0.85, weak at 0.60, at most five). A fuzzy candidate is never selected automatically, even when it is the only one: the assistant asks "Did you mean …?" and only the user's answer continues. A name reached through a typo correction ("bike lon") is treated the same way.
* **Optional structured language-model fallback.** Only for a new, action-like message that the deterministic parser did not understand, and only when `GROQ_API_KEY` is set and `ASSISTANT_ACTION_LLM` is not `off`. `server/structuredActionExtractor.js` sends the model **only the current message** (no chat history, balances, goals, loans, budgets, transactions or entity names, and no tools) at temperature 0 with a 4 second timeout, and asks for one JSON object with a closed schema (`intent`, `amount`, `direction`, `title`, `target`, `date`, `month`, `missing`, `ambiguous`). Any unknown key rejects the whole output; ids, user ids, proposal ids, confirmation or execution fields, SQL, routes, commands and a confidence score do not exist in the schema and are rejected if sent. Provider correctness is not assumed: the output is always validated locally.
* **The model's output is evidence to be checked, not a decision.** `server/provenanceValidator.js` requires every returned span to appear verbatim in the user's message, re-parses the amount phrase itself (a model number is never used, and a different amount found by the deterministic parser is a conflict that is asked about), derives the direction only from words the user wrote, and resolves dates and months on the server from the browser's local date and only when the span really says "yesterday", "next month" and so on. A month name still asks for the year. The intent must also agree with the user's own words or with one of their own entities; otherwise the assistant asks what the payment is for. The verified fields then go through the same entity resolution, validation, preview and explicit confirmation as every other action.
* **The model is never in the confirmation path.** It is not called while a proposal or clarification is open, for confirm or cancel, for edits ("yeah make it 600 instead" is parsed by rules and creates a new proposal that must be confirmed again), or when the deterministic parser already succeeded. A model that is unavailable, slow, rate-limited, malformed or wrong falls back to deterministic behaviour (a short hint if the message clearly looked like an action, otherwise normal chat); it never fails open. Failures log only an error name or HTTP status, never the user's message or the key.
* **Adding a liability (Issue #79).** `create_liability` follows the same rules as every other action: the chat message writes nothing; the server stores a proposal (validated input plus a liability id fixed when the proposal is built; no owner field); only the confirm endpoint, by proposal id, creates the row. Execution derives the owner from the session, runs `normalizeLiabilityInput` again, and inserts with `INSERT ... ON CONFLICT (user_id, id) DO NOTHING`, returning the existing owned row on a conflict, so even a repeated execution of the same proposal can produce **one** liability. A replayed confirmation returns the stored result; an expired, cancelled or foreign proposal writes nothing. The manual `POST /api/liabilities` uses the same helper with a fresh id and is otherwise unchanged (duplicates by name are still allowed there).
* **All five fields, never guessed.** Name, type, outstanding balance, interest rate and monthly payment are required; the assistant asks for each missing one (a stated 0 is accepted for the rate and the payment). The name is generated from the user's own words and the type ("HDFC Personal Loan"), shown on the card and editable ("call it …"); an existing liability with the same name needs an explicit yes, and nothing is merged or renamed automatically. A borrowed amount ("I took a 5 lakh loan") is not assumed to be today's balance. A term or lender mentioned is not stored (no columns); the card says so.
* **Creation is told apart from repayment by strict grammar.** "Add my car loan of 8 lakh", "I have a car loan of 8 lakh" and "I borrowed 5 lakh from SBI" create; "add ₹5,000 to my car loan", "paid 5k on bike loan" and "paid my car EMI 6500" stay repayments (an amount joined to an existing liability by to/toward/on/against/into, or a payment verb, is never a creation). The language-model fallback may not call a creation sentence a repayment, and vice versa.
* **Numbers have roles.** For a new liability each number is classified once (balance, rate, payment, term) from the words around it; `11.5%` and `3 years` are never read as money. If two amounts have no role they are asked about, never ranked.
* **The extractor stays data-free.** The structured fallback gains an intent (`create_liability`) and three verbatim span fields (`rate`, `payment`, `term`); there are no ids, no type or lender fields and no numeric values from the model. The server grounds every span, requires rate and payment evidence, keeps the rules' role assignment authoritative (a disagreement becomes a question), and still sends the model only the current message.
* **Known limitation.** If the process or database fails after a proposal is claimed but before its result is saved, the proposal stays in `executing`. It fails safe (it is never replayed automatically, so nothing can be written twice), but the user sees "already being processed" until it is asked for again.

## 11. Known remaining risks

See the final section of the Issue #67 report; in short: ML service isolation is a deployment responsibility, in-memory rate limits, no CSRF token beyond SameSite, no parser sandbox, CDN-hosted `xlsx` tarball, no Python vulnerability scanning, and Python `main.py` still labels clustering "KMeans" (wording only).
