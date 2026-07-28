#include "more_menu.h"

#include <pebble.h>

#include "comm.h"
#include "command_window.h"
#include "climate_window.h"
#include "message_window.h"
#include "state.h"
#include "tyre_window.h"

#define MAX_ITEMS 4

static Window *s_window;
static SimpleMenuLayer *s_menu_layer;
static SimpleMenuSection s_section;
static SimpleMenuItem s_items[MAX_ITEMS];
static int s_item_count;

// Which Cmd (if any) each menu row triggers, and whether it's currently
// gated to "not enabled" (show, but explain instead of sending). Index-
// aligned with s_items.
static Cmd s_item_cmd[MAX_ITEMS];
static bool s_item_not_enabled[MAX_ITEMS];
static bool s_item_is_tyre_screen[MAX_ITEMS];

static void prv_select_callback(int index, void *context) {
  if (index < 0 || index >= s_item_count) {
    return;
  }
  if (s_item_is_tyre_screen[index]) {
    tyre_window_push();
    return;
  }
  if (s_item_not_enabled[index]) {
    message_window_push("Not available", "This isn't enabled on your InControl account.");
    return;
  }
  Cmd cmd = s_item_cmd[index];

  // Remote climate asks for a target temperature first -- that choice belongs
  // at the moment of use, not in phone settings.
  if (cmd == CMD_REMOTE_START) {
    climate_window_push();
    return;
  }

  const char *title = "Working...";
  switch (cmd) {
    case CMD_HONK: title = "Honk & flash..."; break;
    case CMD_REFRESH: title = "Refreshing..."; break;
    case CMD_REMOTE_START: title = "Starting climate..."; break;
    case CMD_REMOTE_STOP: title = "Stopping climate..."; break;
    default: break;
  }
  comm_send_cmd(cmd);
  command_window_push(cmd, title);
}

static void prv_add_item(const char *title, const char *subtitle, Cmd cmd,
                          bool not_enabled, bool is_tyre_screen) {
  if (s_item_count >= MAX_ITEMS) {
    return;
  }
  int i = s_item_count++;
  s_items[i] = (SimpleMenuItem) {
    .title = title,
    .subtitle = subtitle,
    .callback = prv_select_callback,
  };
  s_item_cmd[i] = cmd;
  s_item_not_enabled[i] = not_enabled;
  s_item_is_tyre_screen[i] = is_tyre_screen;
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  VehicleState *st = state_get();
  s_item_count = 0;

  // Honk & flash -- capability-gated. not_capable is hidden entirely (per
  // the brief: "buttons for unavailable services must not be drawn").
  if (st->cap_honk != CAP_NOT_CAPABLE) {
    prv_add_item("Honk & Flash", st->cap_honk == CAP_NOT_ENABLED ? "Not enabled" : NULL,
                 CMD_HONK, st->cap_honk == CAP_NOT_ENABLED, false);
  }

  // Force refresh (VHS) -- almost universally available (it's the one
  // service present even on a Protect-only account), but still gated the
  // same way for consistency and future-proofing.
  if (st->cap_refresh != CAP_NOT_CAPABLE) {
    prv_add_item("Force Refresh", st->cap_refresh == CAP_NOT_ENABLED ? "Not enabled" : "Re-check with car",
                 CMD_REFRESH, st->cap_refresh == CAP_NOT_ENABLED, false);
  }

  // Tyre pressures / service info -- never gated, it's just a display of
  // whatever status data already arrived.
  prv_add_item("Tyres & Service", "Pressures, AdBlue, warnings", CMD_GET_STATUS, false, true);

  // Remote start -- only if available at all (hide on not_capable; still
  // show on not_enabled/unknown per the same fail-open policy).
  // Remote climate. On a petrol/diesel car this is preconditioning -- warm
  // the cabin and clear the screen before you walk out -- so start and stop
  // are offered as a pair. Shipping start without stop would leave the engine
  // running with no way to end it from the same app.
  if (st->cap_remote_start != CAP_NOT_CAPABLE) {
    prv_add_item("Start Climate",
                 st->cap_remote_start == CAP_NOT_ENABLED ? "Not enabled" : "Warm/cool the cabin",
                 CMD_REMOTE_START, st->cap_remote_start == CAP_NOT_ENABLED, false);
    prv_add_item("Stop Climate", "Shut the engine off",
                 CMD_REMOTE_STOP, st->cap_remote_start == CAP_NOT_ENABLED, false);
  }

  s_section = (SimpleMenuSection) {
    .title = "More Controls",
    .items = s_items,
    .num_items = s_item_count,
  };

  s_menu_layer = simple_menu_layer_create(bounds, window, &s_section, 1, NULL);
  layer_add_child(root, simple_menu_layer_get_layer(s_menu_layer));
}

static void prv_window_unload(Window *window) {
  simple_menu_layer_destroy(s_menu_layer);
  window_destroy(s_window);
  s_window = NULL;
}

void more_menu_window_push(void) {
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
}
