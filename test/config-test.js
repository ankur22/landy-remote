#!/usr/bin/env node
'use strict';

var assert = require('assert');
var Config = require('../src/pkjs/config');

function memoryStorage(initial) {
  var values = initial || {};
  return {
    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    setItem: function (key, value) { values[key] = String(value); },
    removeItem: function (key) { delete values[key]; },
    values: values
  };
}

function fakeRaw(vehicles) {
  return {
    loginCalls: [],
    logoutCalls: 0,
    loginError: null,
    vehicleError: null,
    login: function (email, password, callback) {
      this.loginCalls.push({ email: email, password: password });
      callback(this.loginError);
    },
    getVehicles: function (callback) {
      callback(this.vehicleError, vehicles);
    },
    logout: function () { this.logoutCalls++; }
  };
}

function encoded(payload) {
  return encodeURIComponent(JSON.stringify(payload));
}

var failures = 0;
var passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (err) {
    failures++;
    console.log('[FAIL] ' + name + ' -- ' + err.message);
  }
}

test('uses the published GitHub Pages configuration URL', function () {
  assert.strictEqual(
    Config.CONFIG_URL,
    'https://ankur22.github.io/landy-remote/config/'
  );
});

test('signs in, selects a sole vehicle, and never stores the password', function () {
  var storage = memoryStorage();
  var raw = fakeRaw([{ vin: 'VIN-ONE' }]);
  var controller = Config.create({ rawClient: raw, storage: storage });
  var outcome;
  controller.handleResponse(encoded({
    action: 'save',
    email: 'owner@example.com',
    password: 'not-for-storage',
    storePin: false
  }), function (err, result) {
    assert.ifError(err);
    outcome = result;
  });
  assert.deepStrictEqual(raw.loginCalls, [{
    email: 'owner@example.com',
    password: 'not-for-storage'
  }]);
  assert.strictEqual(storage.getItem('jlr_selected_vin'), 'VIN-ONE');
  assert.strictEqual(outcome.vin, 'VIN-ONE');
  assert.strictEqual(JSON.stringify(storage.values).indexOf('not-for-storage'), -1);
});

test('requires an explicit VIN when an account has multiple vehicles', function () {
  var storage = memoryStorage();
  var raw = fakeRaw([{ vin: 'VIN-ONE' }, { vin: 'VIN-TWO' }]);
  var controller = Config.create({ rawClient: raw, storage: storage });
  var resultError;
  controller.handleResponse(encoded({
    action: 'save',
    email: 'owner@example.com',
    password: 'secret',
    storePin: false
  }), function (err) { resultError = err; });
  assert.strictEqual(resultError.code, 'vehicle_selection_required');
  assert.strictEqual(storage.getItem('jlr_selected_vin'), null);
});

test('matches an explicitly entered VIN case-insensitively', function () {
  var storage = memoryStorage();
  var raw = fakeRaw([{ vin: 'SALGA000000000001' }, { vin: 'SALGA000000000002' }]);
  var controller = Config.create({ rawClient: raw, storage: storage });
  controller.handleResponse(encoded({
    action: 'save',
    email: 'owner@example.com',
    password: 'secret',
    vin: ' salga000000000002 ',
    storePin: false
  }), function (err) { assert.ifError(err); });
  assert.strictEqual(storage.getItem('jlr_selected_vin'), 'SALGA000000000002');
});

test('rejects a VIN that is not on the signed-in account', function () {
  var storage = memoryStorage();
  var controller = Config.create({
    rawClient: fakeRaw([{ vin: 'VIN-ONE' }]),
    storage: storage
  });
  var resultError;
  controller.handleResponse(encoded({
    action: 'save',
    email: 'owner@example.com',
    password: 'secret',
    vin: 'VIN-OTHER',
    storePin: false
  }), function (err) { resultError = err; });
  assert.strictEqual(resultError.code, 'vehicle_not_found');
  assert.strictEqual(storage.getItem('jlr_selected_vin'), null);
});

test('stores a PIN only after explicit opt-in', function () {
  var storage = memoryStorage();
  var controller = Config.create({
    rawClient: fakeRaw([{ vin: 'VIN-ONE' }]),
    storage: storage
  });
  controller.handleResponse(encoded({
    action: 'save',
    email: 'owner@example.com',
    password: 'secret',
    storePin: true,
    pin: '2468'
  }), function (err) { assert.ifError(err); });
  assert.strictEqual(storage.getItem('jlr_pin'), '2468');
});

test('opt-out removes a previously stored PIN', function () {
  var storage = memoryStorage({ jlr_pin: '2468' });
  var controller = Config.create({
    rawClient: fakeRaw([{ vin: 'VIN-ONE' }]),
    storage: storage
  });
  controller.handleResponse(encoded({
    action: 'save',
    email: 'owner@example.com',
    password: 'secret',
    storePin: false,
    pin: '9999'
  }), function (err) { assert.ifError(err); });
  assert.strictEqual(storage.getItem('jlr_pin'), null);
});

test('PIN opt-in requires a four digit PIN', function () {
  var controller = Config.create({
    rawClient: fakeRaw([{ vin: 'VIN-ONE' }]),
    storage: memoryStorage()
  });
  var resultError;
  controller.handleResponse(encoded({
    action: 'save',
    email: 'owner@example.com',
    password: 'secret',
    storePin: true,
    pin: '12ab'
  }), function (err) { resultError = err; });
  assert.strictEqual(resultError.code, 'invalid_pin');
});

