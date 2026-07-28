#!/usr/bin/env node
// Pure-logic + mocked-network unit tests for src/pkjs/jlr.js.
//
// No real network calls are made here -- every XMLHttpRequest is answered
// from an in-order canned-response queue. This is deliberately how the
// project satisfies "exercise the polling logic, mock the responses" for
// the command path (authenticate -> start service -> poll to terminal
// state) without ever touching a real vehicle.
//
// Run with: node test/unit-test.js

'use strict';

var assert = require('assert');

// ---------------------------------------------------------- localStorage
var memoryStore = {};
global.localStorage = {
  getItem: function (k) {
    return Object.prototype.hasOwnProperty.call(memoryStore, k) ? memoryStore[k] : null;
  },
  setItem: function (k, v) {
    memoryStore[k] = String(v);
  },
  removeItem: function (k) {
    delete memoryStore[k];
  }
};

// -------------------------------------------------- mocked XMLHttpRequest
// A FIFO queue of canned {status, json} responses. Each send() pops the
// next one and resolves asynchronously (process.nextTick), so ordering
// bugs in the real client (calling things out of sequence) show up as
// assertion failures against the wrong fixture rather than passing by luck.
var responseQueue = [];
var requestLog = [];

function queueResponse(status, json) {
  responseQueue.push({ status: status, json: json });
}

function MockXHR() {
  this.status = 0;
  this.responseText = '';
  this.readyState = 0;
  this.timeout = 30000;
  this.onload = null;
  this.onerror = null;
  this.ontimeout = null;
  this.onreadystatechange = null;
}
MockXHR.prototype.open = function (method, url) {
  this._method = method;
  this._url = url;
};
MockXHR.prototype.setRequestHeader = function () {};
MockXHR.prototype.send = function (body) {
  var self = this;
  requestLog.push({ method: this._method, url: this._url, body: body });
  var resp = responseQueue.shift();
  if (!resp) {
    throw new Error('MockXHR: no queued response for ' + this._method + ' ' + this._url);
  }
  process.nextTick(function () {
    self.status = resp.status;
    self.responseText = resp.json === null ? '' : JSON.stringify(resp.json);
    self.readyState = 4;
    if (self.onload) self.onload();
  });
};
global.XMLHttpRequest = MockXHR;

// Speed up the command-polling backoff (real client waits 3s between
// polls) -- this is test-harness-only, jlr.js itself is untouched.
var realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) {
  return realSetTimeout(fn, 0);
};

var JLR = require('../src/pkjs/jlr.js');

var failures = 0;
var passed = 0;

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('[PASS] ' + label);
  } catch (e) {
    failures++;
    console.log('[FAIL] ' + label + ' -- ' + e.message);
  }
}

function resetState() {
  memoryStore = {};
  global.localStorage.getItem = function (k) {
    return Object.prototype.hasOwnProperty.call(memoryStore, k) ? memoryStore[k] : null;
  };
  global.localStorage.setItem = function (k, v) { memoryStore[k] = String(v); };
  global.localStorage.removeItem = function (k) { delete memoryStore[k]; };
  responseQueue = [];
  requestLog = [];
}

// ----------------------------------------------------------- pure tests

