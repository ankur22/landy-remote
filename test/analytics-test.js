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
  // Field name is the SERVICE's, not ours: app_version, plus schema and
  // platform. Getting these wrong is a silent 400 on every event.
  assert.strictEqual(sentBodies[0].body.app_version, '1.2.3');
  assert.strictEqual(sentBodies[0].body.schema, 1);
  assert.ok(typeof sentBodies[0].body.platform === 'string');
});

check('the payload matches the ingest schema exactly', function () {
  // The service uses DisallowUnknownFields, so any extra key is a 400 for the
  // whole event. Pin the exact set rather than trusting a comment.
  assert.deepStrictEqual(
    Object.keys(sentBodies[0].body).sort(),
    ['app', 'app_version', 'event', 'platform', 'schema', 'wid']);
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
  // An ALLOWLIST, not a blocklist of suspicious substrings. The blocklist
  // version flagged "platform" for containing "lat", and worse, would have
  // silently passed any future field whose name happened to look innocent.
  // Anything not named here is a failure by default.
  var allowed = {
    schema: 1, app: 1, event: 1, app_version: 1, platform: 1, wid: 1,
    cmd: 1, outcome: 1, kind: 1, service: 1, state: 1, feature: 1
  };
  sentBodies.forEach(function (s) {
    Object.keys(s.body).forEach(function (k) {
      assert.strictEqual(allowed[k], 1,
        'field "' + k + '" is not on the allowlist and must not be sent');
    });
    // Values too -- an allowed label could still smuggle something in.
    var blob = JSON.stringify(s.body).toLowerCase();
    assert.ok(blob.indexOf('salra') === -1, 'no VIN prefix may appear');
    assert.ok(blob.indexOf('@') === -1, 'no email may appear');
    assert.ok(!/\d{2}\.\d{4,}/.test(blob), 'nothing coordinate-shaped may appear');
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

// ---------------------------------------------------------------------------
// Send outcomes must be logged. The failure mode this exists for is silent by
// construction: the service rejects unknown fields, so a schema drift is a 400
// that produces no user-visible symptom and no log entry at all. The handlers
// log but must still never act -- no retry, no blocking, nothing surfaced.
// ---------------------------------------------------------------------------
(function () {
  function loggingClient(behaviour) {
    var logs = [];
    var a = Analytics.create({
      version: '1.2.3',
      log: function (m) { logs.push(m); },
      xhrFactory: function () {
        var xhr = {
          open: function () {}, setRequestHeader: function () {}, timeout: 0,
          send: function () { behaviour(xhr); }
        };
        return xhr;
      }
    });
    return { analytics: a, logs: logs };
  }

  function joined(logs) { return logs.join(' | '); }

  var ok = loggingClient(function (xhr) { xhr.status = 204; xhr.onload(); });
  ok.analytics.appOpen();
  check('a successful send logs the status', function () {
    assert.ok(/sending/.test(joined(ok.logs)), 'the outgoing payload is logged');
    assert.ok(/HTTP 204 ok/.test(joined(ok.logs)));
  });

  var rejected = loggingClient(function (xhr) {
    xhr.status = 400; xhr.responseText = 'invalid event'; xhr.onload();
  });
  rejected.analytics.appOpen();
  check('a rejected send is logged as REJECTED with the body', function () {
    assert.ok(/HTTP 400 REJECTED/.test(joined(rejected.logs)));
    assert.ok(/invalid event/.test(joined(rejected.logs)));
  });

  // pkjs reports connection failures as status 0 with no onerror.
  var dead = loggingClient(function (xhr) { xhr.status = 0; xhr.onload(); });
  dead.analytics.appOpen();
  check('status 0 is logged as no response, not as success', function () {
    assert.ok(/no response \(status 0\)/.test(joined(dead.logs)));
    assert.ok(!/ok/.test(joined(dead.logs).replace(/sending.*/, '')));
  });

  var timedOut = loggingClient(function (xhr) { xhr.ontimeout(); });
  timedOut.analytics.appOpen();
  check('a timeout is logged', function () {
    assert.ok(/timed out/.test(joined(timedOut.logs)));
  });

  check('logging still does not let a failure reach the caller', function () {
    var boom = loggingClient(function () { throw new Error('network down'); });
    assert.doesNotThrow(function () { boom.analytics.appOpen(); });
    assert.ok(/threw before send/.test(joined(boom.logs)));
  });
}());

console.log('analytics logging: 6 assertions passed');
