#include "status_window.h"

#include <pebble.h>

#include "comm.h"
#include "confirm_window.h"
#include "command_window.h"
#include "find_car_window.h"
#include "message_window.h"
#include "more_menu.h"
#include "state.h"

#define JLR_ACTION_BAR_WIDTH 52

static Window *s_window;

// Normal content -- always drawn; only the action bar is gated.
static TextLayer *s_vehicle_name_layer;
static TextLayer *s_lock_state_layer;
static TextLayer *s_fuel_range_layer;
static TextLayer *s_alert_layer;
static TextLayer *s_freshness_layer;
static Layer *s_divider_layer;
static TextLayer *s_up_label_layer;
static TextLayer *s_select_label_layer;
static TextLayer *s_down_label_layer;

// Full-screen lockout content.
static TextLayer *s_motion_layer;
static TextLayer *s_motion_hint_layer;

static char s_vehicle_name_buf[32];
static char s_lock_state_buf[16];
static char s_fuel_range_buf[48];
static char s_alert_buf[32];
static char s_freshness_buf[32];
static char s_up_label_buf[8];

static void prv_divider_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
  graphics_draw_line(ctx, GPoint(0, 0), GPoint(0, bounds.size.h));
}

static void prv_format_ago(int ago_sec, char *out, size_t out_len) {
  if (ago_sec < 0) {
    snprintf(out, out_len, "Updated: unknown");
    return;
  }
  if (ago_sec < 60) {
    snprintf(out, out_len, "Updated just now");
  } else if (ago_sec < 3600) {
    snprintf(out, out_len, "Updated %dm ago", ago_sec / 60);
  } else {
    snprintf(out, out_len, "Updated %dh %dm ago", ago_sec / 3600, (ago_sec % 3600) / 60);
  }
}

// Which capability gates the button the UP click will actually invoke right
// now (toggle target depends on current lock state).
static CapState prv_up_target_cap(void) {
  VehicleState *st = state_get();
  return st->locked ? st->cap_unlock : st->cap_lock;
}