function testFlattenStatusPure() {
  var fixture = {
    vehicleStatus: {
      coreStatus: [
        { key: 'DOOR_IS_ALL_DOORS_LOCKED', value: 'TRUE', lastUpdatedTime: '2026-07-27T08:00:00Z' },
        { key: 'FUEL_LEVEL_PERC', value: '90', lastUpdatedTime: '2026-07-27T09:15:00Z' }
      ],
      evStatus: []
    }
  };
  var flat = JLR.flattenStatus(fixture);
  check('flattenStatus synthesises LAST_UPDATED_TIME when absent', function () {
    assert.strictEqual(flat.LAST_UPDATED_TIME, '2026-07-27T09:15:00Z');
  });
  check('flattenStatus preserves ordinary keys', function () {
    assert.strictEqual(flat.DOOR_IS_ALL_DOORS_LOCKED, 'TRUE');
  });

  // --- the shape the REAL target vehicle returns (verified live 2026-07-27) ---
  // The fixture above was optimistic: it gave every item a lastUpdatedTime. The
  // actual 2018 Discovery returns items with ONLY {key, value}, and carries the
  // timestamp at the top level of the payload instead. That mismatch is why the
  // original fixture passed while the live run reported "<absent>".
  var realShape = {
    vehicleStatus: {
      coreStatus: [
        { key: 'TU_STATUS_PRIMARY_VOLT', value: '4.1000000000000005' },
        { key: 'DOOR_IS_ALL_DOORS_LOCKED', value: 'TRUE' },
        { key: 'FUEL_LEVEL_PERC', value: '90' }
      ],
      evStatus: []
    },
    vehicleAlerts: [],
    lastUpdatedTime: '2026-07-27T08:02:29+0000'
  };
  var realFlat = JLR.flattenStatus(realShape);
  check('flattenStatus falls back to the payload-level lastUpdatedTime', function () {
    assert.strictEqual(realFlat.LAST_UPDATED_TIME, '2026-07-27T08:02:29+0000');
  });
  check('flattenStatus still flattens items that carry no timestamps', function () {
    assert.strictEqual(realFlat.DOOR_IS_ALL_DOORS_LOCKED, 'TRUE');
    assert.strictEqual(realFlat.FUEL_LEVEL_PERC, '90');
  });

  // Precedence: per-item timestamps must win over the payload-level one, since
  // the payload-level value can be older than individual field updates.
  var bothShape = {
    vehicleStatus: {
      coreStatus: [{ key: 'X', value: '1', lastUpdatedTime: '2026-07-27T09:15:00Z' }],
      evStatus: []
    },
    lastUpdatedTime: '2026-07-27T08:02:29+0000'
  };
  check('per-item timestamps take precedence over the payload-level one', function () {
    assert.strictEqual(JLR.flattenStatus(bothShape).LAST_UPDATED_TIME, '2026-07-27T09:15:00Z');
  });

  check('flattenStatus leaves LAST_UPDATED_TIME absent when nothing supplies one', function () {
    var bare = { vehicleStatus: { coreStatus: [{ key: 'X', value: '1' }], evStatus: [] } };
    assert.strictEqual(JLR.flattenStatus(bare).LAST_UPDATED_TIME, undefined);
  });
}

function testServiceStatePure() {
  check('serviceState: not_capable when code absent from a real list', function () {
    assert.strictEqual(
      JLR.serviceState({ availableServices: [{ serviceType: 'VHS', vehicleCapable: true, serviceEnabled: true }] }, 'RDL'),
      'not_capable'
    );
  });
  check('serviceState: not_enabled when disabled', function () {
    assert.strictEqual(
      JLR.serviceState({ availableServices: [{ serviceType: 'RDL', vehicleCapable: true, serviceEnabled: false }] }, 'RDL'),
      'not_enabled'
    );
  });
  check('serviceState: unknown when list missing (fail open)', function () {
    assert.strictEqual(JLR.serviceState({}, 'RDL'), 'unknown');
  });
}

function testMaskVinPure() {
  check('maskVin masks a real VIN', function () {
    assert.strictEqual(JLR.maskVin('SALGA2FE8JA123456'), 'SALGA…3456');
  });
}

// -------------------------------------------------- mocked-network tests

function withLoggedInClient(cb) {
  resetState();
  queueResponse(200, { access_token: 'atok', authorization_token: 'authz', refresh_token: 'rtok', expires_in: 86400 });
  var client = new JLR.Client();
  client.login('test@example.com', 'hunter2', function (err) {
    check('login succeeds against a mocked 200', function () {
      assert.strictEqual(err, null);
      assert.strictEqual(client.isLoggedIn(), true);
    });
    // Any subsequent connect() call needs device-registration (204) + user
    // lookup (200) queued by the caller before invoking cb.
    cb(client);
  });
}

