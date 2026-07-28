# Landy Remote

A Pebble Time 2 (and broader PebbleOS) watchapp for a Jaguar Land Rover
InControl-connected vehicle: lock/unlock, honk & flash, find-my-car, and a
glanceable status card.

**Unofficial software. Not affiliated with, endorsed by, or supported by
Jaguar Land Rover.**

## What it does

- **Status card** — locked/unlocked, fuel level and range, doors or windows
  left open, and how fresh the data is.
- **Lock / unlock** — unlock requires an explicit confirmation on the watch.
- **Honk & flash** — find the car in a car park.
- **Find my car** — compass arrow and distance from your phone to the car's
  last reported position, with the fix's age and quality shown so you can judge
  how much to trust it. The arrow is only drawn once your watch's compass is
  calibrated; if it asks for a figure-8, do that first. A confidently wrong
  arrow is worse than none.
- **Tyres & service** — pressures, total mileage, service and AdBlue distances,
  fluid warnings.
- **Remote climate** — start and stop, with the cabin temperature picked on the
  watch at the moment you use it. On a petrol or diesel car this runs the
  engine, so it warms the cabin and clears the screen before you walk out.
- **Units** — miles or kilometres, °C or °F, kPa/bar/psi, in settings.

Buttons for services your vehicle or InControl subscription does not provide
are not drawn — the app asks the vehicle what it supports rather than assuming.

## Safety: the app locks down while the vehicle may be moving

If the app cannot positively confirm you are stationary, the controls
disappear and it says **"Vehicle in motion"** or **"Checking safety"**. Status,
tyre pressures and find-my-car stay readable — only commands are refused.

This fails closed. The vehicle's own reported status can be hours stale, so it
is never treated as proof the car is parked; the live signal is your phone's
GPS speed. If that speed is unavailable, denied, stale, or indicates movement,
commands stay blocked. The block lives in the phone layer, not just the UI, so
a stale screen cannot get a command through.

Expect this if location permission is off, or indoors with a poor fix.

## Requirements

- A Jaguar or Land Rover with an **active InControl subscription**
- The **Pebble Core app** (iOS or Android) — the legacy iOS app's older
  JavaScript engine is not supported
- Remote lock, unlock and honk & flash require InControl **Remote Premium**-class
  service and the vehicle security PIN

## Setup

Open the app's settings in the Pebble phone app. That opens the configuration
page, which is plain static HTML and **does not submit anything to a web
server** — it hands the form back to the Pebble app through the standard
`pebblejs://close#...` URL fragment.

1. Enter your InControl email and password.
2. Leave VIN blank for a single-vehicle account; enter the 17-character VIN to
   choose between several.
3. Leave **Store vehicle PIN on this phone** off unless you want the remote
   commands — read-only status and find-my-car work without it.
4. Save.

Your **password is never stored**. It is used once to obtain renewable tokens,
which are kept in the Pebble app's local storage on your phone. There is no
server in between: your phone talks to JLR directly.

**On storing the PIN:** it is off by default and entirely your choice. Turning it
on means *anyone who can unlock your phone can unlock your car*. The watch still
asks for confirmation before unlocking. "Sign out and clear saved data" removes
the tokens, email, selected vehicle and PIN.

Note that a remote unlock opens **the driver's door only**, and the vehicle
re-locks itself after about 45 seconds — so the status card correctly showing
"locked" a minute later is not a bug.

## Reliability, honestly

Remote commands go to JLR's servers and then to the car over its mobile
connection. They routinely take 5–20 seconds, and they do sometimes fail —
more often on older vehicles. The app reports what actually happened rather
than a generic error:

- **Car declined** — the vehicle refused it; retrying now will not help
- **No response** — most often the car is asleep or out of signal; retrying is
  reasonable
- **Could not reach vehicle** — a network or sign-in problem on our side

This app talks to an interface JLR provides for their own web app. It is not a
published API and carries no compatibility guarantee, so a change at their end
can break it until the app is updated.

## Development

```sh
export PATH="$HOME/.local/bin:$PATH"   # pebble-tool lives in ~/.local/bin
pebble build
node test/unit-test.js                 # pure logic + canned-XHR tests
node test/real-client-test.js          # real-client adapter, fakes only
node test/bridge-test.js               # AppMessage bridge, units, climate state
node test/startup-safety-test.js       # safety and wiring invariants
node test/analytics-test.js            # analytics, including the privacy floor
node test/config-test.js               # configuration flow
node test/config-page-test.js          # the hosted configuration page
```

All automated tests use injected fakes — no test contacts JLR or a vehicle.

`src/pkjs/index.js` selects the real client by default. Set `USE_MOCK=true` for
fixture-driven UI work; `src/pkjs/mock.js` has flags for the in-motion and
reduced-capability cases, which are otherwise awkward to reach.

### Never automate a command against a real vehicle

`sendCommand`/`lock`/`unlock`/`honkFlash` actuate a physical car — unlock opens
a door, honk & flash is audible and visible from outside. Exercise them only
through mocked responses, or deliberately by hand by the vehicle's owner. Never
from a test, a CI job, or a casual "let's see if it works" run.

The headers, media types and header names in `src/pkjs/jlr.js` are exact and
load-bearing; several endpoints reject requests that look reasonable but differ.
The comments there explain which and why — read them before changing a request.

### Layout

```
src/c/                     watch UI, persisted state, session safety gate
src/pkjs/jlr.js            JLR API client
src/pkjs/real.js           safety-first client facade (injectable)
src/pkjs/mock.js           fixtures for offline UI work
src/pkjs/index.js          AppMessage bridge and client selection
docs/config/               configuration page (GitHub Pages)
test/                      automated tests, fakes only
```

## Privacy

**Your credentials and vehicle data go directly between your phone and JLR.**
No server of this project ever sees them. On the watch, only the glanceable
status fields are cached — never your VIN, credentials, or the vehicle's
location.

**Anonymous usage statistics are collected, and you can turn them off** in
settings. This changed in v1.1 — earlier versions collected nothing, and it
would be wrong to quietly swap this section. What is counted:

- that the app was opened, and its version
- which feature was used (lock, unlock, honk, find-my-car, climate)
- whether a command succeeded, was declined, or timed out
- whether the safety gate blocked a command, and whether that was because the
  vehicle was moving or because motion could not be determined
- which remote services your vehicle supports
- the country the request came from, derived by the server from the connection

What is **never** collected: your VIN, your vehicle's position, distance,
bearing or speed, your email, tokens or PIN, and any vehicle status value —
fuel, range, odometer, lock or door state, tyre pressures. No timestamp is
sent by the phone, and the receiving service does not log or store IP
addresses.

The purpose is finding bugs that only appear on other people's cars: this app
is developed against a single vehicle, and command reliability is known to
vary by model and year.

## Credits

This project stands on prior reverse-engineering by others, all MIT licensed:
[ha-jlr-incontrol](https://github.com/willbeeching/ha-jlr-incontrol),
[jlrpy](https://github.com/ardevd/jlrpy), and
[jlr-remote](https://github.com/WonkiDonk/jlr-remote). See [NOTICE](NOTICE) for
attribution details.

## Licence

MIT — see [LICENSE](LICENSE), and [NOTICE](NOTICE) for attribution and scope.

The licence covers this project's own code. It grants no rights in any third
party's services, trademarks, or data. Note in particular the warranty and
liability disclaimer: this software sends commands to a physical vehicle.
