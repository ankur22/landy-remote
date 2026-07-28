// PebbleKit JS entry point -- AppMessage policy bridge between the on-watch C
// UI and an interchangeable mock or real backend facade.
//
// USE_MOCK is the build-time switch the milestone brief asks for. Wiring
// the real backend (src/pkjs/jlr.js, already built + tested in milestone 2)
// is milestone 4's job -- flip this and give the real client a `getBundle`/
// `getPosition`/`sendCommand` adapter shaped like MockClient's when that
// milestone starts (see README "Toggling mock mode").
var USE_MOCK = false;

var JLR = require('./jlr');
var MOCK = require('./mock');
var REAL = require('./real');
var CONFIG = require('./config');
var SELFTEST = require('./selftest');
var ANALYTICS = require('./analytics');

// Anonymous usage counters. See analytics.js for exactly what is and is not
// sent. Every call below happens AFTER the user-visible work is finished, so a
// dead endpoint can never delay a command or a screen.
var analytics = ANALYTICS.create({ version: '1.0.0', log: log });
var capabilitiesReported = false;

// ---------------------------------------------------------------- climate state
//
// CLIMATE_STATUS_OPERATING_STATUS is minutes-stale: after a remote start the
// car keeps reporting OFF for a while, so a UI trusting it alone shows
// "climate off" while the engine is audibly running -- and offers Start again
// rather than Stop. The reference implementation carries the same workaround.
// We hold a short assumption after a command we know succeeded, and let the
// vehicle's own reading take over once it catches up.
var CLIMATE_ACTIVE_STATES = {
  COOLING: 1, HEATING: 1, PRECLIM: 1, ENGINE_ON: 1, RUNNING: 1, STARTUP: 1, ON: 1
};
var CLIMATE_ASSUMED_ON_MS = 30 * 60 * 1000;   // JLR auto-stops around here
var CLIMATE_ASSUMED_OFF_MS = 15 * 60 * 1000;

// PERSISTED, not held in memory. pkjs is torn down when the watchapp exits, so
// an in-memory assumption is lost exactly when it is needed most: start
// climate, leave the app, come back, and the car is still reporting the stale
// OFF while the engine runs. localStorage survives that.
var CLIMATE_ON_UNTIL_KEY = 'jlr_climate_on_until';
var CLIMATE_OFF_UNTIL_KEY = 'jlr_climate_off_until';

function assumeUntil(key, ms) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.setItem(key, String(Date.now() + ms));
    }
  } catch (e) { /* best effort */ }
}

function assumedUntil(key) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return 0;
    var v = parseInt(localStorage.getItem(key), 10);
    return isNaN(v) ? 0 : v;
  } catch (e) { return 0; }
}

function clearAssumption(key) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.removeItem(key);
    }
  } catch (e) { /* best effort */ }
}

function climateIsOn(status) {
  var now = Date.now();
  var state = String(status.CLIMATE_STATUS_OPERATING_STATUS || '').toUpperCase();
  var vehicleSaysOn = CLIMATE_ACTIVE_STATES[state] === 1;
  var onUntil = assumedUntil(CLIMATE_ON_UNTIL_KEY);
  var offUntil = assumedUntil(CLIMATE_OFF_UNTIL_KEY);

  // The owner's Discovery reports CLIMATE_STATUS_OPERATING_STATUS = "OFF"
  // even while remote climate is audibly running (observed 2026-07-28), so
  // that key alone is not a usable signal on this vehicle.
  //
  // Remote climate on an ICE car IS the engine running, so VEHICLE_STATE_TYPE
  // is the better signal. Note this is the same key deliberately excluded from
  // motionState -- and the distinction matters: a running engine says nothing
  // about whether the car is MOVING, but it says everything about whether
  // climate is on.
  // Confirmed on the owner's vehicle 2026-07-28: while remote climate runs,
  // VEHICLE_STATE_TYPE = "ENGINE_ON_REMOTE_START" -- and the climate key still
  // reads OFF. Parked it reads "KEY_ON_ENGINE_OFF", hence the ENGINE_OFF
  // exclusion, which must stay: "KEY_ON_ENGINE_OFF" contains "ENGINE_OF"...
  // but not "ENGINE_ON", so order matters less than the explicit exclusion.
  var vst = String(status.VEHICLE_STATE_TYPE || '').toUpperCase();
  var engineRunning = /ENGINE_ON|ENGINE_RUNNING|ENGINE_START/.test(vst) &&
                      !/ENGINE_OFF/.test(vst);


  if (now < offUntil) return false;                    // we just stopped it
  if (vehicleSaysOn || engineRunning) return true;     // the car is authoritative
  if (now < onUntil) return true;                      // we started it; car lagging
  return false;
}

