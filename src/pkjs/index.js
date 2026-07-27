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
var SELFTEST = require('./selftest');

// ------------------------------------------------------------- CMD values
// Must match the CMD enum in src/c/comm.h exactly.
var CMD_GET_STATUS = 1;
var CMD_LOCK = 2;
var CMD_UNLOCK = 3;
var CMD_HONK = 4;
var CMD_REFRESH = 5;
var CMD_REMOTE_START = 6;
var CMD_GET_POSITION = 7;

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

var SUCCESS_MESSAGE = {};
SUCCESS_MESSAGE[CMD_LOCK] = 'Locked.';
SUCCESS_MESSAGE[CMD_UNLOCK] = "Unlocked - driver's door only. Re-locks automatically in 45s.";
SUCCESS_MESSAGE[CMD_HONK] = 'Horn and lights activated.';
SUCCESS_MESSAGE[CMD_REFRESH] = 'Status refreshed from vehicle.';
SUCCESS_MESSAGE[CMD_REMOTE_START] = 'Engine started.';

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
    log(what + ' sent ok');
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
    dict['MSG_TYPE'] = MSG_STATUS_UPDATE;
    dict['STATUS_IN_MOTION'] = safetyLocked(bundle) ? 1 : 0;

    if (safetyLocked(bundle)) {
      // Per the safety rule: while moving, send NOTHING else. The watch
      // also independently blanks the screen on this flag, but not sending
      // the fields at all is defence in depth -- there is nothing sensitive
      // on the wire to leak even if something downstream misbehaves.
      log('safety lockdown -- sending status flag only');
      sendDict(dict, 'status (in-motion)');
      return;
    }

    var safe = JLR.displaySafeStatus(bundle.status, bundle.motion);
    dict['STATUS_LOCKED'] = safe.DOOR_IS_ALL_DOORS_LOCKED === 'TRUE' ? 1 : 0;
    dict['STATUS_FUEL_PERC'] = toIntOr(safe.FUEL_LEVEL_PERC, -1);
    dict['STATUS_RANGE_MILES'] = toIntOr(safe.DISTANCE_TO_EMPTY_FUEL, -1);
    dict['STATUS_VEHICLE_NAME'] = String(bundle.modelYear || '') + ' ' + String(bundle.vehicleType || 'Vehicle');
    dict['STATUS_DOORS_OPEN'] = doorsOpen(safe) ? 1 : 0;
    dict['STATUS_WINDOWS_OPEN'] = windowsOpen(safe) ? 1 : 0;
    dict['STATUS_UPDATED_AGO_SEC'] = agoSecondsFromIso(safe.LAST_UPDATED_TIME);

    dict['CAP_LOCK'] = capEnum(bundle.caps.RDL);
    dict['CAP_UNLOCK'] = capEnum(bundle.caps.RDU);
    dict['CAP_HONK'] = capEnum(bundle.caps.HBLF);
    dict['CAP_REFRESH'] = capEnum(bundle.caps.VHS);
    dict['CAP_REMOTE_START'] = capEnum(bundle.caps.REON);

    dict['TYRE_FL_KPA'] = toIntOr(safe.TYRE_PRESSURE_FRONT_LEFT, -1);
    dict['TYRE_FR_KPA'] = toIntOr(safe.TYRE_PRESSURE_FRONT_RIGHT, -1);
    dict['TYRE_RL_KPA'] = toIntOr(safe.TYRE_PRESSURE_REAR_LEFT, -1);
    dict['TYRE_RR_KPA'] = toIntOr(safe.TYRE_PRESSURE_REAR_RIGHT, -1);
    dict['SERVICE_KM'] = toIntOr(safe.EXT_KILOMETERS_TO_SERVICE, -1);
    dict['ADBLUE_KM'] = toIntOr(safe.EXT_EXHAUST_FLUID_DISTANCE_TO_SERVICE_KM, -1);
    dict['OIL_WARN'] = boolField(safe.EXT_OIL_LEVEL_WARN);
    dict['BRAKE_FLUID_WARN'] = boolField(safe.BRAKE_FLUID_WARN);
    dict['COOLANT_WARN'] = boolField(safe.ENG_COOLANT_LEVEL_WARN);

    sendDict(dict, 'status');
  });
}

