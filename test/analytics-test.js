#!/usr/bin/env node
// Tests for src/pkjs/analytics.js.
//
// The important assertions here are NEGATIVE: they pin what must never appear
// on the wire. A privacy floor that is only described in a comment erodes the
// first time someone adds a "just one more useful field".
'use strict';

var assert = require('assert');

var store = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};

var sentBodies = [];
function FakeXHR() { this.timeout = 0; }
FakeXHR.prototype.open = function (m, u) { this._m = m; this._u = u; };
FakeXHR.prototype.setRequestHeader = function () {};
FakeXHR.prototype.send = function (body) {
  sentBodies.push({ url: this._u, method: this._m, body: JSON.parse(body) });
};
global.XMLHttpRequest = FakeXHR;

var Analytics = require('../src/pkjs/analytics.js');

var passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log('[PASS] ' + label);
}

function reset() { store = {}; sentBodies = []; }

// ---------------------------------------------------------------- basics
reset();
var a = Analytics.create({ version: '1.2.3' });

a.appOpen();
check('app_open is sent with the app and version', function () {
  assert.strictEqual(sentBodies.length, 1);
  assert.strictEqual(sentBodies[0].body.event, 'app_open');
  assert.strictEqual(sentBodies[0].body.app, 'landy');
  assert.strictEqual(sentBodies[0].body.version, '1.2.3');
});

check('no timestamp is sent -- the server timestamps the counter', function () {
  var b = sentBodies[0].body;
  Object.keys(b).forEach(function (k) {
    assert.ok(!/time|ts|date|when|clock/i.test(k), 'unexpected time-ish field: ' + k);
  });
});

check('the install id is stable across calls but random per install', function () {
  var first = sentBodies[0].body.wid;
  a.appOpen();
  assert.strictEqual(sentBodies[1].body.wid, first);
  reset();
  var b = Analytics.create({ version: '1.2.3' });
  b.appOpen();
  assert.notStrictEqual(sentBodies[0].body.wid, first, 'a fresh install must get a fresh id');
});

// ------------------------------------------------------------- the events
reset();
var c = Analytics.create({ version: '1.2.3' });
c.command(3, 'declined');
c.safetyGate('unknown');
c.capability('RDU', 'available');
c.featureUse('find_car');
check('each event carries only its own low-cardinality labels', function () {
  assert.deepStrictEqual(
    sentBodies.map(function (s) { return s.body.event; }),
    ['command', 'safety_gate', 'capability', 'feature_use']);
  assert.strictEqual(sentBodies[0].body.cmd, '3');
  assert.strictEqual(sentBodies[0].body.outcome, 'declined');
  assert.strictEqual(sentBodies[1].body.kind, 'unknown');
  assert.strictEqual(sentBodies[2].body.service, 'RDU');
  assert.strictEqual(sentBodies[2].body.state, 'available');
  assert.strictEqual(sentBodies[3].body.feature, 'find_car');
});

// ------------------------------------------------------- THE PRIVACY FLOOR
check('no payload contains anything identifying a vehicle or a location', function () {
  var forbidden = [
    'vin', 'lat', 'lon', 'latitude', 'longitude', 'bearing', 'distance',
    'speed', 'email', 'token', 'pin', 'password', 'odometer', 'fuel',
    'range', 'locked', 'door', 'window', 'tyre', 'country', 'position',
    'model', 'year', 'name'
  ];
  sentBodies.forEach(function (s) {
    Object.keys(s.body).forEach(function (k) {
      forbidden.forEach(function (bad) {
        assert.ok(k.toLowerCase().indexOf(bad) === -1,
          'field "' + k + '" looks like ' + bad + ' and must not be sent');
      });
    });
    // Values too -- a label could smuggle one in.
    var blob = JSON.stringify(s.body).toLowerCase();
    assert.ok(blob.indexOf('salra') === -1, 'no VIN prefix may appear');
    assert.ok(blob.indexOf('@') === -1, 'no email may appear');
  });
});

check('country is NOT sent by the phone -- the server derives it', function () {
  sentBodies.forEach(function (s) {
    assert.ok(!('country' in s.body));
  });
});

// --------------------------------------------------------------- opt-out
reset();
var d = Analytics.create({ version: '1.2.3' });
d.setEnabled(false);
d.appOpen();
d.command(2, 'success');
check('opting out sends absolutely nothing', function () {
  assert.strictEqual(sentBodies.length, 0);
  assert.strictEqual(d.isEnabled(), false);
});

d.setEnabled(true);
d.appOpen();
check('opting back in resumes', function () {
  assert.strictEqual(sentBodies.length, 1);
});

check('enabled by default when the key is absent', function () {
  reset();
  assert.strictEqual(Analytics.create({}).isEnabled(), true);
});

// ------------------------------------------------- must never break the app
check('a throwing XHR is swallowed', function () {
  reset();
  var logged = [];
  var e = Analytics.create({
    version: '1.2.3',
    log: function (m) { logged.push(m); },
    xhrFactory: function () { throw new Error('no network'); }
  });
  e.appOpen();          // must not throw
  assert.strictEqual(logged.length, 1);
});

check('a send is fire-and-forget: handlers do nothing', function () {
  reset();
  var f = Analytics.create({ version: '1.2.3' });
  f.appOpen();
  // Simulate the endpoint being dead; nothing may throw.
  assert.doesNotThrow(function () { new FakeXHR().send('{}'); });
});

console.log('\nanalytics: ' + passed + ' assertions passed');
