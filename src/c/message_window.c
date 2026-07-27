#include "message_window.h"

#include <pebble.h>

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_body_layer;
static char s_title_buf[32];
static char s_body_buf[160];

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_title_layer = text_layer_create(GRect(8, 14, bounds.size.w - 16, 32));
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter);
  text_layer_set_text(s_title_layer, s_title_buf);
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  s_body_layer = text_layer_create(GRect(8, 54, bounds.size.w - 16, bounds.size.h - 70));
  text_layer_set_font(s_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_body_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_body_layer, GTextOverflowModeWordWrap);
  text_layer_set_text(s_body_layer, s_body_buf);
  layer_add_child(root, text_layer_get_layer(s_body_layer));
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_body_layer);
  window_destroy(s_window);
  s_window = NULL;
}

void message_window_push(const char *title, const char *body) {
  strncpy(s_title_buf, title, sizeof(s_title_buf) - 1);
  s_title_buf[sizeof(s_title_buf) - 1] = '\0';
  strncpy(s_body_buf, body, sizeof(s_body_buf) - 1);
  s_body_buf[sizeof(s_body_buf) - 1] = '\0';

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
}
