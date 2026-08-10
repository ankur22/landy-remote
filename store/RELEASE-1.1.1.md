# Release 1.1.1

## Release notes (paste into the store's release-notes field)

Fixes lock and unlock appearing to fail when they had actually worked.

- Lock and unlock now confirm with the car itself. Previously the app could
  wait a long time and then report "no response" for a command the car had
  already carried out.
- The status card updates on its own afterwards. You no longer have to use
  Force Refresh to see the new lock state.
- The waiting screen shows how long it has been waiting instead of sitting
  silent, and says when the car is likely still waking up.
- Commands use fewer vehicle reads, so they finish sooner and use less battery.

---

## What changed since 1.1.0

One commit: `04e67e1`.

**The wait.** JLR's job-status endpoint frequently never reaches a terminal
state even when the car has plainly acted, so an unlock that worked ended in
"No response — car may be asleep" after 75 seconds. After a lock or unlock the
app now forces a VHS read and compares the door state to what was asked for. A
result reported as pending is corrected to success when the car shows the
requested state.

It only ever upgrades, and an explicit decline is never overwritten — the door
state cannot contradict the car having refused.

**The stale card.** The post-command status read came from JLR's server-side
cache, which can be hours old, so the card still read LOCKED after a successful
unlock until Force Refresh was pressed by hand. Only VHS moves that value.

**The cost of the above, which was not counted until the owner asked.** A
single button press was doing five full vehicle reads — the bridge's gate
check, sendCommand's own gate check, then the same again around the
confirmation — each a status call, a position call and a fresh GPS
acquisition, with a worst case near 150 seconds. Now two reads and roughly 90
seconds:

- `getBundle` honours the 10-second reuse cache, collapsing the paired gate
  checks. The read taken after VHS deliberately bypasses it, since seeing what
  changed is the entire point of that one.
- The confirmation reuses the bundle it just fetched.
- VHS polls for 15 seconds rather than 75. It is housekeeping — we ask the car
  to report in and read what it refreshes — and its own job status is never
  acted on.

## Checklist

- [x] Version bumped to 1.1.1
- [x] Clean build, all 7 test suites pass
- [x] Verified on the owner's vehicle
- [ ] `pebble publish`
- [ ] Icon assets: already re-uploaded for 1.1.0, no change here
- [ ] Screenshots unchanged; `emery_5_climate_running.png` still shows the old
      "Running, of 30 min" wording, and is still the lowest-priority item

## Still open after this

- Find-my-car's compass has never been verified outdoors with a calibrated
  magnetometer.
- The capability-gated UI has never been seen.
- `positionQuality` is never decoded.

Worth watching on the dashboard once this is out: the `pending` share of
command outcomes should drop sharply. If it does not, the confirmation is not
catching as much as intended.
