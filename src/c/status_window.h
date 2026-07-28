#pragma once

// Main screen: status card (lock state, fuel/range, vehicle name,
// doors/windows-open indicator, freshness line) with a right-hand action
// bar -- UP = lock/unlock toggle, SELECT = more-controls menu, DOWN = find
// my car. Full-screen "Vehicle in motion" lockout per the safety rule when
// state_get()->in_motion is set. Interaction model cribbed from "Tesla
// Control" per landy-remote-research.md.

void status_window_push(void);