test('logout clears local vehicle data and delegates token clearing', function () {
  var storage = memoryStorage({
    jlr_selected_vin: 'VIN-ONE',
    jlr_pin: '2468'
  });
  var raw = fakeRaw([]);
  var controller = Config.create({ rawClient: raw, storage: storage });
  var result;
  controller.handleResponse(encoded({ action: 'logout' }), function (err, value) {
    assert.ifError(err);
    result = value;
  });
  assert.strictEqual(raw.logoutCalls, 1);
  assert.strictEqual(storage.getItem('jlr_selected_vin'), null);
  assert.strictEqual(storage.getItem('jlr_pin'), null);
  assert.strictEqual(result.action, 'logout');
});

test('cancelled and malformed responses do not sign in', function () {
  var raw = fakeRaw([]);
  var controller = Config.create({ rawClient: raw, storage: memoryStorage() });
  controller.handleResponse('', function (err, result) {
    assert.ifError(err);
    assert.strictEqual(result.action, 'cancel');
  });
  controller.handleResponse('%not-json', function (err) {
    assert.strictEqual(err.code, 'invalid_configuration');
  });
  assert.strictEqual(raw.loginCalls.length, 0);
});

if (failures) {
  console.error('config: ' + failures + ' failed, ' + passed + ' passed');
  process.exit(1);
}
console.log('config: ' + passed + ' tests passed');

// ---------------------------------------------------------------------------
// Changing a display unit must not cost a password. Preferences say nothing to
// JLR and need no session, so a save with no new credentials while already
// signed in is a preferences-only write.
// ---------------------------------------------------------------------------
(function () {
  var store = {};
  var storage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  store['jlr_pin'] = '1234';
  var loginCalls = 0;
  var ctl = Config.create({
    rawClient: {
      isLoggedIn: function () { return true; },
      login: function () { loginCalls++; },
      getVehicles: function () { throw new Error('must not be called'); }
    },
    storage: storage
  });

  var done = false;
  ctl.handleResponse(encodeURIComponent(JSON.stringify({
    action: 'save', email: '', password: '',
    distanceUnit: 'km', tempUnit: 'f', tyreUnit: 'psi',
    storePin: true, pin: '', keepPin: true
  })), function (err, res) {
    assert.ifError(err);
    assert.strictEqual(res.action, 'save_preferences');
    done = true;
  });
  assert.ok(done, 'preferences-only save must complete synchronously');
  assert.strictEqual(loginCalls, 0, 'no sign-in may be attempted');
  assert.strictEqual(store['jlr_distance_unit'], 'km');
  assert.strictEqual(store['jlr_temp_unit'], 'f');
  assert.strictEqual(store['jlr_tyre_unit'], 'psi');
  assert.strictEqual(store['jlr_pin'], '1234', 'an existing PIN must survive a units change');

  // Unticking the box must actually forget it.
  ctl.handleResponse(encodeURIComponent(JSON.stringify({
    action: 'save', password: '', distanceUnit: 'miles',
    storePin: false, clearPin: true
  })), function (err) { assert.ifError(err); });
  assert.strictEqual(store['jlr_pin'], undefined, 'unticking must clear the PIN');

  console.log('config prefs-only: 7 assertions passed');
}());

// ---------------------------------------------------------------------------
// configUrl() must actually RUN. It shipped referencing an undefined helper and
// every test still passed, because nothing here ever called it -- the failure
// only appeared on the phone, as a ReferenceError inside the showConfiguration
// listener. Exercising it is the whole point of these assertions.
// ---------------------------------------------------------------------------
(function () {
  var store = {
    jlr_distance_unit: 'km',
    jlr_temp_unit: 'f',
    jlr_tyre_unit: 'psi',
    jlr_pin: '1234'
  };
  var storage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  var ctl = Config.create({
    rawClient: { isLoggedIn: function () { return true; } },
    storage: storage
  });

  var url = ctl.configUrl();
  assert.ok(url.indexOf('https://') === 0, 'must be an absolute URL');
  assert.ok(url.indexOf('si=1') !== -1, 'signed-in state must be carried');
  assert.ok(url.indexOf('pin=1') !== -1, 'PIN-held state must be carried');
  assert.ok(url.indexOf('d=km') !== -1, 'current distance unit must be carried');
  assert.ok(url.indexOf('t=f') !== -1, 'current temperature unit must be carried');
  assert.ok(url.indexOf('p=psi') !== -1, 'current tyre unit must be carried');

  // Nothing identifying may reach a query string -- these end up in browser
  // history and referrer headers.
  assert.strictEqual(url.indexOf('1234'), -1, 'the PIN itself must never appear');
  assert.ok(!/@/.test(url), 'no email may appear');
  assert.ok(!/vin=/i.test(url), 'no VIN may appear');

  // Signed-out and default-unit case.
  var emptyStore = {};
  var ctl2 = Config.create({
    rawClient: { isLoggedIn: function () { return false; } },
    storage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(emptyStore, k) ? emptyStore[k] : null; },
      setItem: function (k, v) { emptyStore[k] = String(v); },
      removeItem: function (k) { delete emptyStore[k]; }
    }
  });
  var url2 = ctl2.configUrl();
  assert.ok(url2.indexOf('si=0') !== -1, 'signed-out state must be carried');
  assert.ok(url2.indexOf('pin=0') !== -1);
  assert.ok(url2.indexOf('d=miles') !== -1, 'defaults must be explicit, not absent');

  console.log('config url: 12 assertions passed');
}());
