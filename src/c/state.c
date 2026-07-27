#include "state.h"

// Single persist key holding the whole VehicleState blob. VehicleState is
// small (well under the 256 bytes/key limit measured on emery) and there is
// only ever one vehicle, so one key is enough -- no need for econfeed's
// per-section striding.
#define PERSIST_STATE_KEY 1
#define PERSIST_MARKER_KEY 2  // written last; see state_save_cache()

static VehicleState s_state;
static PositionState s_position;
static bool s_session_stationary_verified;

static void prv_defaults(void) {
  memset(&s_state, 0, sizeof(s_state));
  s_session_stationary_verified = false;
  s_state.valid = false;
  s_state.fuel_perc = -1;
  s_state.range_miles = -1;
  s_state.service_km = -1;
  s_state.adblue_km = -1;
  s_state.tyre_fl_kpa = -1;
  s_state.tyre_fr_kpa = -1;
  s_state.tyre_rl_kpa = -1;
  s_state.tyre_rr_kpa = -1;
  s_state.cap_lock = CAP_UNKNOWN;
  s_state.cap_unlock = CAP_UNKNOWN;
  s_state.cap_honk = CAP_UNKNOWN;
  s_state.cap_refresh = CAP_UNKNOWN;
  s_state.cap_remote_start = CAP_UNKNOWN;
  strncpy(s_state.vehicle_name, "Vehicle", sizeof(s_state.vehicle_name) - 1);

  memset(&s_position, 0, sizeof(s_position));
  s_position.quality = 2; // unknown
  s_position.days_since_fix = -1;
}

static void prv_load_cache(void) {
  if (!persist_exists(PERSIST_MARKER_KEY) || !persist_exists(PERSIST_STATE_KEY)) {
    return;
  }
  VehicleState loaded;
  int read = persist_read_data(PERSIST_STATE_KEY, &loaded, sizeof(loaded));
  if (read != sizeof(loaded)) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "state: cache read size mismatch (%d), ignoring", read);
    return;
  }
  loaded.vehicle_name[sizeof(loaded.vehicle_name) - 1] = '\0';
  s_state = loaded;
  APP_LOG(APP_LOG_LEVEL_DEBUG, "state: loaded cached status, locked=%d fuel=%d",
          s_state.locked, s_state.fuel_perc);
}

void state_init(void) {
  prv_defaults();
  prv_load_cache();
}

VehicleState *state_get(void) {
  return &s_state;
}

PositionState *state_get_position(void) {
  return &s_position;
}

bool state_is_session_stationary_verified(void) {
  return s_session_stationary_verified;
}

int state_ago_seconds(void) {
  if (!s_state.valid || s_state.ago_sec_at_receipt < 0) {
    return -1;
  }
  time_t elapsed = time(NULL) - s_state.received_at;
  if (elapsed < 0) {
    elapsed = 0;
  }
  return s_state.ago_sec_at_receipt + (int) elapsed;
}

// Reads an int32 tuple by key, returning `fallback` if absent. Used
// liberally below because the phone omits most fields entirely while the
// vehicle is in motion (see index.js) -- absence is expected, not an error.
static int prv_int_or(DictionaryIterator *iter, uint32_t key, int fallback) {
  Tuple *t = dict_find(iter, key);
  if (!t) {
    return fallback;
  }
  return (int) t->value->int32;
}

static bool prv_bool_or(DictionaryIterator *iter, uint32_t key, bool fallback) {
  Tuple *t = dict_find(iter, key);
  if (!t) {
    return fallback;
  }
  return t->value->int32 != 0;
}

