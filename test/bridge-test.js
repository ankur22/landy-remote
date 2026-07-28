#!/usr/bin/env node
'use strict';

var assert = require('assert');
var sent = [];
var listeners = {};

global.Pebble = {
  addEventListener: function (name, callback) {
    listeners[name] = callback;
  },
  sendAppMessage: function (dict, success) {
    sent.push(dict);
    if (success) success();
  },
  openURL: function () {}
};

var bridge = require('../src/pkjs/index');

function reset() {
  sent.length = 0;
}

function last() {
  assert(sent.length, 'expected an AppMessage dictionary');
  return sent[sent.length - 1];
}

function safeBundle() {
  return {
    status: {
      DOOR_IS_ALL_DOORS_LOCKED: 'TRUE',
      FUEL_LEVEL_PERC: '80',
      DISTANCE_TO_EMPTY_FUEL: '400'
    },
    caps: {
      RDL: 'available',
      RDU: 'available',
      HBLF: 'available',
      VHS: 'available',
      REON: 'available'
    },
    motion: {
      moving: false,
      commandsAllowed: true,
      reasons: []
    },
    vehicleType: 'Defender',
    modelYear: 2024
  };
}

function bundleClient(bundle, error) {
  return {
    getBundle: function (callback) {
      callback(error || null, bundle || null);
    },
    getPosition: function (callback) {
      callback(null, {
        hasFix: true,
        distanceM: 123,
        bearingDeg: 45,
        quality: 'GOOD',
        ageSec: 30,
        daysSinceFix: 0
      });
    },
    sendCommand: function (service, callback) {
      callback(null, { outcome: 'success' });
    }
  };
}

assert.strictEqual(
  bridge.USE_MOCK,
  false,
  'production bridge must select the real adapter'
);
assert.strictEqual(typeof listeners.showConfiguration, 'function',
  'production bridge must register the phone configuration page');
assert.strictEqual(typeof listeners.webviewclosed, 'function',
  'production bridge must handle configuration responses');

// Read-only data is now sent even while commands are blocked (owner's
// decision 2026-07-28). What must remain true is that CMDS_BLOCKED is set, so
// the watch draws no action bar and every handler refuses.
reset();
bridge.handleGetStatus(bundleClient({
  status: { DOOR_IS_ALL_DOORS_LOCKED: 'TRUE', FUEL_LEVEL_PERC: '80' },
  caps: {},
  motion: { moving: true, commandsAllowed: false, reasons: ['moving'] }
}));
assert.strictEqual(last().MSG_TYPE, 1);
assert.strictEqual(last().CMDS_BLOCKED, 1, 'commands must be blocked while moving');
assert.strictEqual(last().STATUS_IN_MOTION, 1);
assert.strictEqual(last().STATUS_LOCKED, 1, 'read-only data must still be sent');
assert.strictEqual(last().STATUS_FUEL_PERC, 80);

// "unknown" motion is NOT the same as "moving": commands are still blocked,
// but the watch must not claim the vehicle is in motion when we simply could
// not tell -- that was indistinguishable from a broken app on real hardware.
reset();
bridge.handleGetStatus(bundleClient({
  status: { DOOR_IS_ALL_DOORS_LOCKED: 'TRUE' },
  caps: {},
  motion: { moving: true, unknown: true, commandsAllowed: false, reasons: ['no gps'] }
}));
assert.strictEqual(last().CMDS_BLOCKED, 1);
assert.strictEqual(last().STATUS_IN_MOTION, 0,
  'an unknown motion state must not be reported as in-motion');

// Position is a read and is served regardless of the command gate.
reset();
bridge.handleGetPosition(bundleClient({
  status: {},
  caps: {},
  motion: { moving: true, commandsAllowed: false, reasons: ['moving'] }
}));
assert.strictEqual(last().MSG_TYPE, 3);
assert.strictEqual(last().STATUS_IN_MOTION, 1);

var commandIds = [2, 3, 4, 5, 6];
commandIds.forEach(function (commandId) {
  reset();
  var rawCalls = 0;
  var failing = bundleClient(null, { code: 'motion_unknown' });
  failing.sendCommand = function () { rawCalls++; };
  bridge.handleCommand(failing, commandId);
  assert.strictEqual(rawCalls, 0, 'motion lookup failure must block command ' + commandId);
  assert.strictEqual(last().CMD_OUTCOME, 5);
});

