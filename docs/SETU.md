# Local Account Aggregator + UPI Simulator

FinSphere's "Financial Connections" feature (`src/pages/FinancialConnections.jsx`) lets a
logged-in user simulate linking external bank accounts and UPI apps, so a demo can show
synthetic, realistic financial data flowing into FinSphere's existing dashboard, transactions and
analytics - without ever touching a real bank, a real PAN registry, or a real UPI provider.

> This is a **ReBIT-inspired local Account Aggregator development simulator**, built for
> academic/demo purposes. It is not a certified Account Aggregator, not a real bank integration,
> and not a real UPI integration. The filename references Setu, a real Account Aggregator
> technical service provider, only because that is the shape of integration a future real
> provider would have - see "Future real-provider adapter" below.

## Why two services

```
                FinSphere (authenticated)
                         |
         ┌───────────────┴────────────────┐
         |                                 |
   aaRouter (/api/aa)              upiRouter (/api/upi)
         |                                 |
   AccountAggregatorProvider        upiSimulator.js
   (aaProvider.js)                  (in-process, per-user)
         |
   HTTP, server-to-server
         |
   aa_simulator/ (separate process, port 7100, no auth of its own)
```

The browser only ever talks to FinSphere's own authenticated API (`/api/aa/*`, `/api/upi/*`).
`aa_simulator/` is a second local process that stands in for what would otherwise be a real,
external Account Aggregator; only the main FinSphere server calls it, server-to-server. UPI has
no analogous real external protocol worth simulating as a separate service, so it lives directly
in the main server (`server/upiSimulator.js`) - one fewer moving part, same authentication and
per-user isolation as everything else in the app.

## PAN simulation

`POST /api/aa/pan/verify` forwards to the simulator's `/v1/pan/verify`. Accepts a demo token
(`DEMO-PAN-001`) or a real-shaped synthetic PAN (`ABCDE1234F`). Never contacts a real registry;
never stores the raw PAN, only a masked form (`*********001`) and a verification timestamp.

## Account discovery

`GET /api/aa/accounts` returns 10 synthetic accounts (HDFC/SBI/ICICI/Axis/Kotak/Canara/IDFC
FIRST, a fixed deposit, a recurring deposit, a mutual fund), normalized to:
```
{ institution, fipId, accountId, accountType, maskedAccountNumber, balance, currency, linked }
```
Refused with 409 until PAN verification has happened.

## Consent flow

```
POST /api/aa/consents            { accountIds?, purpose? }     -> PENDING
POST /api/aa/consents/:id/approve                               -> ACTIVE
POST /api/aa/consents/:id/reject                                -> REJECTED
GET  /api/aa/consents/:id
```
Every lookup checks that the consent belongs to the signed-in FinSphere user (derived
`aaId = fs-user-<userId>@finsphere.local`) before returning anything; a request for another
user's consent answers 404, exactly like this API's other ownership checks (e.g. transactions,
goals, liabilities).

## Financial Information request flow

```
POST /api/aa/fi-requests        { consentId }                   -> READY
GET  /api/aa/fi-requests/:id/status
GET  /api/aa/fi-requests/:id/data      (normalized accounts + transactions, synthetic: true)
POST /api/aa/fi-requests/:id/connect   -> inserts the normalized transactions into FinSphere
```

## Normalization into FinSphere's real data

`server/accountAggregatorNormalize.js` converts the simulator's AA/UPI transaction shape into
exactly the input `normalizeTransactionInput`/`createTransactionFor` already accept for a manual
or imported transaction: `{ title, amount, date, type, category, classification }`. Like a
statement import, an AA/UPI feed only knows direction (credit/debit), never the user's intent, so
`classification` is always `"unknown"` - never guessed as income/expense/refund/transfer.

`POST /api/aa/fi-requests/:id/connect` and `POST /api/upi/sync` both call `createTransactionFor`
- **the exact function `POST /api/transactions` already uses** - so a connected synthetic
transaction goes through the same validation, rounding and ownership stamping as any manually
entered one, and is stored in the same `transactions` table. There is no parallel storage, no
second transaction model, and no `source` tag persisted on the row: once connected, an
AA/UPI-sourced transaction is indistinguishable from a manual one, and immediately visible in the
existing Transactions page, Dashboard and Financial Intelligence/analytics.

