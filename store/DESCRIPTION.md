# Store listing copy

Paste into the appstore description field. Kept short and specific: the two
things a prospective user needs to decide are "will it work with my car" and
"what does it do with my data", and both are near the top rather than buried.

---

## Title

**Landy Remote**

## Category

Remotes

## Description

Lock, unlock and find your Jaguar Land Rover from your wrist.

**Anonymous usage statistics are collected and can be turned off in settings —
see Privacy below.**

**What it does**

- Lock and unlock — unlock asks you to confirm first
- Honk and flash to find the car in a car park
- Find my car — compass arrow and distance to its last reported position
- Remote climate — start and stop, with the cabin temperature set on the watch
- At-a-glance status — locked or unlocked, fuel and range, doors or windows
  left open, and how fresh the data is
- Tyre pressures, mileage, service and AdBlue distances, fluid warnings
- Miles or kilometres, °C or °F, kPa, bar or psi

Buttons for anything your vehicle or subscription does not support are not
shown — the app asks your car what it can do rather than assuming.

**You need**

- A Jaguar or Land Rover with an active InControl subscription
- The Pebble Core phone app
- Lock, unlock and honk also need InControl Remote Premium-class service and
  your vehicle PIN

**Safety**

If the app cannot confirm you are stationary, the controls disappear and only
information is shown. It will not send a command to a vehicle that might be
moving. Expect this if location permission is off, or indoors with a poor GPS
fix.

**Privacy**

Your credentials and vehicle data go straight from your phone to Jaguar Land
Rover. This app has no server in between, and your password is never stored —
only renewable tokens, on your phone.

Anonymous usage statistics are collected by default and can be switched off in
settings. Counted: app opens and version, which feature was used, whether a
command succeeded or failed, whether the safety lock-out triggered, which
services your vehicle supports, and the country of the request. Never
collected: your VIN, your car's location, speed or distance, your email, PIN
or tokens, or any vehicle status such as fuel, mileage or lock state.

**Honestly**

Remote commands go via Jaguar Land Rover's servers to the car's mobile
connection. They take 5–20 seconds and sometimes fail, more often on older
vehicles. The app tells you which happened — the car refused it, the car did
not answer, or it could not be reached — because those need different
responses from you.

This app uses an interface Jaguar Land Rover provides for their own web app.
It is not a published API and carries no compatibility guarantee, so a change
at their end can stop it working until the app is updated.

**Unofficial software. Not affiliated with, endorsed by, sponsored by, or
supported by Jaguar Land Rover Limited. "Jaguar", "Land Rover" and "InControl"
belong to their respective owners and are used only to describe what this app
works with.**

Source: https://github.com/ankur22/landy-remote

---

## Notes for whoever publishes this

- The analytics sentence is deliberately in the **third line**, not only under
  Privacy. Analytics defaults to on, and that is only an honest default if the
  disclosure is visible without scrolling. If the store truncates the
  description in previews, check it still survives.
- No JLR logo, badge, green, or brand typeface appears in the icon or any
  screenshot. The icon is a generic boxy 4x4 on charcoal.
- Screenshots are real data from a 2018 Discovery. Nothing sensitive, but they
  do show that vehicle's fuel level and mileage.