var errorCases = [
  ['not_configured', 'Configure'],
  ['auth_expired', 'Sign in again'],
  ['vehicle_selection_required', 'Select a vehicle'],
  ['no_vehicles', 'No vehicle'],
  ['pin_required', 'PIN'],
  ['capability_unavailable', 'not available'],
  ['transport_failure', 'reach vehicle']
];
errorCases.forEach(function (entry) {
  reset();
  bridge.handleGetStatus(bundleClient(null, { code: entry[0] }));
  assert(
    last().ERROR_MESSAGE.indexOf(entry[1]) !== -1,
    entry[0] + ' must produce an actionable message'
  );
});

var outcomes = [
  [{ outcome: 'success' }, 1],
  [{ outcome: 'declined', failureDescription: 'vehicle busy' }, 2],
  [{ outcome: 'pending' }, 3]
];
outcomes.forEach(function (entry) {
  reset();
  var client = bundleClient(safeBundle());
  client.sendCommand = function (service, callback) {
    callback(null, entry[0]);
  };
  bridge.handleCommand(client, 4);
  assert.strictEqual(last().CMD_OUTCOME, entry[1]);
});

reset();
bridge.handleGetStatus(bundleClient(safeBundle()));
assert.strictEqual(last().STATUS_IN_MOTION, 0);
assert.strictEqual(last().STATUS_LOCKED, 1);
assert.strictEqual(last().STATUS_VEHICLE_NAME, '2024 Defender');

console.log('bridge: 23 assertions passed');

// ---------------------------------------------------------------------------
// Distance units. DISTANCE_TO_EMPTY_FUEL is KILOMETRES but was previously fed
// straight into a field the watch labelled "mi", overstating range by ~60%
// (709 km shown as "709 mi"). All conversion happens in pkjs so the two sides
// can never disagree about units.
// ---------------------------------------------------------------------------
// pkjs localStorage is absent under plain node; distanceUnit() falls back to
// miles. Provide a minimal one so both branches can be exercised.
var unitStore = {};
global.localStorage = {
  getItem: function (k) {
    return Object.prototype.hasOwnProperty.call(unitStore, k) ? unitStore[k] : null;
  },
  setItem: function (k, v) { unitStore[k] = String(v); },
  removeItem: function (k) { delete unitStore[k]; }
};

var unitStatus = {
  DOOR_IS_ALL_DOORS_LOCKED: 'TRUE',
  DISTANCE_TO_EMPTY_FUEL: '709',
  ODOMETER: '86126000',
  ODOMETER_MILES: '53516',
  EXT_KILOMETERS_TO_SERVICE: '22084'
};

reset();
global.localStorage.setItem('jlr_distance_unit', 'miles');
bridge.handleGetStatus(bundleClient({
  status: unitStatus, caps: {},
  motion: { moving: false, commandsAllowed: true, reasons: [] }
}));
assert.strictEqual(last().STATUS_DISTANCE_UNIT, 0, 'miles selected');
assert.strictEqual(last().STATUS_RANGE_MILES, 441, '709 km is 441 mi, not 709');
assert.strictEqual(last().STATUS_ODOMETER, 53516, 'uses ODOMETER_MILES directly');

reset();
global.localStorage.setItem('jlr_distance_unit', 'km');
bridge.handleGetStatus(bundleClient({
  status: unitStatus, caps: {},
  motion: { moving: false, commandsAllowed: true, reasons: [] }
}));
assert.strictEqual(last().STATUS_DISTANCE_UNIT, 1, 'km selected');
assert.strictEqual(last().STATUS_RANGE_MILES, 709, 'km passes through unconverted');
assert.strictEqual(last().STATUS_ODOMETER, 86126, 'ODOMETER metres -> km');
assert.strictEqual(last().SERVICE_KM, 22084);

// Unknown (-1) must survive conversion, or it becomes a real-looking -0.6.
reset();
bridge.handleGetStatus(bundleClient({
  status: { DOOR_IS_ALL_DOORS_LOCKED: 'TRUE' }, caps: {},
  motion: { moving: false, commandsAllowed: true, reasons: [] }
}));
assert.strictEqual(last().STATUS_RANGE_MILES, -1, 'unknown range stays -1');
assert.strictEqual(last().STATUS_ODOMETER, -1, 'unknown odometer stays -1');

console.log('bridge units: 9 further assertions passed');