// The configured total run length (CLIMATE_STATUS_VENTING_TIME, 30 on this
// car). Used for display context only -- "14 of 30" says how far through you
// are, which a bare "14 min" does not.
//
// NOT used to infer whether climate is running, and this is now MEASURED
// rather than cautious. The rule "REMAINING < VENTING means running" fits the
// idle and running dumps -- but a dump taken shortly after stopping showed
// REMAINING = 9 against VENTING = 30. It does not reset; it freezes wherever
// the countdown stopped. That rule would therefore report climate running
// indefinitely after any use: a permanent false "on" rather than an obvious
// glitch. VEHICLE_STATE_TYPE is explicit and observed; this is not usable.
function climateTotalMin(status) {
  var n = parseInt(status.CLIMATE_STATUS_VENTING_TIME, 10);
  return isNaN(n) || n <= 0 ? -1 : n;
}

function climateRuntimeMin(status) {
  var n = parseInt(status.CLIMATE_STATUS_REMAINING_RUNTIME, 10);
  return isNaN(n) || n < 0 ? -1 : n;
}

var rawClient = USE_MOCK ? null : new JLR.Client();
var activeClient = USE_MOCK ? new MOCK.MockClient() :
  new REAL.RealClient({
    rawClient: rawClient,
    configured: rawClient.isLoggedIn()
  });
var configController = USE_MOCK ? null : CONFIG.create({
  rawClient: rawClient
});

// ------------------------------------------------------------- CMD values
// Must match the CMD enum in src/c/comm.h exactly.
var CMD_GET_STATUS = 1;
var CMD_LOCK = 2;
var CMD_UNLOCK = 3;
var CMD_HONK = 4;
var CMD_REFRESH = 5;
var CMD_REMOTE_START = 6;
var CMD_GET_POSITION = 7;
var CMD_REMOTE_STOP = 8;

// ---------------------------------------------------------- MSG_TYPE values
var MSG_STATUS_UPDATE = 1;
var MSG_CMD_RESULT = 2;
var MSG_POSITION_UPDATE = 3;
var MSG_ERROR = 4;

// ------------------------------------------------------- capability enum
// Must match the CapState enum in src/c/state.h.
var CAP_AVAILABLE = 0;
var CAP_NOT_ENABLED = 1;
var CAP_NOT_CAPABLE = 2;
var CAP_UNKNOWN = 3;

function capEnum(serviceState) {
  if (serviceState === 'available') return CAP_AVAILABLE;
  if (serviceState === 'not_enabled') return CAP_NOT_ENABLED;
  if (serviceState === 'not_capable') return CAP_NOT_CAPABLE;
  return CAP_UNKNOWN;
}

var CMD_TO_SERVICE = {};
CMD_TO_SERVICE[CMD_LOCK] = 'RDL';
CMD_TO_SERVICE[CMD_UNLOCK] = 'RDU';
CMD_TO_SERVICE[CMD_HONK] = 'HBLF';
CMD_TO_SERVICE[CMD_REFRESH] = 'VHS';
CMD_TO_SERVICE[CMD_REMOTE_START] = 'REON';
CMD_TO_SERVICE[CMD_REMOTE_STOP] = 'REOFF';

// CMD_OUTCOME int -> a stable label. Kept as an explicit map so renumbering
// the enum cannot silently change what a metric means.
var OUTCOME_NAME = {
  1: 'success', 2: 'declined', 3: 'pending', 4: 'error', 5: 'blocked_motion'
};

// CMD int -> the label the ingest service allowlists. Explicit map for the
// same reason as OUTCOME_NAME: renumbering the enum must not silently change
// what a metric counts.
var CMD_NAME = {};
CMD_NAME[CMD_LOCK] = 'lock';
CMD_NAME[CMD_UNLOCK] = 'unlock';
CMD_NAME[CMD_HONK] = 'honk';
CMD_NAME[CMD_REFRESH] = 'refresh';
CMD_NAME[CMD_REMOTE_START] = 'climate_start';
CMD_NAME[CMD_REMOTE_STOP] = 'climate_stop';