function testConnectFlow() {
  withLoggedInClient(function (client) {
    queueResponse(204, null);                 // device registration
    queueResponse(200, { userId: '123456' });  // user lookup
    client.connect(function (err) {
      check('connect resolves user id after registration', function () {
        assert.strictEqual(err, null);
        assert.strictEqual(client.getUserIdCached(), '123456');
      });
      testSendCommandSuccess();
    });
  });
}

function testSendCommandSuccess() {
  withLoggedInClient(function (client) {
    queueResponse(204, null);
    queueResponse(200, { userId: '123456' });
    queueResponse(200, { token: 'svc-token' });                                 // authenticate
    queueResponse(202, { customerServiceId: 'csid-1', status: 'Started' });      // start service
    queueResponse(200, { customerServiceId: 'csid-1', status: 'Started' });      // poll #1
    queueResponse(200, { customerServiceId: 'csid-1', status: 'Successful' });   // poll #2 -> terminal

    client.sendCommand('SALGA2FE8JA123456', 'HBLF', '1234', null, function (err, result) {
      check('sendCommand resolves success after polling past Started', function () {
        assert.strictEqual(err, null);
        assert.strictEqual(result.outcome, 'success');
      });
      testSendCommandDeclined();
    });
  });
}

function testSendCommandDeclined() {
  withLoggedInClient(function (client) {
    queueResponse(204, null);
    queueResponse(200, { userId: '123456' });
    queueResponse(200, { token: 'svc-token' });
    queueResponse(202, { customerServiceId: 'csid-2', status: 'Started' });
    queueResponse(200, {
      customerServiceId: 'csid-2',
      status: 'Failed',
      failureReason: 'NegativeAcknowledge',
      failureDescription: 'conflictWithOnboardChange'
    });

    client.sendCommand('SALGA2FE8JA123456', 'RDU', '1234', null, function (err, result) {
      check('sendCommand distinguishes a vehicle-declined outcome from success', function () {
        assert.strictEqual(err, null);
        assert.strictEqual(result.outcome, 'declined');
        assert.strictEqual(result.failureDescription, 'conflictWithOnboardChange');
      });
      testSendCommandPending();
    });
  });
}

function testSendCommandPending() {
  withLoggedInClient(function (client) {
    queueResponse(204, null);
    queueResponse(200, { userId: '123456' });
    queueResponse(200, { token: 'svc-token' });
    queueResponse(202, { customerServiceId: 'csid-3', status: 'Started' });
    // 10 more "still Started" polls -> exhausts the poll budget -> pending,
    // distinct from both success and declined.
    for (var i = 0; i < 10; i++) {
      queueResponse(200, { customerServiceId: 'csid-3', status: 'Started' });
    }

    client.sendCommand('SALGA2FE8JA123456', 'RDL', '1234', null, function (err, result) {
      check('sendCommand reports pending (not success, not declined) when the car never answers', function () {
        assert.strictEqual(err, null);
        assert.strictEqual(result.outcome, 'pending');
      });
      finish();
    });
  });
}

function finish() {
  console.log('\n' + passed + ' passed, ' + failures + ' failed');
  process.exit(failures > 0 ? 1 : 0);
}

