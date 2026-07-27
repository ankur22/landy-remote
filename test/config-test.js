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