var SUCCESS_MESSAGE = {};
SUCCESS_MESSAGE[CMD_LOCK] = 'Locked.';
SUCCESS_MESSAGE[CMD_UNLOCK] = "Unlocked - driver's door only. Re-locks automatically in 45s.";
SUCCESS_MESSAGE[CMD_HONK] = 'Horn and lights activated.';
SUCCESS_MESSAGE[CMD_REFRESH] = 'Status refreshed from vehicle.';
SUCCESS_MESSAGE[CMD_REMOTE_START] = 'Climate started.';
SUCCESS_MESSAGE[CMD_REMOTE_STOP] = 'Climate stopped.';

function log(msg) {
  console.log('JLR-bridge: ' + msg);
}

function boolField(v) {
  return (v === true || v === 'TRUE' || v === '1' || v === 1) ? 1 : 0;
}

function anyOpen(status, prefix, values) {
  for (var i = 0; i < values.length; i++) {
    var v = status[prefix + values[i]];
    if (v !== undefined && v !== 'CLOSED' && v !== 'FALSE' && v !== false) {
      return true;
    }
  }
  return false;
}

function doorsOpen(status) {
  return anyOpen(status, 'DOOR_', [
    'FRONT_LEFT_POSITION', 'FRONT_RIGHT_POSITION', 'REAR_LEFT_POSITION',
    'REAR_RIGHT_POSITION', 'BOOT_POSITION', 'ENGINE_HOOD_POSITION'
  ]);
}

function windowsOpen(status) {
  var w = anyOpen(status, 'WINDOW_', [
    'FRONT_LEFT_STATUS', 'FRONT_RIGHT_STATUS', 'REAR_LEFT_STATUS', 'REAR_RIGHT_STATUS'
  ]);
  return w || status.IS_SUNROOF_OPEN === 'TRUE';
}

// ------------------------------------------------------------- distance units
//
// The JLR API mixes units in one payload and only sometimes says so in the key
// name. Verified against the owner's vehicle (2026-07-28):
//
//   DISTANCE_TO_EMPTY_FUEL                    kilometres  (no suffix!)
//   EXT_KILOMETERS_TO_SERVICE                 kilometres
//   EXT_EXHAUST_FLUID_DISTANCE_TO_SERVICE_KM  kilometres
//   ODOMETER                                  METRES      (86126000)
//   ODOMETER_MILES                            miles       (53516)
//
// 86126000 m = 86126 km = 53517 mi, which is how ODOMETER/ODOMETER_MILES were
// confirmed against each other. All conversion happens here; the watch only
// formats what it is handed, so units can never drift between the two sides.
var KM_PER_MILE = 1.609344;
var DISTANCE_UNIT_KEY = 'jlr_distance_unit';
var TEMP_UNIT_KEY = 'jlr_temp_unit';
var TYRE_UNIT_KEY = 'jlr_tyre_unit';

function distanceUnit() {
  try {
    var stored = (typeof localStorage !== 'undefined' && localStorage) ?
      localStorage.getItem(DISTANCE_UNIT_KEY) : null;
    return stored === 'km' ? 'km' : 'miles';   // miles is the default
  } catch (e) {
    return 'miles';
  }
}

