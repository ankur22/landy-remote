# jlr-remote

A Pebble Time 2 (and broader PebbleOS) watchapp for controlling a Jaguar Land
Rover InControl-connected vehicle from the wrist: lock/unlock, honk & flash,
find-my-car, and a glanceable status card. Not affiliated with or endorsed by
Jaguar Land Rover.

**Current status: milestone 4 (offline implementation complete).** The watch
UI, AppMessage policy bridge, startup safety gate, and injectable real-client
adapter are wired together. Automated validation is deliberately fake-only:
no JLR server or physical vehicle was contacted while implementing this
milestone. Owner-led phone/watch validation remains outstanding.

The production switch in `src/pkjs/index.js` selects `RealClient`. Set
`USE_MOCK=true` only for explicit fixture-driven UI development. A static
`pebble build` bundles JavaScript but does not execute the pkjs `ready`
handler; installing or launching a real build does execute it.

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

## Offline verification

All automated Milestone 4 tests inject raw clients, geolocation, storage,
clocks, timers, and AppMessage endpoints. They are structurally unable to
construct the production client or reach JLR.

```sh
node test/unit-test.js
node test/real-client-test.js
node test/bridge-test.js
node test/startup-safety-test.js
PATH="$HOME/.local/bin:$PATH" pebble build
```

- `unit-test.js` covers pure helpers and canned-XHR protocol behavior.
- `real-client-test.js` covers the phone-motion matrix, explicit vehicle
  selection, sequential bundle reads, short-lived in-memory position reuse,
  find-my-car math/freshness, PIN and capability gates, and command outcome
  fidelity.
- `bridge-test.js` captures fake `Pebble.sendAppMessage()` dictionaries and
  proves moving/unknown responses are data-free and every command fails
  closed when safety lookup fails.
- `startup-safety-test.js` proves persisted C state cannot establish
  current-session stationary proof and all three status-window buttons stay
  inert until fresh evidence arrives.
- `pebble build` statically compiles all configured targets. It does not
  execute pkjs or make a backend request.

Do not include `test/live-smoke-test.js`, `pebble install`, an emulator
launch, or screenshots in routine automated verification.

### What must NEVER be tested against the real vehicle

Do not call `sendCommand`/`lock`/`unlock`/`honkFlash`/`refreshFromVehicle`
against the real backend from an automated test or a casual "let's see if it
works" run. Those actuate a physical vehicle (unlock opens the driver's door;
honk & flash is audible/visible outside). Exercise the command path only via
`test/unit-test.js`'s mocked responses, or manually, deliberately, by Ankur.

## Project layout

```
src/c/                    watch UI, persisted state, and current-session safety gate
src/pkjs/jlr.js           low-level JLR API client
src/pkjs/real.js          injectable safety-first real-client facade
src/pkjs/mock.js          fixture-only facade for explicit offline UI work
src/pkjs/index.js         AppMessage policy bridge and real/mock selection
test/unit-test.js         canned-XHR + pure-logic tests
test/real-client-test.js  fake-only real adapter contract tests
test/bridge-test.js       fake AppMessage integration tests
test/startup-safety-test.js static startup-lockdown invariants
test/live-smoke-test.js   owner-only read-only diagnostic; excluded from validation
package.json              project metadata (UUID, platforms, resources, message keys)
wscript                   build rules -- no need to edit
```

## Building and owner hardware verification

```sh
export PATH="$HOME/.local/bin:$PATH"   # pebble-tool lives in ~/.local/bin
pebble build                           # build for all targetPlatforms
```

The owner should install only as a deliberate hardware-validation step.
Launching a real build runs pkjs and may attempt backend reads when valid
tokens already exist. Before testing, confirm the selected account/vehicle,
start stationary, and expect a full lockdown whenever phone speed is absent,
invalid, stale, denied, or at/above 5 km/h. Verify status and find-my-car
reads before opting into any PIN-backed command. Never automate physical
commands.

## Milestone 4 limitations

- The hosted configuration/sign-in page is Milestone 5. A fresh install has
  no supported password-entry path and reports configuration required.
- Passwords are never persisted. Rejected refresh authentication reports
  that sign-in is required again.
- A sole account vehicle is selected automatically. Multiple vehicles remain
  blocked until Milestone 5 supplies explicit selection.
- PIN storage/opt-in UI and its disclosure are Milestone 5. PIN-required
  commands remain locally blocked when no PIN is configured; VHS uses an
  empty PIN.
- Pebble Core iOS may return `coords.speed=null`. This is intentionally motion
  unknown: cached data stays hidden and every command remains blocked.
- Real backend reads, authentication, physical actuation, and phone/watch UX
  have not been validated by automation. That evidence belongs to deliberate
  owner hardware testing.
