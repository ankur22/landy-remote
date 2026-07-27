#pragma once

// More-controls menu (SELECT from the main status screen): honk & flash,
// force refresh (VHS), tyre pressures / service info, and remote start when
// available. Every item is capability-gated per state_get()'s cap_* fields
// -- not_capable items are never added to the menu at all.
void more_menu_window_push(void);