// --------------------------------------------------------- motion gating
// Product rule: if the car is or may be moving, the watch shows "Vehicle in
// motion" and nothing else, and commands are refused. These tests pin that
// behaviour -- a regression here is a safety regression, not a cosmetic one.
function testMotionGating() {
  var parked = {
    VEHICLE_STATE_TYPE: 'KEY_ON_ENGINE_OFF',
    LAST_UPDATED_TIME: '2026-07-27T08:02:29+0000',
    FUEL_LEVEL_PERC: '90'
  };

  check('motion: parked car + stationary phone => not moving', function () {
    var m = JLR.motionState(parked, { speed: 0 }, { speed: 0, units: 'ms' });
    assert.strictEqual(m.moving, false);
    assert.strictEqual(m.commandsAllowed, true);
  });

  check('motion: moving phone => moving, commands refused', function () {
    var m = JLR.motionState(parked, { speed: 0 }, { speed: 16.7, units: 'ms' });
    assert.strictEqual(m.moving, true);
    assert.strictEqual(m.commandsAllowed, false);
  });

  check('motion: car reports speed => moving even when phone is still', function () {
    // Someone else is driving it; we must still refuse to unlock.
    var m = JLR.motionState(parked, { speed: 40 }, { speed: 0, units: 'ms' });
    assert.strictEqual(m.moving, true);
  });

  // Reversed deliberately. Marking a running engine as "moving" created a
  // trap on the real vehicle: remote climate STARTS the engine, so starting it
  // closed the gate and Stop Climate was then refused -- the app could start
  // the engine and block the only control that stops it. An idling car is not
  // a moving car; motion is measured by the two speed signals.
  check('motion: a running engine alone does NOT mark moving', function () {
    var m = JLR.motionState(
      { VEHICLE_STATE_TYPE: 'KEY_ON_ENGINE_ON' }, { speed: 0 }, { speed: 0, units: 'ms' });
    assert.strictEqual(m.moving, false);
    assert.strictEqual(m.commandsAllowed, true, 'Stop Climate must remain reachable');
  });

  check('motion: a running engine AND real speed is still blocked', function () {
    var m = JLR.motionState(
      { VEHICLE_STATE_TYPE: 'KEY_ON_ENGINE_ON' }, { speed: 40 }, { speed: 0, units: 'ms' });
    assert.strictEqual(m.moving, true);
    assert.strictEqual(m.commandsAllowed, false);
  });

  check('motion: an UNKNOWN vehicle state is not treated as moving on its own', function () {
    // The enum is undocumented; unknown values must not silently trigger the
    // in-motion screen when no speed signal supports it.
    assert.strictEqual(JLR.motionState({ VEHICLE_STATE_TYPE: 'SOMETHING_NEW' }, { speed: 0 }, null).moving, false);
  });

  check('motion: displaySafeStatus reveals nothing but IN_MOTION while moving', function () {
    var safe = JLR.displaySafeStatus(parked, { moving: true });
    assert.deepStrictEqual(Object.keys(safe), ['IN_MOTION']);
    assert.strictEqual(safe.FUEL_LEVEL_PERC, undefined);
  });

  check('motion: displaySafeStatus passes everything through when parked', function () {
    assert.strictEqual(JLR.displaySafeStatus(parked, { moving: false }).FUEL_LEVEL_PERC, '90');
  });

  check('motion: "+0000" timestamps parse into a status age', function () {
    var m = JLR.motionState(parked, {}, null);
    assert.strictEqual(typeof m.statusAgeSeconds, 'number');
    assert.ok(m.statusAgeSeconds > 0);
  });
}

