#include "find_car_window.h"

#include <pebble.h>

#include "comm.h"
#include "state.h"

static Window *s_window;
static Layer *s_arrow_layer;
static TextLayer *s_distance_layer;
static TextLayer *s_quality_layer;
static TextLayer *s_motion_layer;

static char s_distance_buf[32];
static char s_quality_buf[64];

static CompassHeading s_true_heading;
static bool s_have_heading;
static CompassStatus s_compass_status = CompassStatusDataInvalid;

static GPath *s_arrow_path;
// Simple arrow pointing "up" (north on screen, angle 0) before rotation:
// a long shaft with a wide arrowhead, centered on (0,0).
static const GPathInfo ARROW_PATH_INFO = {
  .num_points = 7,
  .points = (GPoint[]) {
    { 0, -50 },   // tip
    { 20, -18 },  // right barb
    { 8, -18 },
    { 8, 40 },    // tail right
    { -8, 40 },   // tail left
    { -8, -18 },
    { -20, -18 }, // left barb
  }
};

static void prv_arrow_update_proc(Layer *layer, GContext *ctx) {
  PositionState *pos = state_get_position();
  GRect bounds = layer_get_bounds(layer);
  GPoint center = GPoint(bounds.size.w / 2, bounds.size.h / 2);

  if (!pos->valid || pos->in_motion || !pos->has_fix) {
    return; // nothing to draw -- the text layers explain why
  }

  int32_t heading_deg = s_have_heading ? (s_true_heading * 360 / TRIG_MAX_ANGLE) : 0;
  int32_t angle_deg = pos->bearing_deg - heading_deg;
  while (angle_deg < 0) angle_deg += 360;
  angle_deg = angle_deg % 360;
  int32_t angle_trig = (angle_deg * TRIG_MAX_ANGLE) / 360;

  gpath_rotate_to(s_arrow_path, angle_trig);
  gpath_move_to(s_arrow_path, center);

  bool uncertain = (pos->quality != 0) || !s_have_heading || s_compass_status != CompassStatusCalibrated;
  graphics_context_set_fill_color(ctx, uncertain ?
    PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack) : PBL_IF_COLOR_ELSE(GColorDarkGreen, GColorBlack));
  gpath_draw_filled(ctx, s_arrow_path);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  gpath_draw_outline(ctx, s_arrow_path);
}

static void prv_refresh(void) {
  PositionState *pos = state_get_position();
  bool motion = pos->valid && pos->in_motion;

  layer_set_hidden(s_arrow_layer, motion || !pos->valid || !pos->has_fix);
  layer_set_hidden(text_layer_get_layer(s_distance_layer), motion || !pos->valid || !pos->has_fix);
  layer_set_hidden(text_layer_get_layer(s_quality_layer), motion || !pos->valid);
  layer_set_hidden(text_layer_get_layer(s_motion_layer), !motion);

  if (motion) {
    return;
  }

  if (!pos->valid) {
    text_layer_set_text(s_quality_layer, "Locating...");
    return;
  }

  if (!pos->has_fix) {
    text_layer_set_text(s_quality_layer, "No position available from the car.");
    return;
  }

  if (pos->distance_m < 1000) {
    snprintf(s_distance_buf, sizeof(s_distance_buf), "%d m", pos->distance_m);
  } else {
    snprintf(s_distance_buf, sizeof(s_distance_buf), "%d.%d km", pos->distance_m / 1000,
             (pos->distance_m % 1000) / 100);
  }
  text_layer_set_text(s_distance_layer, s_distance_buf);

  // Surface uncertainty rather than hiding it -- a confidently-wrong arrow
  // is worse than an honestly-hedged one (see the research doc's
  // find-my-car section and TU_STATUS_DAYS_SINCE_GNSS_FIX).
  const char *quality_str = (pos->quality == 0) ? "good" : (pos->quality == 1) ? "poor" : "unknown";
  if (pos->days_since_fix > 0) {
    snprintf(s_quality_buf, sizeof(s_quality_buf), "Fix: %s, %d day(s) old", quality_str, pos->days_since_fix);
  } else {
    snprintf(s_quality_buf, sizeof(s_quality_buf), "Fix: %s", quality_str);
  }
  text_layer_set_text(s_quality_layer, s_quality_buf);

  layer_mark_dirty(s_arrow_layer);
}

static void prv_compass_handler(CompassHeadingData data) {
  s_true_heading = data.true_heading;
  s_compass_status = data.compass_status;
  s_have_heading = (data.compass_status != CompassStatusDataInvalid);
  layer_mark_dirty(s_arrow_layer);
}

static void prv_position_updated(void) {
  prv_refresh();
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_arrow_path = gpath_create(&ARROW_PATH_INFO);

  s_arrow_layer = layer_create(GRect(0, 0, bounds.size.w, bounds.size.h - 50));
  layer_set_update_proc(s_arrow_layer, prv_arrow_update_proc);
  layer_add_child(root, s_arrow_layer);

  s_distance_layer = text_layer_create(GRect(4, bounds.size.h - 74, bounds.size.w - 8, 30));
  text_layer_set_font(s_distance_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_distance_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_distance_layer));

  s_quality_layer = text_layer_create(GRect(4, bounds.size.h - 40, bounds.size.w - 8, 36));
  text_layer_set_font(s_quality_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_quality_layer, GTextAlignmentCenter);
  text_layer_set_text_color(s_quality_layer, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  text_layer_set_overflow_mode(s_quality_layer, GTextOverflowModeWordWrap);
  layer_add_child(root, text_layer_get_layer(s_quality_layer));

  s_motion_layer = text_layer_create(GRect(8, bounds.size.h / 2 - 30, bounds.size.w - 16, 60));
  text_layer_set_font(s_motion_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_motion_layer, GTextAlignmentCenter);
  text_layer_set_text_color(s_motion_layer, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
  text_layer_set_text(s_motion_layer, "Vehicle in motion");
  layer_add_child(root, text_layer_get_layer(s_motion_layer));

  compass_service_set_heading_filter(TRIG_MAX_ANGLE / 60); // ~6 degrees
  compass_service_subscribe(prv_compass_handler);

  comm_set_position_callback(prv_position_updated);
  prv_refresh();
  comm_send_cmd(CMD_GET_POSITION);
}

static void prv_window_unload(Window *window) {
  compass_service_unsubscribe();
  comm_set_position_callback(NULL);
  gpath_destroy(s_arrow_path);
  layer_destroy(s_arrow_layer);
  text_layer_destroy(s_distance_layer);
  text_layer_destroy(s_quality_layer);
  text_layer_destroy(s_motion_layer);
  window_destroy(s_window);
  s_window = NULL;
}

void find_car_window_push(void) {
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
}
