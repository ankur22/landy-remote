#include "confirm_window.h"

#include <pebble.h>

#include "comm.h"
#include "command_window.h"

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_body_layer;
static TextLayer *s_hint_layer;

static void prv_select_click_handler(ClickRecognizerRef recognizer, void *context) {
  comm_send_cmd(CMD_UNLOCK);
  command_window_push(CMD_UNLOCK, "Unlocking...");
}

static void prv_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click_handler);
  // BACK is left to the default window-stack pop behaviour -- cancel.
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_title_layer = text_layer_create(GRect(8, 10, bounds.size.w - 16, 30));
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter);
  text_layer_set_text(s_title_layer, "Unlock car?");
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  s_body_layer = text_layer_create(GRect(6, 46, bounds.size.w - 12, bounds.size.h - 96));
  text_layer_set_font(s_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_body_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_body_layer, GTextOverflowModeWordWrap);
  text_layer_set_text(s_body_layer,
    "Driver's door only.\nRelocks after ~45s.");
  layer_add_child(root, text_layer_get_layer(s_body_layer));

  s_hint_layer = text_layer_create(GRect(4, bounds.size.h - 44, bounds.size.w - 8, 40));
  text_layer_set_font(s_hint_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_overflow_mode(s_hint_layer, GTextOverflowModeWordWrap);
  text_layer_set_text_alignment(s_hint_layer, GTextAlignmentCenter);
  text_layer_set_text(s_hint_layer, "SELECT confirm\nBACK cancel");
  layer_add_child(root, text_layer_get_layer(s_hint_layer));
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_body_layer);
  text_layer_destroy(s_hint_layer);
  window_destroy(s_window);
  s_window = NULL;
}

void confirm_window_push(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, prv_click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
}
