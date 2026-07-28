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

  if (!pos->valid || !pos->has_fix) {
    return; // nothing to draw -- the text layers explain why
  }

  // An UNCALIBRATED magnetometer does not merely add noise -- it compresses
  // the whole range. Measured beside the vehicle 2026-07-28: a full 360 degree
  // turn on the spot moved the reported heading through about 57 degrees, and
  // not monotonically, with status stuck at CompassStatusCalibrating
  // throughout. The arrow rendered that faithfully, so it looked like a
  // working compass pointing confidently in the wrong direction.
  //
  // Drawing nothing is the honest option. Someone acting on a wrong arrow
  // walks the wrong way across a car park; someone shown a calibration prompt
  // fixes it in five seconds. Distance stays visible either way -- it does not
  // depend on the compass.
  if (s_compass_status != CompassStatusCalibrated) {
    return;
  }

  // Heading convention, settled by observation rather than by the header.
  //
  // pebble.h says headings "increase counter-clockwise from magnetic north"
  // and suggests TRIG_MAX_ANGLE - heading to get a clockwise one. I applied
  // that conversion, and on real hardware it put the arrow 90 degrees out: the
  // car was at 10 o'clock and the arrow pointed at 1 o'clock, which is exactly
  // the 2*heading error you get from flipping a value that was already
  // clockwise. On this device/firmware true_heading is ALREADY clockwise from
  // north, so it can be subtracted from a standard bearing directly.
  //
  // The earlier round where this looked wrong without the conversion was a red
  // herring: the compass was reporting CompassStatusCalibrating throughout, so
  // the headings themselves were unreliable. The doc comment lost to the
  // measurement, which is the right way round.
  int32_t heading_deg = s_have_heading ? (s_true_heading * 360 / TRIG_MAX_ANGLE) : 0;
  int32_t angle_deg = pos->bearing_deg - heading_deg;
  while (angle_deg < 0) angle_deg += 360;
  angle_deg = angle_deg % 360;
  int32_t angle_trig = (angle_deg * TRIG_MAX_ANGLE) / 360;

  gpath_rotate_to(s_arrow_path, angle_trig);
  gpath_move_to(s_arrow_path, center);

  // "Unknown" quality is the NORMAL case on this vehicle -- positionQuality
  // never resolves to good/poor -- so treating it as uncertain painted the
  // arrow in the warning colour permanently. A warning that is always on is
  // not a warning; it just teaches the user to ignore the colour. Only a
  // reported-poor fix, or a stale one, counts.
  bool uncertain = (pos->quality == 1) || (pos->days_since_fix > 7) ||
                   !s_have_heading || s_compass_status != CompassStatusCalibrated;
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
  // The quality line doubles as the loading message, so it must be visible
  // BEFORE the first position arrives -- otherwise the window opens blank for
  // several seconds (two GPS fixes plus a round trip) and looks hung.
  layer_set_hidden(text_layer_get_layer(s_quality_layer), motion);
  layer_set_hidden(text_layer_get_layer(s_motion_layer), !motion);

  if (motion) {
    return;
  }

  if (!pos->valid) {
    text_layer_set_text(s_quality_layer,
      "Finding your car...\nThis needs a GPS fix and can take a few seconds.");
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


  // The arrow is only meaningful if the compass is actually working. Without
  // a heading we would silently draw the bearing relative to screen-up, which
  // looks like a working compass that points somewhere arbitrary -- and gives
  // the user nothing to act on. Say so, and say what fixes it.
  if (s_compass_status != CompassStatusCalibrated) {
    // Same message for "no data" and "still calibrating": in both cases we
    // have no direction worth showing, and the user's action is identical.
    // Naming the motion matters -- "calibrating" alone sounds like something
    // to wait out, and it will not finish on its own.
    snprintf(s_quality_buf, sizeof(s_quality_buf),
             "Compass not calibrated.\nWave the watch in a figure 8.");
    text_layer_set_text(s_quality_layer, s_quality_buf);
    return;
  }

  // Say something the user can act on. "Fix: unknown" is the vehicle failing
  // to report a quality value -- it tells the reader nothing except that the
  // app is unsure of itself. Age is the fact that actually matters: a
  // days-old position means the car may have been moved since.
  if (pos->quality == 1) {
    snprintf(s_quality_buf, sizeof(s_quality_buf),
             "Poor GPS fix from the car%s",
             pos->days_since_fix > 0 ? ", and days old" : "");
  } else if (pos->days_since_fix > 1) {
    snprintf(s_quality_buf, sizeof(s_quality_buf),
             "Car's position is %d days old", pos->days_since_fix);
  } else {
    snprintf(s_quality_buf, sizeof(s_quality_buf), "Last reported position");
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

  s_arrow_layer = layer_create(GRect(0, 0, bounds.size.w, bounds.size.h - 84));
  layer_set_update_proc(s_arrow_layer, prv_arrow_update_proc);
  layer_add_child(root, s_arrow_layer);

  s_distance_layer = text_layer_create(GRect(4, bounds.size.h - 82, bounds.size.w - 8, 28));
  text_layer_set_font(s_distance_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_distance_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_distance_layer));

  // Tall enough for the two-line loading message, not just the one-line
  // "Fix: poor, 3 day(s) old" it also carries.
  s_quality_layer = text_layer_create(GRect(4, bounds.size.h - 54, bounds.size.w - 8, 50));
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

  // 2 degrees, not 6. The coarser filter meant small turns produced no event
  // at all, so the arrow sat still while the world moved under it.
  compass_service_set_heading_filter(TRIG_MAX_ANGLE / 180);
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
