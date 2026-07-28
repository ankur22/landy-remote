#include <pebble.h>
#include "climate_window.h"
#include "comm.h"
#include "command_window.h"
#include "state.h"

// Target cabin temperature picker, shown before starting remote climate.
//
// This lives on the watch rather than in phone settings deliberately: the
// temperature is a per-use decision ("it's freezing, give me 24") made at the
// moment you start it, not a preference you set once and forget. Putting it in
// settings would mean reaching for the phone -- which is the thing the watch
// app exists to avoid.
//
// The car's own scale is RCC 31-57, which maps to 15.5-28.5 C in half degrees;
// pkjs does that conversion, so this window works purely in Celsius.

#define TEMP_MIN_C10 155
#define TEMP_MAX_C10 285
#define TEMP_STEP_C10 5

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_temp_layer;
static TextLayer *s_hint_layer;
static char s_temp_buf[16];
static char s_title_buf[32];
static int s_temp_c10;

// The target is always held in Celsius, because the car's RCC scale is defined
// in Celsius at half-degree resolution. Fahrenheit is a display conversion at
// the last moment only -- converting any earlier would mean keeping two
// representations in step.
//
// Note the car cannot do 1 degF steps: 0.5 degC is 0.9 degF, so consecutive
// presses occasionally show the same rounded degF. That is the vehicle's
// resolution, not a rounding bug, and pretending otherwise would send a
// setpoint the car would silently alter.
static void prv_render(void) {
  VehicleState *st = state_get();

  if (st->climate_on) {
    // Running: report the state rather than inviting a second start.
    if (st->climate_runtime_min > 0) {
      snprintf(s_temp_buf, sizeof(s_temp_buf), "%d min", st->climate_runtime_min);
    } else {
      snprintf(s_temp_buf, sizeof(s_temp_buf), "ON");
    }
    text_layer_set_text(s_temp_layer, s_temp_buf);
    // "left of 30" gives the bare remaining figure some context.
    if (st->climate_runtime_min > 0 && st->climate_total_min > 0) {
      snprintf(s_title_buf, sizeof(s_title_buf), "Running, of %d min",
               st->climate_total_min);
      text_layer_set_text(s_title_layer, s_title_buf);
    } else {
      text_layer_set_text(s_title_layer, "Climate running");
    }
    text_layer_set_text(s_hint_layer, "SELECT to stop\nBACK to leave running");
    return;
  }

  text_layer_set_text(s_title_layer, "Cabin target");
  text_layer_set_text(s_hint_layer, "UP/DOWN adjust\nSELECT start, BACK cancel");
  if (st->temp_in_f) {
    int f10 = (s_temp_c10 * 9) / 5 + 320;
    snprintf(s_temp_buf, sizeof(s_temp_buf), "%d\u00B0F", (f10 + 5) / 10);
  } else {
    snprintf(s_temp_buf, sizeof(s_temp_buf), "%d.%d\u00B0C",
             s_temp_c10 / 10, s_temp_c10 % 10);
  }
  text_layer_set_text(s_temp_layer, s_temp_buf);
}

static void prv_adjust(int delta) {
  if (state_get()->climate_on) {
    return;   // nothing to adjust; this window is a stop control right now
  }
  s_temp_c10 += delta;
  if (s_temp_c10 < TEMP_MIN_C10) s_temp_c10 = TEMP_MIN_C10;
  if (s_temp_c10 > TEMP_MAX_C10) s_temp_c10 = TEMP_MAX_C10;
  prv_render();
}

static void prv_up_click(ClickRecognizerRef recognizer, void *context) {
  prv_adjust(TEMP_STEP_C10);
}

static void prv_down_click(ClickRecognizerRef recognizer, void *context) {
  prv_adjust(-TEMP_STEP_C10);
}

static void prv_select_click(ClickRecognizerRef recognizer, void *context) {
  // When climate is already running this window is a STOP control, not a
  // picker. Offering "start" while the engine is audibly running -- which is
  // what it did before it knew the state -- makes the app look like it has
  // lost track of the car.
  if (state_get()->climate_on) {
    comm_send_cmd(CMD_REMOTE_STOP);
    window_stack_remove(s_window, false);
    command_window_push(CMD_REMOTE_STOP, "Stopping climate...");
    return;
  }
  // Remember the choice so the next start defaults to it rather than making
  // the user dial the same number in every morning.
  state_set_climate_temp_c10(s_temp_c10);
  comm_send_cmd_with_temp(CMD_REMOTE_START, s_temp_c10);
  window_stack_remove(s_window, false);
  command_window_push(CMD_REMOTE_START, "Starting climate...");
}

static void prv_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, prv_up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  // Repeat so holding UP/DOWN sweeps the range instead of needing 26 presses.
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 120, prv_up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 120, prv_down_click);
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_title_layer = text_layer_create(GRect(4, 8, bounds.size.w - 8, 26));
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  s_temp_layer = text_layer_create(GRect(4, bounds.size.h / 2 - 34, bounds.size.w - 8, 46));
  text_layer_set_font(s_temp_layer, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD));
  text_layer_set_text_alignment(s_temp_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_temp_layer));

  s_hint_layer = text_layer_create(GRect(4, bounds.size.h - 56, bounds.size.w - 8, 52));
  text_layer_set_font(s_hint_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_hint_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_hint_layer, GTextOverflowModeWordWrap);
  layer_add_child(root, text_layer_get_layer(s_hint_layer));

  prv_render();
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_temp_layer);
  text_layer_destroy(s_hint_layer);
  window_destroy(s_window);
  s_window = NULL;
}

void climate_window_push(void) {
  s_temp_c10 = state_get_climate_temp_c10();
  if (s_temp_c10 < TEMP_MIN_C10 || s_temp_c10 > TEMP_MAX_C10) {
    s_temp_c10 = 210;   // 21.0 C
  }
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_set_click_config_provider(s_window, prv_click_config);
  window_stack_push(s_window, true);
}
