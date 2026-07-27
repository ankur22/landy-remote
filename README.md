# jlr-remote

A Pebble Time 2 (and broader PebbleOS) watchapp for controlling a Jaguar Land
Rover InControl-connected vehicle from the wrist: lock/unlock, honk & flash,
find-my-car, and a glanceable status card. Not affiliated with or endorsed by
Jaguar Land Rover.

**Current status: milestone 2.** This repo currently ships the PebbleKit JS
(pkjs) API client only -- `src/pkjs/jlr.js` -- with no watch UI wired up yet
(that's milestone 3). The C side is still the stock `pebble new-project`
template.

The full research trail this client is built from lives in the sibling
`~/projects/pebble/` repo:

- `jlr-remote-research.md` -- the verified API contract (hosts, auth chain,
  headers, media types, endpoint map).
- `jlr-vehicle-capabilities.md` -- the `availableServices` capability-gating
  mechanism and what's known about this vehicle generation.
- `jlr-probe.py` -- the read-only Python reference probe this client's logic
  was ported from and cross-checked against.

## Why this works at all (read this before touching the client)

JLR's native-app API host is behind an Approov attestation wall (HTTP 498)
that cannot be defeated from a Pebble. The working path instead talks to
JLR's **browser-facing webview edge** (`/if9/webview/*`), which accepts a
plain bearer token as long as the request carries a browser-shaped
fingerprint: `Origin`/`Referer` set to `https://webview.prod-row.jlrmotor.com`,
a `User-Agent`, and a registered `X-Device-Id` / `clientId` (yes, camelCase)
pair. This was confirmed live on both the emulator and a real Pebble Time 2 +
iOS -- pkjs does not enforce the browser forbidden-header list, so it can set
`Origin`/`Referer` outright.

This also means the whole design rests on JLR continuing to serve that edge
the way it does today. If JLR tightens CORS/Origin checking or extends the
Approov wall to the webview host, this client breaks with no workaround.
Treat it as fragile-by-design, not a stable API integration.

## API surface (`src/pkjs/jlr.js`)

Single file, no npm dependencies, ES5-safe (`var`, no arrow functions, no
Promises -- callback-style `(err, result)` throughout so it runs unmodified
under pkjs's JS engine). Exports `JLR.Client`, plus a few pure helper
functions used both internally and in tests: `JLR.maskVin`,
`JLR.serviceState`, `JLR.flattenStatus`.

```js
var JLR = require('./jlr');
var client = new JLR.Client();

client.login(email, password, function (err) { ... });
client.refreshTokens(function (err) { ... });
client.registerDevice(function (err) { ... });   // usually not called directly -- see below
client.getUserId(function (err, userId) { ... });

client.getVehicles(function (err, vehicles) { ... });
client.getAttributes(vin, function (err, attrs) { ... });
client.getCapabilities(vin, function (err, caps) { ... });
client.getStatus(vin, function (err, statusDict) { ... });
client.getPosition(vin, function (err, position) { ... });

client.sendCommand(vin, 'RDL', pin, null, function (err, result) { ... });
client.lock(vin, pin, function (err, result) { ... });
client.unlock(vin, pin, function (err, result) { ... });
client.honkFlash(vin, pin, function (err, result) { ... });
client.refreshFromVehicle(vin, function (err, result) { ... }); // VHS, empty PIN always
```

Most callers only need `login()` once and then the read/command methods --
`connect()` (ensure token -> register device -> resolve user id) runs
internally before every network call that needs it.

### Auth and token handling

- A stable per-install device UUID4 is generated once and persisted in pkjs
  `localStorage`; it's what the webview edge's `X-Device-Id`/`clientId`
  headers use.
- **Device registration is redone after every new token** (login or refresh),
  not just once per install -- the client tracks this per access-token
  internally, so callers don't need to think about it.
- Tokens (access, authorization, refresh) are persisted in `localStorage`.
  **The plaintext password is never persisted anywhere** -- only the account
  email (needed to re-run device registration / user lookup) and the refresh
  token survive an app restart.
- `ensureToken()` refreshes automatically when the access token is within 5
  minutes of expiry. If refreshing fails (refresh token missing/rejected), it
  surfaces an error rather than silently attempting a full password re-login
  -- there is no stored password to fall back to. The caller (eventually the
  watch app's login/config flow) is expected to catch that and re-prompt for
  credentials, then call `login()` again.
- Nothing in this module ever logs a credential, token, or PIN, not even
  truncated. VINs are masked in every log line via `maskVin()`
  (`SALGA…3456`).

### Capability gating (`getCapabilities` / `serviceState`)

`getCapabilities(vin, cb)` fetches `/attributes` (cached 24h in
`localStorage`, since it essentially never changes) and reduces
`availableServices` into `{ RDL, RDU, HBLF, VHS, REON, REOFF, ALOFF,
fuelType, vehicleType, modelYear }`, where each service code maps to one of:

| State | Meaning | Suggested UI |
|---|---|---|
| `available` | `vehicleCapable && serviceEnabled` | draw the button |
| `not_enabled` | listed, but `serviceEnabled === false` | draw disabled; "not enabled on your InControl account" |
| `not_capable` | not in the list at all, or `vehicleCapable === false` | hide the button permanently |
| `unknown` | the whole `availableServices` list is missing | fail open -- draw the button, let it fail once rather than hiding a feature because a field got renamed |

This is msp1974's strictness (require both flags) combined with
willbeeching's fail-open behaviour when the list itself is absent, per
`jlr-vehicle-capabilities.md` section 2.4.

### Status flattening and the `LAST_UPDATED_TIME` fallback

`getStatus(vin, cb)` flattens `vehicleStatus.{coreStatus,evStatus}[]`
`{key,value}` lists into a plain `{KEY: value}` dict, ported verbatim from
`willbeeching/ha-jlr-incontrol`'s `api.py::_flatten_status`. **This vehicle
does not report a top-level `LAST_UPDATED_TIME` status key at all** -- the
flattener also tracks the newest per-item `lastUpdatedTime` field across
every status entry and synthesises `LAST_UPDATED_TIME` from that whenever it
is newer than whatever (if anything) is already under that key. Without this,
a freshness display would either show nothing or fall back to the position
timestamp, which is static while the car is parked and would read as
permanently stale. Covered by both the pkjs self-test in `src/pkjs/index.js`
and `test/unit-test.js`.

### Commands are asynchronous -- three distinct outcomes

`sendCommand(vin, serviceName, pin, serviceParameters, cb)` runs the two-step
flow (`authenticate` -> service start endpoint) and then polls
`GET /vehicles/<vin>/services/<customerServiceId>` up to 10 times at 3s
intervals (~30s, matching the reference implementation) until a terminal
state. `cb(err, result)` -- `err` is only set for a hard failure *before* a
service was even started (bad auth, unknown service, transport failure,
non-202/200 on the start call). Once a `customerServiceId` exists, every
outcome comes back through `result`, never `err`:

```js
{ outcome: 'success',  status: <raw terminal payload> }
{ outcome: 'declined', status: <raw terminal payload>, failureReason, failureDescription }
{ outcome: 'pending',  status: <raw last-seen payload> }
```

- `declined` means the vehicle actively refused it (`Failed`/`Aborted`/
  `Cancelled`, typically with `failureReason: 'NegativeAcknowledge'` and a
  machine-readable `failureDescription` like `conflictWithOnboardChange` or
  `parameterAlreadyInRequestedState`). Retrying usually won't help.
- `pending` means the poll window ran out while the service was still
  `Started`/non-terminal -- most often the car is asleep or out of signal.
  Retrying is worth offering here, unlike `declined`.

The watch UI (milestone 3+) must show these as different messages -- this
vehicle's owner reports commands failing often, so this is the common case,
not an edge case.

Media types are per-endpoint and unforgiving (wrong `Accept` -> 406): the
vehicle list and position endpoints need plain `application/json`; status
needs the healthstatus vnd type; classic command endpoints
(lock/unlock/honkBlink/healthstatus) need `ServiceStatus-v4` specifically (v5
and plain JSON both 406 there). None of the BEV-only `PhevService` endpoints
(preconditioning/chargeProfile, which want v5) are implemented -- this is a
diesel Discovery, they're out of scope.

## Testing

### 1. Pure-logic + mocked-network unit tests (no credentials, no network)

```sh
node test/unit-test.js
```

Covers `flattenStatus`, `serviceState`, `maskVin` directly, plus the full
mocked network path for login -> connect -> `sendCommand`, asserting all
three terminal outcomes (`success`, `declined`, `pending`) come back
correctly from a canned response queue. **No real request is ever made by
this test.**

### 2. In-emulator self-test (no credentials, no network)

```sh
pebble build
pebble install --emulator emery --logs
```

`src/pkjs/index.js` runs the same pure-logic checks inside the actual pkjs
runtime on `ready`, to catch anything that only breaks in that JS engine
(there is real precedent for this in this SDK -- see the UTF-8-as-Latin-1
mojibake gotcha in the sibling `econfeed` project). Expect:

```
JLR: pkjs ready
JLR: [PASS] flattenStatus: ...
...
JLR: self-test summary: 9/9 passed
```

Verified 2026-07-27 against SDK 4.17 / pebble-tool 5.0.39 on the emery
emulator -- all 9 checks passed.

### 3. Live read-only smoke test against the real backend (needs real credentials)

```sh
node test/live-smoke-test.js
```

This runs the *actual* `src/pkjs/jlr.js` module (not a reimplementation)
under plain Node, with a small XMLHttpRequest/localStorage polyfill, against
the real JLR backend: login -> connect -> list vehicles -> capabilities ->
status -> position. **Read-only** -- it never calls `sendCommand`/`lock`/
`unlock`/`honkFlash`. Credentials come from environment variables only; they
are never logged, hardcoded, or committed.

**This was not run as part of building this milestone** -- no InControl
credentials were available in this environment. Run it yourself with your
real credentials to confirm the live contract still matches
`jlr-remote-research.md` before building on top of it. Do not repeat this
call speculatively with wrong credentials -- the research doc documents a
WAF rule that appears to react to repeated password grants against an
unknown account.

### What must NEVER be tested against the real vehicle

Do not call `sendCommand`/`lock`/`unlock`/`honkFlash`/`refreshFromVehicle`
against the real backend from an automated test or a casual "let's see if it
works" run. Those actuate a physical vehicle (unlock opens the driver's door;
honk & flash is audible/visible outside). Exercise the command path only via
`test/unit-test.js`'s mocked responses, or manually, deliberately, by Ankur.

## Project layout

```
src/c/                    stock watchapp template (C) -- unchanged so far, milestone 3 work
src/pkjs/jlr.js           the JLR API client (this milestone's deliverable)
src/pkjs/index.js         pkjs entry point; currently just self-tests jlr.js on 'ready'
test/unit-test.js         mocked-network + pure-logic unit tests (node test/unit-test.js)
test/live-smoke-test.js   real-backend read-only smoke test (Keychain or hidden prompt)
package.json              project metadata (UUID, platforms, resources, message keys)
wscript                   build rules -- no need to edit
```

## Building & running the watchapp shell

```sh
export PATH="$HOME/.local/bin:$PATH"   # pebble-tool lives in ~/.local/bin
pebble build                           # build for all targetPlatforms
pebble install --emulator emery --logs # install + stream watch/pkjs logs
pebble install --phone <ip>            # install to a paired phone over LAN
```

If `pebble install --emulator ...` times out on `WatchVersion` the very first
time, that's a known first-boot flake -- just re-run it. If a stale
`qemu-pebble`/`pypkjs` process is left over from a previous session and the
same timeout happens again, `pkill -f qemu-pebble; pkill -f pypkjs` and retry.

## Where this differs from the research docs / open questions for milestone 3

Nothing found in building this milestone contradicts
`jlr-remote-research.md` or `jlr-vehicle-capabilities.md` -- the endpoint
map, media types, and gating logic were implemented exactly as documented.
The one thing this milestone could **not** verify is whether the documented
contract still holds against Ankur's real account today (`test/live-smoke-
test.js` is ready for that, but wasn't run here -- see above). Everything
else (capability gating, status flattening/`LAST_UPDATED_TIME` fallback, the
three-outcome command polling) was verified either against synthetic
fixtures shaped like the real probe output, or against a mocked network in
`test/unit-test.js`.

Known gaps intentionally left for milestone 3+:
- No watch-side UI, no AppMessage protocol between C and pkjs yet.
- No PIN storage/confirm-dialog design (the research doc's default: store
  the PIN locally, confirm on-watch before unlock) -- `sendCommand` accepts
  a PIN parameter but this layer has no opinion on where it comes from.
- No config page for email/password/PIN entry (the research doc's plan: a
  static page on GitHub Pages, closing back into the app via
  `pebblejs://close#...`).
- Find-my-car math (haversine distance + bearing) is not part of this
  client -- `getPosition()` returns the raw
  `{latitude, longitude, heading, speed, positionQuality, timestamp}`
  payload for a future consumer to do that with.
