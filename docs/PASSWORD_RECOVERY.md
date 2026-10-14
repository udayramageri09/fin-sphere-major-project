# Password recovery

Configure `RESEND_API_KEY`, `PASSWORD_RESET_FROM` (a verified sender) and
`PASSWORD_RESET_URL` (the exact trusted frontend URL). Delivery uses Resend's
HTTPS email API: https://resend.com/docs/api-reference/emails/send-email.
HTTPS is required except localhost HTTP in development. URLs cannot contain
credentials, query parameters or fragments. Never derive reset URLs from request headers.
Without these settings, recovery returns a generic 503 and existing login still works.
`PASSWORD_RESET_DELIVERY` selects the delivery mode: `resend` (the default, also when unset) or `local`
(development only, see below). The mode is never inferred: missing Resend settings are never replaced by
local capture, and any other value stops the server at startup.

`POST /api/auth/forgot-password` accepts `{email}`. Valid requests return the same
202 message before account lookup/delivery. The IP limit is 5 per 15 minutes;
a database-enforced account cooldown is one minute, including requests from other IPs.
Email delivery runs after the response, with a 10-second timeout. This small
implementation has no durable queue: a process interruption or provider failure may
lose delivery. The user can retry after the cooldown. Errors never log recipients,
tokens, links or provider bodies. No actual emails are sent by automated tests.

Links contain a 256-bit random token in the URL fragment (not sent to the web server).
The frontend removes the fragment from browser history and holds it in memory.
Reloading the reset view requires reopening the email link. Opening a link while
already logged in still shows the reset form. Reset success prompts explicit login.

`POST /api/auth/reset-password` accepts `{token,password}`. Passwords require eight
characters and at most 72 UTF-8 bytes (bcrypt's input limit). Only SHA-256 token
digests are stored. Links expire after 15 minutes, a new issued link replaces the
previous one, and a single conditional UPDATE consumes the token and changes the
password atomically. No automatic login occurs. A version increment revokes all
previous sessions; auth middleware and `/auth/verify` check that version against
PostgreSQL. Legacy JWTs without a version count as version zero until first reset.

Schema changes add four nullable/defaulted user columns and a partial index. No
financial tables or existing user IDs/hashes are changed. Startup applies the usual
idempotent schema. This feature does not deploy or run migrations against a live DB.

## Local development delivery (no verified Resend domain)

**Development only.** To try Forgot Password on your own machine without a verified Resend domain, set
`PASSWORD_RESET_DELIVERY=local` in `server/.env` (optionally with `PASSWORD_RESET_URL`; it defaults to
`http://localhost:5173/`) and restart the API. In this mode:

* No email is sent and Resend is never called, even if Resend settings are also present.
* The message (the same subject and text Resend would send) is kept **in the API process's memory only**: the 20 most recent
  messages, lost on restart. It is never written to a log, a file or the database, and the reset link or token is never printed.
  The server prints one startup warning that mail is captured locally.
* Nothing else changes: the 256-bit token, SHA-256 digest at rest, 15-minute expiry, replacement of the previous link, the
  one-minute account cooldown, atomic one-time consumption, `session_version` revocation and the identical generic 202 response
  for known and unknown accounts. Only an existing account produces a captured message, so the capture route itself reveals
  whether an address is registered: another reason it is development-only.

**Reading the captured email.** Open `http://localhost:5000/api/dev/password-reset-mail` (your API port) in a browser on the
same machine; add `?email=you@example.com` to filter. It returns JSON, newest first:
`{ "mails": [{ "to", "subject", "text", "link", "capturedAt" }] }`. Open `link` to reach the reset form. `DELETE` on the same URL
clears the captured mail. The route exists only in local mode, and even then it answers `404` (as if it did not exist) unless
`NODE_ENV` is not `production`, the TCP peer is the loopback interface (the raw socket address; `X-Forwarded-For` is ignored)
and the `Host` header is `localhost`, `127.0.0.1` or `[::1]` (so a web page on another origin cannot read it through DNS
rebinding). It exposes only captured test mail, never configuration, API keys or passwords.

**Production.** `PASSWORD_RESET_DELIVERY=local` with `NODE_ENV=production` makes the server refuse to start, so the capture
mode and its route cannot exist in production. Production keeps using Resend exactly as above.

**Manual test.** 1) Set `PASSWORD_RESET_DELIVERY=local`, start the API (`npm run dev` in `server`) and the frontend.
2) Register an account, log out, choose "Forgot password" and submit that address: the page shows the generic message.
3) Open the capture URL above, copy the `link` and open it. 4) Set a new password, then log in with it; the old password and
any older session no longer work, and the link cannot be used twice.

Run `npm run test:password-reset` from `server`. The PostgreSQL test requires
`FINSPHERE_RESET_TEST_DATABASE_URL` pointing to a newly created disposable database
named `finsphere_reset_test_<digits>`. It refuses other database names and checks
expiry, cooldown, replaced links, concurrent consumption, password comparison,
and session revocation. `npm run test:password-reset-local` (a throwaway database it creates and drops itself) starts the
real server in each delivery mode and checks the local capture flow end to end, including that the production refusal, the
loopback and Host guards hold and that no token, link or address reaches the server log. Existing security, Groq, financial and action tests remain.

Next feature: JPG/JPEG/PNG statement upload into the existing statement-import
pipeline. Google login remains lower priority.
