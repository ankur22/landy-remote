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

static void prv_append_kpa(char *buf, size_t buf_len, size_t *used, const char *label, int kpa) {
  int written;
  if (kpa < 0) {
    written = snprintf(buf + *used, buf_len - *used, "%s: --\n", label);
  } else {
    written = snprintf(buf + *used, buf_len - *used, "%s: %d kPa\n", label, kpa);
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
  prv_append_kpa(s_tyres_buf, sizeof(s_tyres_buf), &used, "FL", st->tyre_fl_kpa);
  prv_append_kpa(s_tyres_buf, sizeof(s_tyres_buf), &used, "FR", st->tyre_fr_kpa);
  prv_append_kpa(s_tyres_buf, sizeof(s_tyres_buf), &used, "RL", st->tyre_rl_kpa);
  prv_append_kpa(s_tyres_buf, sizeof(s_tyres_buf), &used, "RR", st->tyre_rr_kpa);

  s_tyres_layer = text_layer_create(GRect(6, 30, bounds.size.w - 12, 92));
  text_layer_set_font(s_tyres_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text(s_tyres_layer, s_tyres_buf);
  layer_add_child(root, text_layer_get_layer(s_tyres_layer));

  if (st->service_km >= 0 && st->adblue_km >= 0) {
    snprintf(s_service_buf, sizeof(s_service_buf), "Service in %d km\nAdBlue range %d km",
             st->service_km, st->adblue_km);
  } else {
    snprintf(s_service_buf, sizeof(s_service_buf), "Service info unknown");
  }
  s_service_layer = text_layer_create(GRect(6, 122, bounds.size.w - 12, 44));
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
