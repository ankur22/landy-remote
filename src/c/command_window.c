#include "command_window.h"

#include <pebble.h>

#include "comm.h"
#include "state.h"

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_body_layer;
static TextLayer *s_hint_layer;
// Elapsed-time ticker. These commands genuinely take 5-20s and sometimes
// longer, and a screen that says "Please wait..." for 40 seconds with nothing
// moving is indistinguishable from one that has hung. A counting number is
// the cheapest possible proof that the app is still alive.
static AppTimer *s_tick_timer;
static int s_elapsed_s;
static char s_wait_buf[48];

static char s_title_buf[24];
static char s_body_buf[140];

// Which command this window instance is currently waiting on. CMD values
// start at 1 (see comm.h) so 0 means "not waiting for anything" -- results
// for any other cmd are ignored (e.g. a stray result arriving after the
// user has already backed out).
static Cmd s_active_cmd = (Cmd) 0;
static bool s_window_open;
static bool s_retry_allowed;

static void prv_select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (!s_retry_allowed) {
    return;
  }
  s_retry_allowed = false;
  text_layer_set_text(s_body_layer, "Contacting car...");
  text_layer_set_text_color(s_body_layer, GColorBlack);
  text_layer_set_text(s_hint_layer, "Please wait...");
  comm_send_cmd(s_active_cmd);
}

static void prv_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click_handler);
}

static void prv_set_body(const char *text, GColor color) {
  strncpy(s_body_buf, text, sizeof(s_body_buf) - 1);
  s_body_buf[sizeof(s_body_buf) - 1] = '\0';
  text_layer_set_text(s_body_layer, s_body_buf);
  text_layer_set_text_color(s_body_layer, color);
}

static void prv_tick(void *context) {
  s_tick_timer = NULL;
  if (!s_window_open) return;
  s_elapsed_s++;
  if (s_elapsed_s >= 20) {
    // Past the point where most commands land. Say what is actually going on
    // rather than counting silently: the car is usually asleep, and it often
    // completes after we stop waiting.
    snprintf(s_wait_buf, sizeof(s_wait_buf),
             "%ds - waking the car\ncan take a while", s_elapsed_s);
  } else {
    snprintf(s_wait_buf, sizeof(s_wait_buf), "Please wait... %ds", s_elapsed_s);
  }
  text_layer_set_text(s_hint_layer, s_wait_buf);
  s_tick_timer = app_timer_register(1000, prv_tick, NULL);
}

static void prv_start_ticking(void) {
  s_elapsed_s = 0;
  snprintf(s_wait_buf, sizeof(s_wait_buf), "Please wait... 0s");
  text_layer_set_text(s_hint_layer, s_wait_buf);
  if (s_tick_timer) app_timer_cancel(s_tick_timer);
  s_tick_timer = app_timer_register(1000, prv_tick, NULL);
}

static void prv_stop_ticking(void) {
  if (s_tick_timer) {
    app_timer_cancel(s_tick_timer);
    s_tick_timer = NULL;
  }
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_title_layer = text_layer_create(GRect(8, 10, bounds.size.w - 16, 28));
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter);
  text_layer_set_text(s_title_layer, s_title_buf);
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  s_body_layer = text_layer_create(GRect(8, 50, bounds.size.w - 16, bounds.size.h - 90));
  text_layer_set_font(s_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_body_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_body_layer, GTextOverflowModeWordWrap);
  text_layer_set_text(s_body_layer, "Contacting car...");
  layer_add_child(root, text_layer_get_layer(s_body_layer));

  s_hint_layer = text_layer_create(GRect(8, bounds.size.h - 30, bounds.size.w - 16, 26));
  text_layer_set_font(s_hint_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_hint_layer, GTextAlignmentCenter);
  text_layer_set_text_color(s_hint_layer, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  text_layer_set_text(s_hint_layer, "Please wait...");
  layer_add_child(root, text_layer_get_layer(s_hint_layer));

  s_window_open = true;
  prv_start_ticking();
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_body_layer);
  text_layer_destroy(s_hint_layer);
  window_destroy(s_window);
  s_window = NULL;
  prv_stop_ticking();
  s_window_open = false;
  s_active_cmd = (Cmd) 0;
}

void command_window_push(Cmd cmd, const char *title) {
  strncpy(s_title_buf, title, sizeof(s_title_buf) - 1);
  s_title_buf[sizeof(s_title_buf) - 1] = '\0';
  s_active_cmd = cmd;
  s_retry_allowed = false;

  s_window = window_create();
  window_set_click_config_provider(s_window, prv_click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
}

void command_window_handle_result(Cmd cmd, int outcome, const char *message) {
  prv_stop_ticking();
  if (!s_window_open || cmd != s_active_cmd) {
    return; // not for the window currently on screen -- ignore
  }
  s_retry_allowed = (outcome == CMD_OUTCOME_PENDING || outcome == CMD_OUTCOME_ERROR);
  switch (outcome) {
    case CMD_OUTCOME_SUCCESS:
      prv_set_body(message, PBL_IF_COLOR_ELSE(GColorDarkGreen, GColorBlack));
      text_layer_set_text(s_hint_layer, "BACK to close");
      break;
    case CMD_OUTCOME_DECLINED:
      prv_set_body(message, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
      text_layer_set_text(s_hint_layer, "Retrying won't help right now");
      break;
    case CMD_OUTCOME_PENDING:
      prv_set_body(message, PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack));
      text_layer_set_text(s_hint_layer, "SELECT to retry, BACK to close");
      break;
    case CMD_OUTCOME_BLOCKED_MOTION:
      // We refused this ourselves. Offering a retry would be misleading -- it
      // will be refused again until the vehicle stops.
      prv_set_body(message, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
      text_layer_set_text(s_hint_layer, "BACK to close");
      break;
    default:
      prv_set_body(message, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
      text_layer_set_text(s_hint_layer, "SELECT to retry, BACK to close");
      break;
  }
}

bool command_window_is_open(void) {
  return s_window_open;
}

void command_window_handle_error(const char *message) {
  if (!s_window_open) {
    return;
  }
  prv_set_body(message, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
  text_layer_set_text(s_hint_layer, "BACK to close");
}