function handleGetPosition(client, motionBlockedCb) {
  // Position must be treated the same as status for the motion rule --
  // find-my-car is exactly the kind of "second look" the safety rule exists
  // to prevent while the vehicle might be in motion.
  client.getBundle(function (err, bundle) {
    if (err) {
      sendError(userMessageForError(err, 'Could not reach vehicle.'));
      return;
    }
    if (safetyLocked(bundle)) {
      var lockDict = {};
      lockDict['MSG_TYPE'] = MSG_POSITION_UPDATE;
      lockDict['STATUS_IN_MOTION'] = 1;
      sendDict(lockDict, 'position (in-motion)');
      return;
    }
    client.getPosition(function (err2, pos) {
      if (err2) {
        sendError(userMessageForError(err2, 'Could not fetch position.'));
        return;
      }
      var dict = {};
      dict['MSG_TYPE'] = MSG_POSITION_UPDATE;
      dict['STATUS_IN_MOTION'] = 0;
      dict['POS_HAS_FIX'] = pos.hasFix ? 1 : 0;
      dict['POS_DISTANCE_M'] = pos.distanceM;
      dict['POS_BEARING_DEG'] = pos.bearingDeg;
      // POS_QUALITY as an int: 0 = good, 1 = poor, 2 = unknown -- keeps the
      // wire format numeric/compact like everything else in this protocol.
      dict['POS_QUALITY'] = (pos.quality === 'GOOD') ? 0 : (pos.quality === 'POOR') ? 1 : 2;
      dict['POS_AGE_SEC'] = pos.ageSec;
      dict['POS_DAYS_SINCE_FIX'] = pos.daysSinceFix;
      sendDict(dict, 'position');
    });
  });
}

function handleCommand(client, cmd) {
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
    prv_send_command(client, cmd, serviceCode);
  });
}

function prv_send_command(client, cmd, serviceCode) {
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
      dict['CMD_MESSAGE'] = 'No response - car may be asleep. Try again.';
    }
    sendDict(dict, 'command result');
    // A command that changed vehicle state (or a forced refresh) should be
    // followed by a fresh status push so the status card doesn't sit on
    // stale data until the user backs out and back in.
    if (cmd === CMD_LOCK || cmd === CMD_UNLOCK || cmd === CMD_REFRESH) {
      handleGetStatus(client);
    }
  });
}

Pebble.addEventListener('ready', function () {
  log('pkjs ready, backend=' + (USE_MOCK ? 'mock' : 'real'));
  SELFTEST.runSelfTests();

  var client = USE_MOCK ? new MOCK.MockClient() : new REAL.RealClient();

  Pebble.addEventListener('appmessage', function (e) {
    var cmd = e.payload['CMD'];
    if (cmd === undefined || cmd === null) {
      return;
    }
    log('received CMD=' + cmd);
    switch (cmd) {
      case CMD_GET_STATUS:
        handleGetStatus(client);
        break;
      case CMD_LOCK:
      case CMD_UNLOCK:
      case CMD_HONK:
      case CMD_REFRESH:
      case CMD_REMOTE_START:
        handleCommand(client, cmd);
        break;
      case CMD_GET_POSITION:
        handleGetPosition(client);
        break;
      default:
        log('unrecognised CMD ' + cmd);
    }
  });

  // Proactively push a status update once on startup too, in case the watch
  // app's window (and its own CMD_GET_STATUS request) loaded before pkjs
  // finished initialising -- belt and braces so the very first launch is
  // never left waiting on a request that raced pkjs's own startup.
  handleGetStatus(client);
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