void state_apply_status_update(DictionaryIterator *iter) {
  bool in_motion = prv_bool_or(iter, MESSAGE_KEY_STATUS_IN_MOTION, false);
  s_session_stationary_verified = !in_motion;
  s_state.in_motion = in_motion;
  s_state.valid = true;

  if (in_motion) {
    // Per the safety rule, a motion push carries nothing else -- do not
    // overwrite any other field (there's nothing to overwrite it WITH), and
    // do not clear the cached values either: the moment motion clears, the
    // last-known status should reappear rather than a blank screen while a
    // fresh non-moving update is fetched. The in_motion flag alone is what
    // the status window checks before drawing anything sensitive.
    state_save_cache();
    return;
  }

  s_state.locked = prv_bool_or(iter, MESSAGE_KEY_STATUS_LOCKED, s_state.locked);
  s_state.fuel_perc = prv_int_or(iter, MESSAGE_KEY_STATUS_FUEL_PERC, s_state.fuel_perc);
  s_state.range_miles = prv_int_or(iter, MESSAGE_KEY_STATUS_RANGE_MILES, s_state.range_miles);
  s_state.doors_open = prv_bool_or(iter, MESSAGE_KEY_STATUS_DOORS_OPEN, s_state.doors_open);
  s_state.windows_open = prv_bool_or(iter, MESSAGE_KEY_STATUS_WINDOWS_OPEN, s_state.windows_open);
  s_state.ago_sec_at_receipt = prv_int_or(iter, MESSAGE_KEY_STATUS_UPDATED_AGO_SEC, -1);
  s_state.received_at = time(NULL);

  Tuple *name_tuple = dict_find(iter, MESSAGE_KEY_STATUS_VEHICLE_NAME);
  if (name_tuple && name_tuple->length > 1) {
    strncpy(s_state.vehicle_name, name_tuple->value->cstring, sizeof(s_state.vehicle_name) - 1);
    s_state.vehicle_name[sizeof(s_state.vehicle_name) - 1] = '\0';
  }

  s_state.cap_lock = (CapState) prv_int_or(iter, MESSAGE_KEY_CAP_LOCK, s_state.cap_lock);
  s_state.cap_unlock = (CapState) prv_int_or(iter, MESSAGE_KEY_CAP_UNLOCK, s_state.cap_unlock);
  s_state.cap_honk = (CapState) prv_int_or(iter, MESSAGE_KEY_CAP_HONK, s_state.cap_honk);
  s_state.cap_refresh = (CapState) prv_int_or(iter, MESSAGE_KEY_CAP_REFRESH, s_state.cap_refresh);
  s_state.cap_remote_start = (CapState) prv_int_or(iter, MESSAGE_KEY_CAP_REMOTE_START, s_state.cap_remote_start);

  s_state.tyre_fl_kpa = prv_int_or(iter, MESSAGE_KEY_TYRE_FL_KPA, s_state.tyre_fl_kpa);
  s_state.tyre_fr_kpa = prv_int_or(iter, MESSAGE_KEY_TYRE_FR_KPA, s_state.tyre_fr_kpa);
  s_state.tyre_rl_kpa = prv_int_or(iter, MESSAGE_KEY_TYRE_RL_KPA, s_state.tyre_rl_kpa);
  s_state.tyre_rr_kpa = prv_int_or(iter, MESSAGE_KEY_TYRE_RR_KPA, s_state.tyre_rr_kpa);
  s_state.service_km = prv_int_or(iter, MESSAGE_KEY_SERVICE_KM, s_state.service_km);
  s_state.adblue_km = prv_int_or(iter, MESSAGE_KEY_ADBLUE_KM, s_state.adblue_km);
  s_state.oil_warn = prv_bool_or(iter, MESSAGE_KEY_OIL_WARN, s_state.oil_warn);
  s_state.brake_fluid_warn = prv_bool_or(iter, MESSAGE_KEY_BRAKE_FLUID_WARN, s_state.brake_fluid_warn);
  s_state.coolant_warn = prv_bool_or(iter, MESSAGE_KEY_COOLANT_WARN, s_state.coolant_warn);

  state_save_cache();
}

void state_apply_position_update(DictionaryIterator *iter) {
  bool in_motion = prv_bool_or(iter, MESSAGE_KEY_STATUS_IN_MOTION, false);
  s_position.in_motion = in_motion;
  s_position.valid = true;

  if (in_motion) {
    s_position.has_fix = false;
    return;
  }

  s_position.has_fix = prv_bool_or(iter, MESSAGE_KEY_POS_HAS_FIX, false);
  s_position.distance_m = prv_int_or(iter, MESSAGE_KEY_POS_DISTANCE_M, -1);
  s_position.bearing_deg = prv_int_or(iter, MESSAGE_KEY_POS_BEARING_DEG, -1);
  s_position.quality = prv_int_or(iter, MESSAGE_KEY_POS_QUALITY, 2);
  s_position.age_sec = prv_int_or(iter, MESSAGE_KEY_POS_AGE_SEC, -1);
  s_position.days_since_fix = prv_int_or(iter, MESSAGE_KEY_POS_DAYS_SINCE_FIX, -1);
}

void state_save_cache(void) {
  // Marker-last write pattern (per econfeed's data.c): if the data write
  // fails partway, the marker never gets written, so prv_load_cache() can
  // never read back a truncated/corrupt cache as valid.
  persist_delete(PERSIST_MARKER_KEY);
  status_t data_status = persist_write_data(PERSIST_STATE_KEY, &s_state, sizeof(s_state));
  if (data_status < 0) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "state: persist write failed (%d), not caching", (int) data_status);
    return;
  }
  persist_write_bool(PERSIST_MARKER_KEY, true);
}