Both routes are idempotent: reconnecting the same FI request, or re-syncing an already-synced UPI
app, inserts nothing new (tracked in small per-user, in-memory sets - lost on a server restart,
same as the rest of this simulator's state).

## UPI simulator

`server/upiSimulator.js` is a synthetic, per-user, in-memory UPI connection simulator: 4 demo
apps (Google Pay `demo@okaxis`, PhonePe `demo@ybl`, Paytm `demo@paytm`, BHIM `demo@upi`), each
generating 6 deterministic transactions once connected (seeded by `userId:appId`, so the same
user always sees the same transactions for the same app). It never calls a real UPI provider API.

```
GET  /api/upi/apps
POST /api/upi/apps/:id/connect | /disconnect
GET  /api/upi/transactions
GET  /api/upi/summary            { connectedApps, transactions, totalSpent, totalReceived }
POST /api/upi/sync                -> normalizes connected apps' transactions into FinSphere
```

## Per-user isolation

Every route requires the same session cookie as the rest of FinSphere (`authenticate`
middleware - never weakened or bypassed). All AA/UPI state is keyed by the authenticated
FinSphere user id, never a client-supplied identifier, and every consent/FI-request lookup is
checked against that derived id before any data is returned. Verified end-to-end in
`server/tests/financialConnectionsServer.test.mjs`: one user's session gets 404 on another
user's consent or FI request, and UPI connections never leak between accounts.

## Future real-provider adapter

FinSphere's routes talk only to the `AccountAggregatorProvider` interface defined in
`server/aaProvider.js` (`verifyPan`, `discoverAccounts`, `createConsent`, `getConsent`,
`approveConsent`, `rejectConsent`, `createFiRequest`, `getFiRequestStatus`, `getFiRequestData`),
never directly to `aa_simulator/`'s HTTP API. A future real, ReBIT-certified Account Aggregator
(for example a provider like Setu) would be added as a second class implementing that same five-
method-shaped interface and selected via the `AA_PROVIDER` environment variable (today only
`"local"` is implemented); none of the routes in `server/financialConnections.js`, the
normalization logic, or the `FinancialConnections.jsx` page would need to change.

## Running the whole stack locally

```
# Terminal 1: the AA simulator (synthetic data, no auth)
cd aa_simulator && npm install && npm start            # http://localhost:7100

# Terminal 2: the main FinSphere server
cd server && npm install && npm start                  # http://localhost:5000
# (AA_SIMULATOR_URL defaults to http://localhost:7100)

# Terminal 3: the frontend
npm install && npm run dev                              # http://localhost:5173
```
If the AA simulator isn't running, `/api/aa/*` routes answer `503` with a clear message instead
of crashing the main server; UPI (in-process) is unaffected either way.

## Demo flow

1. Sign in, open **Connections** in the top nav.
2. **Start Connection** -> enter a PAN (the field is pre-filled with `DEMO-PAN-001`) -> Continue.
3. 10 synthetic accounts load; use Select all / Deselect / individual checkboxes, then Continue.
4. Review the Account Aggregator Consent screen (purpose, date range, selected account count,
   consent id) -> **Approve Consent**.
5. The request moves through "Requesting financial information..." to a connected confirmation
   showing how many synthetic transactions were added, plus the FI request id.
6. Back on the overview, the Account Aggregator card and the connection checklist now show the
   connected state; the new transactions are visible on the real Transactions page.
7. Open **Manage UPI**, connect one or more of the 4 demo apps, review the UPI Activity summary
   and transaction list, then **Synchronize** to add them into FinSphere's transactions too.

## Testing

- `aa_simulator/npm test` - 33 checks against the simulator alone.
- `server/npm run test:financial-connections` - 41 checks against the real authenticated API
  (spawns a disposable Postgres database and real instances of both services).
- `npm run test:financial-connections-ui` (repo root) - 21 checks rendering the actual React page
  against a minimal fake backend.
- All three are included in each package's `test:all` runner.

## Intentional limitations

- All AA/UPI/connection state is in-process memory; it does not survive a server restart (this is
  a local development simulator, not a persistence layer).
- PAN "verification" is a format check plus a synthetic success response - no external registry
  is ever contacted.
- UPI "connections" never touch a real Google Pay/PhonePe/Paytm/BHIM account or API.
- The FI request lifecycle (`CREATED -> PROCESSING -> READY`) resolves synchronously, since there
  is nothing to actually wait on for synthetic data; the status/data endpoints stay separate so a
  real provider's genuinely asynchronous version can be swapped in without changing the client.