static void prv_refresh(void) {
  VehicleState *st = state_get();
  // Read-only data is ALWAYS drawn. Only the action bar is gated, and only on
  // cmds_blocked -- the flag that governs actuating the vehicle. in_motion is
  // a display hint. (Owner's decision 2026-07-28: blanking the screen bought
  // no safety and made an uncertain GPS fix look like a broken app.)
  bool cmds_blocked = !state_is_session_stationary_verified() || st->cmds_blocked;

  layer_set_hidden(text_layer_get_layer(s_vehicle_name_layer), false);
  layer_set_hidden(text_layer_get_layer(s_lock_state_layer), false);
  layer_set_hidden(text_layer_get_layer(s_fuel_range_layer), false);
  layer_set_hidden(text_layer_get_layer(s_alert_layer), !st->doors_open && !st->windows_open);
  layer_set_hidden(text_layer_get_layer(s_freshness_layer), false);
  layer_set_hidden(s_divider_layer, false);

  // Action bar: hidden entirely while commands are blocked, so nothing invites
  // a press that would be refused.
  layer_set_hidden(text_layer_get_layer(s_select_label_layer), cmds_blocked);
  // Find stays available: it is a read, not a command. Hiding it would
  // contradict the handler, which now allows it.
  layer_set_hidden(text_layer_get_layer(s_down_label_layer), false);
  bool up_hidden = cmds_blocked || prv_up_target_cap() == CAP_NOT_CAPABLE;
  layer_set_hidden(text_layer_get_layer(s_up_label_layer), up_hidden);

  // The banner now explains why controls are missing, rather than replacing
  // the whole screen.
  layer_set_hidden(text_layer_get_layer(s_motion_layer), !cmds_blocked);
  layer_set_hidden(text_layer_get_layer(s_motion_hint_layer), !cmds_blocked);
  if (cmds_blocked) {
    text_layer_set_text(s_motion_layer,
      st->in_motion ? "Vehicle in motion" : "Checking safety");
    text_layer_set_text(s_motion_hint_layer,
      st->in_motion ? "Controls return when the vehicle stops."
                    : "Controls need a location fix confirming you are stationary.");
  }

  if (!st->valid) {
    strncpy(s_vehicle_name_buf, "Loading...", sizeof(s_vehicle_name_buf) - 1);
    text_layer_set_text(s_vehicle_name_layer, s_vehicle_name_buf);
    text_layer_set_text(s_lock_state_layer, "--");
    text_layer_set_text(s_fuel_range_layer, "");
    text_layer_set_text(s_freshness_layer, "");
    return;
  }

  strncpy(s_vehicle_name_buf, st->vehicle_name, sizeof(s_vehicle_name_buf) - 1);
  s_vehicle_name_buf[sizeof(s_vehicle_name_buf) - 1] = '\0';
  text_layer_set_text(s_vehicle_name_layer, s_vehicle_name_buf);

  snprintf(s_lock_state_buf, sizeof(s_lock_state_buf), st->locked ? "LOCKED" : "UNLOCKED");
  text_layer_set_text(s_lock_state_layer, s_lock_state_buf);
  text_layer_set_text_color(s_lock_state_layer,
    st->locked ? PBL_IF_COLOR_ELSE(GColorDarkGreen, GColorBlack)
               : PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));

  if (st->fuel_perc >= 0 && st->range_miles >= 0) {
    snprintf(s_fuel_range_buf, sizeof(s_fuel_range_buf), "Fuel %d%%  %d %s",
             st->fuel_perc, st->range_miles, st->distance_in_km ? "km" : "mi");
  } else {
    snprintf(s_fuel_range_buf, sizeof(s_fuel_range_buf), "Fuel/range unknown");
  }
  text_layer_set_text(s_fuel_range_layer, s_fuel_range_buf);

  if (st->doors_open && st->windows_open) {
    snprintf(s_alert_buf, sizeof(s_alert_buf), "Door & window open");
  } else if (st->doors_open) {
    snprintf(s_alert_buf, sizeof(s_alert_buf), "Door open");
  } else if (st->windows_open) {
    snprintf(s_alert_buf, sizeof(s_alert_buf), "Window open");
  }
  text_layer_set_text(s_alert_layer, s_alert_buf);

  prv_format_ago(state_ago_seconds(), s_freshness_buf, sizeof(s_freshness_buf));
  text_layer_set_text(s_freshness_layer, s_freshness_buf);

  snprintf(s_up_label_buf, sizeof(s_up_label_buf), st->locked ? "Unlock" : "Lock");
  text_layer_set_text(s_up_label_layer, s_up_label_buf);
}

static void prv_up_click_handler(ClickRecognizerRef recognizer, void *context) {
  VehicleState *st = state_get();
  if (!state_is_session_stationary_verified() || st->cmds_blocked) {
    return; // commands refused outright unless the car is proven stationary
  }
  CapState cap = prv_up_target_cap();
  if (cap == CAP_NOT_CAPABLE) {
    return; // button isn't even drawn in this case; defensive no-op
  }
  if (cap == CAP_NOT_ENABLED) {
    message_window_push("Not available",
      "This isn't enabled on your InControl account.");
    return;
  }
  if (st->locked) {
    confirm_window_push(); // unlock always needs an explicit confirm
  } else {
    comm_send_cmd(CMD_LOCK); // lock fires directly
    command_window_push(CMD_LOCK, "Locking...");
  }
}

static void prv_select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (!state_is_session_stationary_verified() || state_get()->cmds_blocked) {
    return; // every entry behind this menu actuates the vehicle
  }
  more_menu_window_push();
}

static void prv_down_click_handler(ClickRecognizerRef recognizer, void *context) {
  // Read-only: find-my-car shows where the car is, it does not touch the car.
  // Kept available whenever any other read-only data is.
  find_car_window_push();
}