// Convert a kilometres value to the display unit. -1 means "unknown" and must
// survive untouched, or unknowns become a real-looking -0.6.
// Temperature unit is a DISPLAY preference only. Everything on the wire, and
// everything sent to the car, stays Celsius -- the vehicle's RCC scale is
// defined in Celsius, so converting anywhere but at the point of display would
// mean two conversions to keep in step.
function tempUnitIsF() {
  try {
    var stored = (typeof localStorage !== 'undefined' && localStorage) ?
      localStorage.getItem(TEMP_UNIT_KEY) : null;
    return stored === 'f';
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------- tyre pressure
//
// The RAW SCALE DIFFERS BY VEHICLE GENERATION. The owner's 2018 Discovery
// reports plain kPa (223), but an L405/L663 reports kPa*10 (2470) -- confirmed
// in willbeeching/ha-jlr-incontrol's _tyre_kpa(). Real pressures sit around
// 180-350 kPa, so anything above 1000 is the *10 scale. Getting this wrong
// shows "2470 kPa" to another user, which is why it is normalised here rather
// than assumed from one car.
function tyreKpa(raw) {
  var n = parseFloat(raw);
  if (isNaN(n) || n <= 0) return -1;

  // Sentinels first, before any rescaling. The vehicle reports 32767
  // (INT16_MAX) for "no TPMS reading available" -- observed live on the
  // owner's car once the tyre sensors had not reported for a while. Rescaling
  // it produces 3276.7 kPa, which then renders as a confident "32.8 bar".
  if (n === 32767 || n === 65535 || n === 255) {
    return -1;   // no TPMS reading available; the watch shows "--"
  }

  // The raw scale differs by model generation: plain kPa on this Discovery,
  // kPa*10 on an L405/L663. Real pressures sit around 180-350 kPa, so anything
  // above 1000 must be the *10 scale.
  if (n > 1000) n = n / 10;

  // Plausibility bound. I removed this once, believing it was rejecting good
  // readings -- it was not; the car was sending 32767 and "--" was the correct
  // display. Showing a fabricated pressure is worse than showing nothing: a
  // driver may act on it.
  if (n < 50 || n > 700) {
    return -1;   // implausible for a tyre; treat as no data
  }
  return n;
}

function tyreUnit() {
  try {
    var stored = (typeof localStorage !== 'undefined' && localStorage) ?
      localStorage.getItem(TYRE_UNIT_KEY) : null;
    return (stored === 'bar' || stored === 'psi') ? stored : 'kpa';
  } catch (e) {
    return 'kpa';
  }
}

// Returns TENTHS of the display unit, so the watch can show one decimal for
// bar without needing floats. -1 stays -1.
function tyreDisplayX10(raw, unit) {
  var kpa = tyreKpa(raw);
  if (kpa < 0) return -1;
  if (unit === 'bar') return Math.round(kpa / 100 * 10);
  if (unit === 'psi') return Math.round(kpa / 6.89476 * 10);
  return Math.round(kpa * 10);
}

function convertKm(km, unit) {
  if (km === null || km === undefined || km < 0) return -1;
  return unit === 'km' ? Math.round(km) : Math.round(km / KM_PER_MILE);
}

function odometerFor(status, unit) {
  if (unit === 'miles') {
    var mi = toIntOr(status.ODOMETER_MILES, -1);
    if (mi >= 0) return mi;
    var m = toIntOr(status.ODOMETER, -1);          // metres
    return m >= 0 ? Math.round(m / 1000 / KM_PER_MILE) : -1;
  }
  var metres = toIntOr(status.ODOMETER, -1);
  if (metres >= 0) return Math.round(metres / 1000);
  var miles = toIntOr(status.ODOMETER_MILES, -1);
  return miles >= 0 ? Math.round(miles * KM_PER_MILE) : -1;
}

function toIntOr(v, fallback) {
  var n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function agoSecondsFromIso(iso) {
  if (!iso) return -1;
  var norm = String(iso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  var ms = Date.parse(norm);
  if (isNaN(ms)) return -1;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

// -------------------------------------------------------- outbound senders
// Every send goes through a tiny retry wrapper -- the outbox can reject
// while the watch app is still booting or mid-way through its own send.
// This mirrors the intent of econfeed's comm.c retry queue, just kept in JS
// since pkjs's outbox has no in-flight limit the way the watch's C outbox
// does (one queued dict here is enough -- pkjs is never sending faster than
// the watch can request).
function sendDict(dict, what, attempt) {
  attempt = attempt || 0;
  Pebble.sendAppMessage(dict, function () {
    // Deliberately silent on success -- this fires on every status refresh and
    // drowned the log. Failures below are still reported.
  }, function (e) {
    if (attempt >= 4) {
      log(what + ' failed permanently: ' + JSON.stringify(e));
      return;
    }
    setTimeout(function () { sendDict(dict, what, attempt + 1); }, 400);
  });
}

function sendError(message) {
  var dict = {};
  dict['MSG_TYPE'] = MSG_ERROR;
  dict['ERROR_MESSAGE'] = String(message).substring(0, 90);
  sendDict(dict, 'error');
}

function errorCode(err) {
  return err && err.code ? String(err.code).toLowerCase() : '';
}

function userMessageForError(err, fallback) {
  var code = errorCode(err);
  if (code === 'not_configured') {
    return 'Configure Landy Remote in phone settings.';
  }
  if (code === 'auth_expired') {
    return 'Sign in again on your phone.';
  }
  if (code === 'vehicle_selection_required') {
    return 'Select a vehicle in phone settings.';
  }
  if (code === 'no_vehicles') {
    return 'No vehicle found on this account.';
  }
  if (code === 'vehicle_not_found') {
    return 'VIN not found on this account.';
  }
  if (code === 'credentials_required' || code === 'login_failed') {
    return 'Sign-in failed. Check phone settings.';
  }
  if (code === 'invalid_pin') {
    return 'PIN must be four digits.';
  }
  if (code === 'vehicle_lookup_failed' || code === 'storage_failure' ||
      code === 'invalid_configuration') {
    return 'Could not save phone settings.';
  }
  if (code === 'pin_required') {
    return 'PIN not configured for this command.';
  }
  if (code === 'capability_unavailable' || code === 'service_not_available') {
    return 'Feature not available for this vehicle.';
  }
  if (code === 'motion_unknown' || code === 'motion_unsafe') {
    return 'Cannot confirm you are stationary.';
  }
  return fallback;
}

function resetRealClient() {
  activeClient = new REAL.RealClient({
    rawClient: rawClient,
    configured: rawClient.isLoggedIn()
  });
}

if (!USE_MOCK) {
  Pebble.addEventListener('showConfiguration', function () {
    log('opening phone configuration');
    // Pass current state so the page can prefill and skip the sign-in when
    // only preferences are being changed.
    Pebble.openURL(configController && configController.configUrl ?
      configController.configUrl() : CONFIG.CONFIG_URL);
  });

  Pebble.addEventListener('webviewclosed', function (event) {
    configController.handleResponse(event && event.response, function (err, result) {
      if (err) {
        sendError(userMessageForError(err, 'Could not save phone settings.'));
        return;
      }
      if (!result || result.action === 'cancel') return;
      resetRealClient();
      if (result.action === 'logout') {
        sendError('Signed out. Configure in phone settings.');
        return;
      }
      log('configuration saved for selected vehicle');
      handleGetStatus(activeClient);
    });
  });
}

function safetyLocked(bundle) {
  return !bundle || !bundle.motion || bundle.motion.moving ||
    bundle.motion.commandsAllowed !== true;
}

// ------------------------------------------------------------ CMD handlers

function handleGetStatus(client) {
  client.getBundle(function (err, bundle) {
    if (err) {
      sendError(userMessageForError(err, 'Could not reach vehicle.'));
      return;
    }
    var dict = {};
    var locked = safetyLocked(bundle);
    dict['MSG_TYPE'] = MSG_STATUS_UPDATE;

    // The gate now separates two things that used to be one.
    //
    //   CMDS_BLOCKED -- may we ACTUATE the vehicle? Unchanged and absolute:
    //     no command goes out unless we have positive proof the car is
    //     stationary. This is the half with physical consequences.
    //
    //   STATUS_IN_MOTION -- is the car believed to be moving? Now only a
    //     display hint, not a blackout.
    //
    // Read-only data is shown either way (owner's decision, 2026-07-28).
    // Blanking the screen bought nothing safety-wise -- glancing at a fuel
    // level is not what makes a car dangerous -- while making the app useless
    // as a passenger, and indistinguishable from broken whenever GPS was
    // merely uncertain.
    dict['CMDS_BLOCKED'] = locked ? 1 : 0;
    dict['STATUS_IN_MOTION'] = (bundle.motion && bundle.motion.moving &&
      !bundle.motion.unknown) ? 1 : 0;

    if (locked) {
      var why = (bundle && bundle.motion && bundle.motion.reasons &&
        bundle.motion.reasons.length) ? bundle.motion.reasons.join('; ') :
        (bundle ? 'no reason recorded' : 'no bundle');
      log('commands blocked (' + why + ') -- read-only data still sent');
    }

    // Distance unit is a display preference; all conversion happens here so
    // the watch only ever formats what it is given.
    var unit = distanceUnit();
    dict['STATUS_DISTANCE_UNIT'] = unit === 'km' ? 1 : 0;
    dict['STATUS_TEMP_UNIT'] = tempUnitIsF() ? 1 : 0;

    var safe = bundle.status || {};
    dict['STATUS_LOCKED'] = safe.DOOR_IS_ALL_DOORS_LOCKED === 'TRUE' ? 1 : 0;
    dict['STATUS_FUEL_PERC'] = toIntOr(safe.FUEL_LEVEL_PERC, -1);
    // DISTANCE_TO_EMPTY_FUEL is KILOMETRES. It was previously piped straight
    // into a field labelled "mi" on the watch, overstating range by ~60% (709
    // km shown as "709 mi"). Confirmed against willbeeching/ha-jlr-incontrol,
    // which declares this key's native unit as kilometres.
    dict['STATUS_RANGE_MILES'] = convertKm(toIntOr(safe.DISTANCE_TO_EMPTY_FUEL, -1), unit);
    // ODOMETER is METRES; ODOMETER_MILES is miles. Prefer whichever matches
    // the chosen unit so we never round-trip a conversion unnecessarily.
    dict['STATUS_ODOMETER'] = odometerFor(safe, unit);
    dict['STATUS_VEHICLE_NAME'] = String(bundle.modelYear || '') + ' ' + String(bundle.vehicleType || 'Vehicle');
    dict['STATUS_DOORS_OPEN'] = doorsOpen(safe) ? 1 : 0;
    dict['STATUS_WINDOWS_OPEN'] = windowsOpen(safe) ? 1 : 0;
    dict['STATUS_UPDATED_AGO_SEC'] = agoSecondsFromIso(safe.LAST_UPDATED_TIME);
    dict['CLIMATE_ON'] = climateIsOn(safe) ? 1 : 0;
    dict['CLIMATE_RUNTIME_MIN'] = climateRuntimeMin(safe);
    dict['CLIMATE_TOTAL_MIN'] = climateTotalMin(safe);

    dict['CAP_LOCK'] = capEnum(bundle.caps.RDL);
    dict['CAP_UNLOCK'] = capEnum(bundle.caps.RDU);
    dict['CAP_HONK'] = capEnum(bundle.caps.HBLF);
    dict['CAP_REFRESH'] = capEnum(bundle.caps.VHS);
    dict['CAP_REMOTE_START'] = capEnum(bundle.caps.REON);

    var tUnit = tyreUnit();
    dict['TYRE_UNIT'] = tUnit === 'bar' ? 1 : (tUnit === 'psi' ? 2 : 0);
    dict['TYRE_FL_KPA'] = tyreDisplayX10(safe.TYRE_PRESSURE_FRONT_LEFT, tUnit);
    dict['TYRE_FR_KPA'] = tyreDisplayX10(safe.TYRE_PRESSURE_FRONT_RIGHT, tUnit);
    dict['TYRE_RL_KPA'] = tyreDisplayX10(safe.TYRE_PRESSURE_REAR_LEFT, tUnit);
    dict['TYRE_RR_KPA'] = tyreDisplayX10(safe.TYRE_PRESSURE_REAR_RIGHT, tUnit);
    dict['SERVICE_KM'] = convertKm(toIntOr(safe.EXT_KILOMETERS_TO_SERVICE, -1), unit);
    dict['ADBLUE_KM'] = convertKm(toIntOr(safe.EXT_EXHAUST_FLUID_DISTANCE_TO_SERVICE_KM, -1), unit);
    dict['OIL_WARN'] = boolField(safe.EXT_OIL_LEVEL_WARN);
    dict['BRAKE_FLUID_WARN'] = boolField(safe.BRAKE_FLUID_WARN);
    dict['COOLANT_WARN'] = boolField(safe.ENG_COOLANT_LEVEL_WARN);

    sendDict(dict, locked ? 'status (commands blocked)' : 'status');

    // After the send. The distinction that matters is "genuinely moving"
    // versus "could not tell" -- if the latter dominates, the gate is mostly
    // locking out people beside a parked car, which is a fixable problem we
    // would otherwise never hear about.
    if (locked) {
      analytics.safetyGate(
        (bundle.motion && bundle.motion.moving && !bundle.motion.unknown) ?
          'moving' : 'unknown');
    }
    // Once per session is enough -- capabilities are cached for 24h and do not
    // change. Answers whether capability gating is load-bearing or theoretical.
    if (!capabilitiesReported && bundle.caps) {
      capabilitiesReported = true;
      ['RDL', 'RDU', 'HBLF', 'VHS', 'REON'].forEach(function (svc) {
        analytics.capability(svc, bundle.caps[svc] || 'unknown');
      });
    }
  });
}

function handleGetPosition(client, motionBlockedCb) {
  // Find-my-car is a READ: it reports where the car is, it does not touch the
  // car. It therefore follows the read rule, not the command rule, and is
  // served whether or not commands are currently blocked. The in-motion flag
  // still rides along so the screen can say the position is moving and
  // therefore stale.
  client.getBundle(function (err, bundle) {
    if (err) {
      sendError(userMessageForError(err, 'Could not reach vehicle.'));
      return;
    }
    client.getPosition(function (err2, pos) {
      if (err2) {
        sendError(userMessageForError(err2, 'Could not fetch position.'));
        return;
      }
      var dict = {};
      dict['MSG_TYPE'] = MSG_POSITION_UPDATE;
      dict['STATUS_IN_MOTION'] = (bundle.motion && bundle.motion.moving &&
        !bundle.motion.unknown) ? 1 : 0;
      dict['POS_HAS_FIX'] = pos.hasFix ? 1 : 0;
      dict['POS_DISTANCE_M'] = pos.distanceM;
      dict['POS_BEARING_DEG'] = pos.bearingDeg;
      // POS_QUALITY as an int: 0 = good, 1 = poor, 2 = unknown -- keeps the
      // wire format numeric/compact like everything else in this protocol.
      dict['POS_QUALITY'] = (pos.quality === 'GOOD') ? 0 : (pos.quality === 'POOR') ? 1 : 2;
      dict['POS_AGE_SEC'] = pos.ageSec;
      dict['POS_DAYS_SINCE_FIX'] = pos.daysSinceFix;
      sendDict(dict, 'position');
      // Find-my-car is the only feature that costs a location permission in an
      // app that holds car credentials. Worth knowing whether anyone uses it.
      analytics.featureUse('find_car');
    });
  });
}

function handleCommand(client, cmd, climateTempC10) {
  var serviceCode = CMD_TO_SERVICE[cmd];
  if (!serviceCode) {
    sendError('Unknown command.');
    return;
  }
  // SAFETY GATE. The display rule has a second half that is easy to forget:
  // never send a command to a vehicle that is or may be moving. Unlocking a
  // car in motion is the specific thing we must not do, and the watch UI is
  // not the right place to enforce it -- a stale screen, a queued AppMessage
  // or a future caller could all reach here with the car already rolling.
  //
  // motion.commandsAllowed is false whenever EITHER the phone or the car looks
  // like it is moving (see jlr.js::motionState) -- the car's own speed counts
  // even when the phone is still, because someone else may be driving it.
  client.getBundle(function (motionErr, bundle) {
    if (motionErr || safetyLocked(bundle)) {
      var explicitlyMoving = !motionErr && bundle && bundle.motion &&
        bundle.motion.moving;
      log('refusing ' + serviceCode + ' -- safety proof unavailable');
      var blocked = {};
      blocked['MSG_TYPE'] = MSG_CMD_RESULT;
      blocked['CMD_ECHO'] = cmd;
      blocked['CMD_OUTCOME'] = 5; // CMD_OUTCOME_BLOCKED_MOTION
      blocked['CMD_MESSAGE'] = explicitlyMoving ?
        'Not while the vehicle is moving.' :
        'Cannot confirm you are stationary. Command not sent.';
      sendDict(blocked, 'command blocked by safety gate');
      return;
    }
    prv_send_command(client, cmd, serviceCode, climateTempC10);
  });
}

function prv_send_command(client, cmd, serviceCode, climateTempC10) {
  var tempC = (typeof climateTempC10 === 'number' && climateTempC10 > 0) ?
    (climateTempC10 / 10) : null;
  client.sendCommand(serviceCode, function (err, result) {
    var dict = {};
    dict['MSG_TYPE'] = MSG_CMD_RESULT;
    dict['CMD_ECHO'] = cmd;
    if (err) {
      dict['CMD_OUTCOME'] = 4; // transport/auth error, distinct from a car refusal
      dict['CMD_MESSAGE'] = userMessageForError(err, 'Could not reach vehicle.');
    } else if (result.outcome === 'success') {
      dict['CMD_OUTCOME'] = 1;
      dict['CMD_MESSAGE'] = SUCCESS_MESSAGE[cmd] || 'Done.';
    } else if (result.outcome === 'declined') {
      dict['CMD_OUTCOME'] = 2;
      dict['CMD_MESSAGE'] = 'Car declined: ' + (result.failureDescription || result.failureReason || 'unknown reason');
    } else {
      dict['CMD_OUTCOME'] = 3;
      // Covers both "we ran out of poll budget" and "JLR reported a timeout".
      // Either way the car did not answer, and a retry is reasonable -- which
      // is the opposite of what "declined" implies.
      dict['CMD_MESSAGE'] = (result && (result.failureReason || result.failureDescription)) ?
        'Car did not respond in time. It may be asleep - try again.' :
        'No response - car may be asleep. Try again.';
    }
    log('command ' + cmd + ' outcome=' + dict['CMD_OUTCOME'] +
        ' msg="' + dict['CMD_MESSAGE'] + '"');
    sendDict(dict, 'command result');
    // After sendDict, never before: the watch gets its answer first.
    analytics.command(CMD_NAME[cmd] || 'other',
                      OUTCOME_NAME[dict['CMD_OUTCOME']] || 'other');
    if (dict['CMD_OUTCOME'] === 1) {
      if (cmd === CMD_REMOTE_START) {
        assumeUntil(CLIMATE_ON_UNTIL_KEY, CLIMATE_ASSUMED_ON_MS);
        clearAssumption(CLIMATE_OFF_UNTIL_KEY);
      } else if (cmd === CMD_REMOTE_STOP) {
        assumeUntil(CLIMATE_OFF_UNTIL_KEY, CLIMATE_ASSUMED_OFF_MS);
        clearAssumption(CLIMATE_ON_UNTIL_KEY);
      }
    }
    // A command that changed vehicle state (or a forced refresh) should be
    // followed by a fresh status push so the status card doesn't sit on
    // stale data until the user backs out and back in.
    if (cmd === CMD_LOCK || cmd === CMD_UNLOCK || cmd === CMD_REFRESH) {
      handleGetStatus(client);
    }
  }, tempC);
}

Pebble.addEventListener('ready', function () {
  log('pkjs ready, backend=' + (USE_MOCK ? 'mock' : 'real'));
  SELFTEST.runSelfTests();

  // The brick detector's baseline. Without it the dashboard cannot tell "JLR
  // broke and commands stopped" from "nobody opened the app" -- opens are the
  // denominator that gives the command count meaning.
  analytics.appOpen();

  Pebble.addEventListener('appmessage', function (e) {
    var cmd = e.payload['CMD'];
    if (cmd === undefined || cmd === null) {
      return;
    }
    log('received CMD=' + cmd);
    switch (cmd) {
      case CMD_GET_STATUS:
        handleGetStatus(activeClient);
        break;
      case CMD_LOCK:
      case CMD_UNLOCK:
      case CMD_HONK:
      case CMD_REFRESH:
      case CMD_REMOTE_STOP:
        handleCommand(activeClient, cmd);
        break;
      case CMD_REMOTE_START:
        // The watch picks the cabin target at the moment of use and sends it
        // with the command, in tenths of a degree C.
        handleCommand(activeClient, cmd, e.payload['CLIMATE_TEMP_C10']);
        break;
      case CMD_GET_POSITION:
        handleGetPosition(activeClient);
        break;
      default:
        log('unrecognised CMD ' + cmd);
    }
  });

  // Proactively push a status update once on startup too, in case the watch
  // app's window (and its own CMD_GET_STATUS request) loaded before pkjs
  // finished initialising -- belt and braces so the very first launch is
  // never left waiting on a request that raced pkjs's own startup.
  handleGetStatus(activeClient);
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    USE_MOCK: USE_MOCK,
    handleGetStatus: handleGetStatus,
    handleGetPosition: handleGetPosition,
    handleCommand: handleCommand,
    userMessageForError: userMessageForError
  };
}
