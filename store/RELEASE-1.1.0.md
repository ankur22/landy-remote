# Release 1.1.0

## Release notes (paste into the store's release-notes field)

Fixes the app getting stuck on "Checking safety" and never showing the
controls.

- The safety lock-out now only triggers when something actually reports
  movement. Previously it also triggered whenever your phone could not supply
  a speed at all, which could leave the controls hidden next to a parked car,
  indoors or out.
- Status loads several seconds faster: it no longer waits for three separate
  GPS readings.
- Find my car no longer shows a permanent warning colour, and says how old the
  car's reported position is instead of "Fix: unknown".
- New app icon.
- Climate temperature now shows a degree symbol.

The vehicle is still never sent a command while it reports that it is moving.

---

## What changed since 1.0.0

Two commits: `885bb92` (icon and rename), `5a46683` (safety-gate
simplification).

| Change | Store impact |
|---|---|
| Safety gate: only positive evidence of motion blocks | The headline fix — 1.0.0 was unusable when GPS was unavailable |
| One GPS fix instead of three | Status is several seconds faster |
| Find-my-car quality display | Screenshot already retaken and current |
| New icon (vertical tailgate, taller, bigger wheels) | **Must be re-uploaded — 1.0.0 shipped the old one** |
| Degree symbol on the climate picker | Screenshot `emery_4_climate.png` is current |
| Project renamed to landy-remote | Artefact is now `build/landy-remote.pbw`; no user-visible change |

## Checklist

- [x] Version bumped to 1.1.0 in `package.json`
- [x] Clean build, `versionLabel` confirmed 1.1.0 in the bundle
- [x] All 7 test suites pass
- [ ] **Re-upload the icon** — `store/icon_small.png` and
      `store/icon_large.png` changed after 1.0.0 was published
- [ ] Retake `emery_5_climate_running.png` — it shows the old "Running, of
      30 min" wording; the app now says "Climate running" with "left of 30
      min" beneath. Lowest-priority item here.
- [ ] Check how many screenshots the store accepted: 1.0.0 shows five of the
      seven uploaded. If it caps at five, drop the two climate ones rather
      than letting it choose.
- [ ] `pebble publish`

## Known gaps carried into 1.1.0

Unchanged from the handoff doc, none of them regressions:

- Find-my-car's compass has never been verified outdoors with a calibrated
  magnetometer; the arrow is suppressed until the compass reports calibrated.
- The capability-gated UI has never been seen — no vehicle lacking services
  has been tested against.
- `positionQuality` is never decoded; the screen now avoids saying anything
  misleading about it rather than reporting "unknown".

## The one thing worth re-reading before publishing

The safety gate is now *"no evidence of motion"* rather than *"proof of
stillness"*. The residual risk is a phone that cannot report speed **and** a
stale vehicle speed, while the car is genuinely being driven. That was a
deliberate trade: 1.0.0's stricter rule made the app unusable, and an app
nobody can use protects nobody. The vehicle's own interlocks guard the same
case, and the bundle records `speedVerified` so the distinction is still
available if it needs tightening later.