static void prv_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, prv_up_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_down_click_handler);
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  int content_w = bounds.size.w - JLR_ACTION_BAR_WIDTH;

  s_vehicle_name_layer = text_layer_create(GRect(4, 4, content_w - 4, 22));
  text_layer_set_font(s_vehicle_name_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  layer_add_child(root, text_layer_get_layer(s_vehicle_name_layer));

  s_lock_state_layer = text_layer_create(GRect(4, 28, content_w - 4, 38));
  text_layer_set_font(s_lock_state_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  layer_add_child(root, text_layer_get_layer(s_lock_state_layer));

  s_fuel_range_layer = text_layer_create(GRect(4, 68, content_w - 4, 24));
  text_layer_set_font(s_fuel_range_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  layer_add_child(root, text_layer_get_layer(s_fuel_range_layer));

  s_alert_layer = text_layer_create(GRect(4, 94, content_w - 4, 24));
  text_layer_set_font(s_alert_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_color(s_alert_layer, PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack));
  layer_add_child(root, text_layer_get_layer(s_alert_layer));

  s_freshness_layer = text_layer_create(GRect(4, bounds.size.h - 26, content_w - 4, 22));
  text_layer_set_font(s_freshness_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_color(s_freshness_layer, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  layer_add_child(root, text_layer_get_layer(s_freshness_layer));

  s_divider_layer = layer_create(GRect(content_w, 0, 1, bounds.size.h));
  layer_set_update_proc(s_divider_layer, prv_divider_update_proc);
  layer_add_child(root, s_divider_layer);

  int bar_x = content_w + 2;
  int bar_w = JLR_ACTION_BAR_WIDTH - 4;
  s_up_label_layer = text_layer_create(GRect(bar_x, 8, bar_w, 40));
  s_select_label_layer = text_layer_create(GRect(bar_x, bounds.size.h / 2 - 20, bar_w, 40));
  s_down_label_layer = text_layer_create(GRect(bar_x, bounds.size.h - 48, bar_w, 40));
  TextLayer *bar_layers[3] = { s_up_label_layer, s_select_label_layer, s_down_label_layer };
  const char *bar_defaults[3] = { "Lock", "Menu", "Find" };
  for (int i = 0; i < 3; i++) {
    text_layer_set_font(bar_layers[i], fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_text_alignment(bar_layers[i], GTextAlignmentCenter);
    text_layer_set_overflow_mode(bar_layers[i], GTextOverflowModeWordWrap);
    text_layer_set_text(bar_layers[i], bar_defaults[i]);
    layer_add_child(root, text_layer_get_layer(bar_layers[i]));
  }

  s_motion_layer = text_layer_create(GRect(4, 122, bounds.size.w - 8, 24));
  text_layer_set_font(s_motion_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_motion_layer, GTextAlignmentCenter);
  text_layer_set_text_color(s_motion_layer, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
  text_layer_set_text(s_motion_layer, "Vehicle in motion");
  layer_add_child(root, text_layer_get_layer(s_motion_layer));

  // Without this line the blanked screen reads as a bug -- the user presses
  // buttons, nothing happens, and nothing explains why. Say what is happening
  // and when it ends.
  s_motion_hint_layer = text_layer_create(GRect(4, 146, bounds.size.w - 8, 56));
  text_layer_set_font(s_motion_hint_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_motion_hint_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_motion_hint_layer, GTextOverflowModeWordWrap);
  text_layer_set_text(s_motion_hint_layer,
    "Remote features return when the engine is off.");
  layer_add_child(root, text_layer_get_layer(s_motion_hint_layer));

  prv_refresh();
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_vehicle_name_layer);
  text_layer_destroy(s_lock_state_layer);
  text_layer_destroy(s_fuel_range_layer);
  text_layer_destroy(s_alert_layer);
  text_layer_destroy(s_freshness_layer);
  layer_destroy(s_divider_layer);
  text_layer_destroy(s_up_label_layer);
  text_layer_destroy(s_select_label_layer);
  text_layer_destroy(s_down_label_layer);
  text_layer_destroy(s_motion_layer);
  text_layer_destroy(s_motion_hint_layer);
  window_destroy(s_window);
  s_window = NULL;
}

static void prv_on_status_updated(void) {
  prv_refresh();
}

void status_window_push(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, prv_click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  comm_set_status_callback(prv_on_status_updated);
  window_stack_push(s_window, true);

  // Cache-then-refresh: state_init() may have loaded persisted data, but
  // prv_refresh() keeps it hidden and all actions inert until this session
  // receives a fresh stationary status.
  comm_send_cmd(CMD_GET_STATUS);
}
