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

reset();
bridge.handleGetStatus(bundleClient({
  status: { SECRET: 'must not cross bridge' },
  caps: {},
  motion: { moving: true, commandsAllowed: false, reasons: ['moving'] }
}));
assert.deepStrictEqual(last(), {
  MSG_TYPE: 1,
  STATUS_IN_MOTION: 1
});

reset();
bridge.handleGetPosition(bundleClient({
  status: { SECRET: 'must not cross bridge' },
  caps: {},
  motion: { moving: true, commandsAllowed: false, reasons: ['unknown'] }
}));
assert.deepStrictEqual(last(), {
  MSG_TYPE: 3,
  STATUS_IN_MOTION: 1
});

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