// ------------------------------------------------------- logout completeness
// The config page's button says "Sign out and clear saved data". These tests
// pin that promise. The caps cache carries the VIN in its KEY NAME and the
// model/year/fuel type in its value, so leaving it behind would let the next
// person on a shared or handed-on phone identify the previous user's vehicle.
function testLogoutClearsEverything() {
  resetState();
  var VIN = 'SALGA2BJ8FA123456';

  // A signed-in install with a populated capability cache.
  memoryStore['jlr_access_token'] = 'access-abc';
  memoryStore['jlr_refresh_token'] = 'refresh-abc';
  memoryStore['jlr_authorization_token'] = 'authz-abc';
  memoryStore['jlr_expires_at'] = String(Date.now() + 3600000);
  memoryStore['jlr_user_id'] = 'user-1';
  memoryStore['jlr_email'] = 'owner@example.com';
  memoryStore['jlr_device_id'] = 'device-uuid-1';
  memoryStore['jlr_caps_' + VIN] = JSON.stringify({ RDL: 'available', modelYear: 2018 });
  memoryStore['jlr_caps_at_' + VIN] = String(Date.now());
  memoryStore['jlr_caps_index'] = JSON.stringify([VIN]);

  new JLR.Client().logout();

  check('logout clears tokens and account identifiers', function () {
    ['jlr_access_token', 'jlr_refresh_token', 'jlr_authorization_token',
     'jlr_expires_at', 'jlr_user_id', 'jlr_email'].forEach(function (k) {
      assert.strictEqual(memoryStore[k], undefined, k + ' should be gone');
    });
  });

  check('logout clears the VIN-bearing capability cache', function () {
    assert.strictEqual(memoryStore['jlr_caps_' + VIN], undefined);
    assert.strictEqual(memoryStore['jlr_caps_at_' + VIN], undefined);
    assert.strictEqual(memoryStore['jlr_caps_index'], undefined);
  });

  check('logout leaves no key or value naming the VIN', function () {
    // The strongest form: nothing anywhere may still identify the vehicle.
    Object.keys(memoryStore).forEach(function (k) {
      assert.ok(k.indexOf(VIN) === -1, 'key still names the VIN: ' + k);
      assert.ok(String(memoryStore[k]).indexOf(VIN) === -1,
        'value still contains the VIN: ' + k);
    });
  });

  check('logout keeps the anonymous device id', function () {
    // A random UUID4 identifying no person or vehicle; keeping it stable
    // avoids re-registering a new device with JLR on every sign-in.
    assert.strictEqual(memoryStore['jlr_device_id'], 'device-uuid-1');
  });

  check('logout survives a corrupt caps index', function () {
    resetState();
    memoryStore['jlr_caps_index'] = '{not valid json';
    memoryStore['jlr_access_token'] = 'access-abc';
    new JLR.Client().logout();   // must not throw
    assert.strictEqual(memoryStore['jlr_access_token'], undefined);
  });
}

testFlattenStatusPure();
testServiceStatePure();
testMaskVinPure();
testMotionGating();
testLogoutClearsEverything();
testConnectFlow();

// ---------------------------------------------------------------------------
// JLR reports a car that never answered as Failed with failureReason
// "timeout". Treating that as "declined" told the user "Retrying won't help
// right now" for a command a retry is exactly the right response to. Observed
// live on the owner's vehicle 2026-07-28.
//
// Driven through _pollService directly rather than the canned-response queue:
// the terminal branch needs no network at all, and the queue is shared with
// the async tests above, so borrowing it made all three flaky.
// ---------------------------------------------------------------------------
function testFailureClassification() {
  var client = new JLR.Client();

  function outcomeFor(lastStatus) {
    var captured = null;
    client._pollService('SALGA2FE8JA123456', 'csid-x', lastStatus, 0,
      function (err, result) { captured = result; });
    return captured;
  }

  check('a Failed/"timeout" is reported as pending, not declined', function () {
    var r = outcomeFor({ status: 'Failed', failureReason: 'timeout' });
    assert.strictEqual(r.outcome, 'pending');
  });

  check('a timeout in failureDescription is caught too', function () {
    var r = outcomeFor({ status: 'Failed', failureDescription: 'Timed out waiting for vehicle' });
    assert.strictEqual(r.outcome, 'pending');
  });

  check('an actual refusal is still reported as declined', function () {
    var r = outcomeFor({
      status: 'Failed',
      failureReason: 'NegativeAcknowledge',
      failureDescription: 'conflictWithOnboardChange'
    });
    assert.strictEqual(r.outcome, 'declined');
    assert.strictEqual(r.failureDescription, 'conflictWithOnboardChange');
  });

  check('a plain success is unaffected', function () {
    assert.strictEqual(outcomeFor({ status: 'Successful' }).outcome, 'success');
  });
}

testFailureClassification();
