#pragma once

#include <pebble.h>

// In-RAM vehicle state, backed by a single persisted cache blob. This is the
// "cache-then-refresh" store: state_load_cache() populates this from persist
// at boot so the status window has something honest to draw before the
// first AppMessage round trip completes (never an empty screen), and every
// field setter here is also what comm.c calls as fresh data arrives from
// pkjs.

// Capability state for a single gated service. Mirrors jlr.js's
// serviceState()/landy-vehicle-capabilities.md section 2.4 exactly -- do not
// renumber without updating index.js's capEnum() to match.
typedef enum {
  CAP_AVAILABLE = 0,   // draw the button
  CAP_NOT_ENABLED = 1, // draw disabled; "not enabled on your InControl account"
  CAP_NOT_CAPABLE = 2, // hide the button permanently
  CAP_UNKNOWN = 3      // fail open -- draw it, let it fail once
} CapState;

// Outcome of the most recently completed command. Deliberately three
// terminal states plus "none yet" -- never collapse declined/pending into a
// generic failure (see landy-remote-research.md's "three distinct outcomes").
typedef enum {
  CMD_OUTCOME_NONE = 0,
  CMD_OUTCOME_SUCCESS = 1,
  CMD_OUTCOME_DECLINED = 2,
  CMD_OUTCOME_PENDING = 3,
  CMD_OUTCOME_ERROR = 4,
  // Refused by US, locally, before anything reached the network, because the
  // vehicle is or may be in motion. Distinct from DECLINED (the car refused):
  // the remedy differs and retrying while still moving is pointless.
  CMD_OUTCOME_BLOCKED_MOTION = 5
} CmdOutcome;

typedef struct {
  bool valid;              // false until the first status arrives (ever)
  bool locked;
  int fuel_perc;           // -1 = unknown
  int range_miles;         // -1 = unknown
  char vehicle_name[32];
  bool doors_open;
  bool windows_open;
  bool in_motion;         // display hint only -- the car is believed to be moving
  // Whether the phone layer will accept a command right now. Separate from
  // in_motion: read-only data is always shown, but nothing may ACTUATE the
  // vehicle without positive proof it is stationary.
  bool cmds_blocked;
  int odometer;           // in the user's chosen unit; -1 = unknown
  bool distance_in_km;    // false = miles
  bool temp_in_f;         // false = Celsius
  int tyre_unit;          // 0 = kPa, 1 = bar, 2 = psi
  bool climate_on;        // remote climate currently running
  int climate_runtime_min; // minutes it will keep running; -1 = unknown
  int climate_total_min;   // configured total run length; -1 = unknown
  int climate_temp_c10;   // last chosen remote-climate target; -1 = unset

  // Freshness: the phone reports "N seconds old" at message-construction
  // time; we store our own receipt time so the on-screen "updated Xm ago"
  // line keeps counting up between refreshes rather than freezing.
  int ago_sec_at_receipt;
  time_t received_at;

  CapState cap_lock;
  CapState cap_unlock;
  CapState cap_honk;
  CapState cap_refresh;
  CapState cap_remote_start;

  int tyre_fl_kpa;
  int tyre_fr_kpa;
  int tyre_rl_kpa;
  int tyre_rr_kpa;
  int service_km;          // -1 = unknown
  int adblue_km;            // -1 = unknown
  bool oil_warn;
  bool brake_fluid_warn;
  bool coolant_warn;
} VehicleState;

// Position/find-my-car state -- not persisted (deliberately: a stale
// distance/bearing is actively misleading in a way a stale fuel level
// isn't, so this always starts blank on a fresh app launch).
typedef struct {
  bool valid;
  bool has_fix;
  bool in_motion;
  int distance_m;
  int bearing_deg;   // true bearing from phone to car, degrees 0-359
  int quality;        // 0 = good, 1 = poor, 2 = unknown
  int age_sec;
  int days_since_fix; // -1 = unknown; TU_STATUS_DAYS_SINCE_GNSS_FIX
} PositionState;

void state_init(void);

VehicleState *state_get(void);
PositionState *state_get_position(void);

// True only after this process has received a fresh status update proving the
// phone is stationary. This value is deliberately not part of VehicleState,
// so persisted cache data can never unlock a later app session.
bool state_is_session_stationary_verified(void);

// Returns the live "updated N seconds ago" value, accounting for elapsed
// wall-clock time since the value was received.
int state_ago_seconds(void);

// Last cabin temperature chosen for remote climate, in tenths of a degree C.
// Persisted so a repeat start defaults to what you picked last time.
int state_get_climate_temp_c10(void);
void state_set_climate_temp_c10(int temp_c10);

void state_apply_status_update(DictionaryIterator *iter);
void state_apply_position_update(DictionaryIterator *iter);

void state_save_cache(void);
