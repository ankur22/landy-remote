#include "tyre_window.h"

#include <pebble.h>

#include "state.h"

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_tyres_layer;
static TextLayer *s_service_layer;
static TextLayer *s_warn_layer;

static char s_tyres_buf[96];
static char s_service_buf[96];
static char s_warn_buf[64];

// Values arrive as TENTHS of the user's chosen unit, already normalised and
// converted by pkjs -- the raw vehicle scale differs by model generation, so
// the watch must never try to interpret it. bar needs one decimal (2.2 bar);
// kPa and psi are whole numbers at the precision a tyre gauge offers.
static void prv_append_pressure(char *buf, size_t buf_len, size_t *used,
                                const char *label, int value_x10, int unit) {
  int written;
  if (value_x10 < 0) {
    written = snprintf(buf + *used, buf_len - *used, "%s: --\n", label);
  } else if (unit == 1) {
    written = snprintf(buf + *used, buf_len - *used, "%s: %d.%d bar\n",
                       label, value_x10 / 10, value_x10 % 10);
  } else {
    written = snprintf(buf + *used, buf_len - *used, "%s: %d %s\n",
                       label, (value_x10 + 5) / 10, unit == 2 ? "psi" : "kPa");
  }
  if (written > 0) {
    *used += (size_t) written;
  }
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  VehicleState *st = state_get();

  s_title_layer = text_layer_create(GRect(6, 4, bounds.size.w - 12, 24));
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text(s_title_layer, "Tyres & Service");
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  size_t used = 0;
  s_tyres_buf[0] = '\0';
  prv_append_pressure(s_tyres_buf, sizeof(s_tyres_buf), &used, "FL", st->tyre_fl_kpa, st->tyre_unit);
  prv_append_pressure(s_tyres_buf, sizeof(s_tyres_buf), &used, "FR", st->tyre_fr_kpa, st->tyre_unit);
  prv_append_pressure(s_tyres_buf, sizeof(s_tyres_buf), &used, "RL", st->tyre_rl_kpa, st->tyre_unit);
  prv_append_pressure(s_tyres_buf, sizeof(s_tyres_buf), &used, "RR", st->tyre_rr_kpa, st->tyre_unit);

  s_tyres_layer = text_layer_create(GRect(6, 30, bounds.size.w - 12, 92));
  text_layer_set_font(s_tyres_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text(s_tyres_layer, s_tyres_buf);
  layer_add_child(root, text_layer_get_layer(s_tyres_layer));

  // Distances arrive already converted to the user's chosen unit -- pkjs does
  // every conversion so the two sides can never disagree. We only pick a label.
  const char *dist_unit = st->distance_in_km ? "km" : "mi";
  int service_used = 0;
  s_service_buf[0] = '\0';
  if (st->odometer >= 0) {
    service_used += snprintf(s_service_buf + service_used,
                             sizeof(s_service_buf) - service_used,
                             "Total %d %s\n", st->odometer, dist_unit);
  }
  if (st->service_km >= 0 && st->adblue_km >= 0) {
    snprintf(s_service_buf + service_used, sizeof(s_service_buf) - service_used,
             "Service in %d %s\nAdBlue range %d %s",
             st->service_km, dist_unit, st->adblue_km, dist_unit);
  } else if (st->odometer < 0) {
    snprintf(s_service_buf, sizeof(s_service_buf), "Service info unknown");
  }
  s_service_layer = text_layer_create(GRect(6, 116, bounds.size.w - 12, 60));
  text_layer_set_font(s_service_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text(s_service_layer, s_service_buf);
  layer_add_child(root, text_layer_get_layer(s_service_layer));

  s_warn_buf[0] = '\0';
  if (st->oil_warn) { strncat(s_warn_buf, "Oil ", sizeof(s_warn_buf) - strlen(s_warn_buf) - 1); }
  if (st->brake_fluid_warn) { strncat(s_warn_buf, "Brake fluid ", sizeof(s_warn_buf) - strlen(s_warn_buf) - 1); }
  if (st->coolant_warn) { strncat(s_warn_buf, "Coolant ", sizeof(s_warn_buf) - strlen(s_warn_buf) - 1); }
  bool any_warn = s_warn_buf[0] != '\0';

  s_warn_layer = text_layer_create(GRect(6, bounds.size.h - 34, bounds.size.w - 12, 30));
  text_layer_set_font(s_warn_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_color(s_warn_layer, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
  text_layer_set_text(s_warn_layer, any_warn ? s_warn_buf : "No active warnings");
  if (!any_warn) {
    text_layer_set_text_color(s_warn_layer, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  }
  layer_add_child(root, text_layer_get_layer(s_warn_layer));
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_tyres_layer);
  text_layer_destroy(s_service_layer);
  text_layer_destroy(s_warn_layer);
  window_destroy(s_window);
  s_window = NULL;
}

void tyre_window_push(void) {
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
}
