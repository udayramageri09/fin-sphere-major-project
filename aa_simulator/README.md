# FinSphere Local Account Aggregator Development Simulator

A ReBIT-inspired **local** simulator of an Account Aggregator (AA) for academic and demo use.
It is **not** a certified Account Aggregator, a real bank connection, or a real PAN verification
service. Every account, balance, PAN and transaction it produces is synthetic.

This package (`aa_simulator/`) stands in for the one external thing a real integration would be:
a separate HTTP service FinSphere's own backend talks to. The main FinSphere server never embeds
this logic directly - see `docs/SETU.md` for how the two sides fit together and how the
integration is normalized into FinSphere's real data model.

## Architecture

```
PAN simulation  ->  Account discovery  ->  Consent  ->  FI request  ->  FI data
   (masked)          (10 synthetic          (PENDING /    (CREATED /     (accounts +
                       accounts)            ACTIVE /       PROCESSING /   transactions,
                                             REJECTED)      READY)        synthetic:true)
```

State is kept in three in-memory `Map`s (`customers`, `consents`, `fiRequests`) and does **not**
survive a restart of this process. Any `aaId` is auto-provisioned on first touch with the same
10 synthetic accounts (`mockData.js`'s `createAccounts()` is a pure function of no random input),
so restarting the simulator reproduces the same catalog for a given `aaId` - "the same demo
customer gets predictable results." Generated transaction *dates* are relative to "now" (not a
frozen calendar date), so the demo never shows stale-looking history months or years later.

## PAN simulation

`POST /v1/pan/verify` accepts either a demo token (`DEMO-PAN-001`..`DEMO-PAN-999`) or any
real-shaped synthetic PAN (`ABCDE1234F`). It never contacts an external PAN registry; it just
checks the shape and marks the aaId "VERIFIED". Only a **masked** representation
(`*********001`) and a verification timestamp are ever stored - the raw PAN exists only for the
duration of that one request. Account discovery and consent creation are both refused (409) until
PAN verification has happened, matching the real-world ordering.

## Account discovery

`GET /v1/customers/:aaId/accounts` returns exactly 10 synthetic accounts spanning savings,
current, a fixed deposit, a recurring deposit and a mutual fund, each with a masked account
number, a balance, and `linked: true`. See `mockData.js:createAccounts()`.

## Consent lifecycle

```
POST /v1/consents                        -> PENDING
POST /v1/consents/:id/approve            -> ACTIVE   (409 if already approved/rejected)
POST /v1/consents/:id/reject             -> REJECTED (409 if already approved/rejected)
GET  /v1/consents/:id
```
A consent records the accounts selected, a purpose and a date range. Every write is a real
mutation of in-memory state, not a cosmetic "always succeeds" button.

## FI request lifecycle

```
POST /v1/fi-requests          (requires an ACTIVE consent, else 409; unknown consent -> 404)
GET  /v1/fi-requests/:id/status
GET  /v1/fi-requests/:id/data  (accounts + transactions for the consented accounts, synthetic: true)
```
Generation is deterministic and synchronous (there's nothing to actually wait on for synthetic
data), so a request is `READY` immediately; the status/data endpoints stay separate so a client
polls them exactly as it would against a real provider.

## Mock accounts and transactions

`mockData.js` generates 10 accounts (HDFC/SBI/ICICI/Axis/Kotak/Canara/IDFC FIRST savings and
current accounts, an HDFC fixed deposit, an SBI recurring deposit, and a mutual fund) and, per
account, 4 transactions (one salary-style credit, three varied debits) with different amounts,
categories and dates per account - not 40 identical rows.

## UPI simulator

UPI is **not** part of this package. It lives in the main FinSphere server
(`server/upiSimulator.js`), authenticated like the rest of FinSphere's API, with no second
unauthenticated network hop. See `docs/SETU.md`.

## Synthetic data policy

- No real bank account numbers, PANs, Aadhaar numbers or credentials, ever.
- No external network calls of any kind (no PAN registry, no bank, no UPI provider).
- Every response that carries generated data marks itself `synthetic: true` where applicable.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + `syntheticOnly: true` |
| POST | `/v1/pan/verify` | Simulated PAN verification |
| GET | `/v1/pan/:aaId` | Current PAN status for an aaId |
| GET | `/v1/customers/:aaId/accounts` | Discover the 10 synthetic accounts (requires verified PAN) |
| POST | `/v1/consents` | Create a consent (PENDING) |
| GET | `/v1/consents/:id` | Read a consent |
| POST | `/v1/consents/:id/approve` | PENDING -> ACTIVE |
| POST | `/v1/consents/:id/reject` | PENDING -> REJECTED |
| POST | `/v1/fi-requests` | Create an FI request (requires ACTIVE consent) |
| GET | `/v1/fi-requests/:id/status` | FI request status |
| GET | `/v1/fi-requests/:id/data` | Accounts + transactions (requires READY) |

This simulator has no authentication of its own - it is never exposed to a browser directly.
Only the main FinSphere server calls it, server-to-server, over `AA_SIMULATOR_URL`.

## Testing

```
cd aa_simulator
npm install
npm test
```
Spawns a disposable instance of this simulator on its own port (`AA_SIMULATOR_TEST_PORT`,
default 7199) and runs 33 checks covering PAN validation, account discovery, the full consent
lifecycle (including "cannot approve twice" and "cannot request FI data without active consent"),
FI request creation/status/data, and isolation between different aaIds.

## Future real-provider adapter

The main FinSphere server talks to this simulator only through `server/aaProvider.js`'s
`AccountAggregatorProvider` interface (`verifyPan`, `discoverAccounts`, `createConsent`,
`getConsent`, `approveConsent`, `rejectConsent`, `createFiRequest`, `getFiRequestStatus`,
`getFiRequestData`). A future real, ReBIT-certified provider (for example Setu's AA API - see
`docs/SETU.md`) would be added as a second implementation of that same interface and selected via
`AA_PROVIDER`/`AA_SIMULATOR_URL`; none of FinSphere's routes, normalization logic, or UI would need
to change.

## Running it locally

```
cd aa_simulator
npm install
PORT=7100 npm start
```
The main FinSphere server finds it at `AA_SIMULATOR_URL` (default `http://localhost:7100`).
