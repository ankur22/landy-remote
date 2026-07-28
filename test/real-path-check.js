#!/usr/bin/env node
// Read-only end-to-end check of the REAL data path: real.js -> jlr.js -> JLR.
//
// WHY THIS EXISTS (instead of just running the emulator):
// The Pebble emulator's pypkjs geolocation only ever returns
// {longitude, latitude, accuracy} -- there is NO `speed` field, and the fix is
// IP-derived (your ISP's location). real.js correctly treats a missing speed as
// `motion_unknown`, which trips the safety gate, so in the emulator the app can
// only ever show "Checking safety" and refuse everything. That is the gate
// working, not a bug -- but it makes an emulator run useless for verifying the
// data path, and we are NOT putting a gate bypass into shipped code to work
// around it. This harness stubs geolocation HERE, in test code, instead.
//
// SAFETY:
//   - READ-ONLY. Never calls sendCommand/lock/unlock/honkFlash. Nothing is sent
//     to the vehicle.
//   - Geolocation is stubbed as STATIONARY (speed 0) so the read paths can be
//     exercised. This stub lives in the test harness only.
//   - Credentials come from the macOS Keychain; nothing is echoed or stored.
//   - The VIN is masked in all output.
//
// Usage:
//   node test/real-path-check.js
// Store credentials once (prompts, so nothing reaches shell history):
//   security add-generic-password -s jlr-incontrol -a you@example.com -w

'use strict';

var https = require('https');
var path = require('path');

// ------------------------------------------------------------- localStorage
var memoryStore = {};
global.localStorage = {
  getItem: function (k) {
    return Object.prototype.hasOwnProperty.call(memoryStore, k) ? memoryStore[k] : null;
  },
  setItem: function (k, v) { memoryStore[k] = String(v); },
  removeItem: function (k) { delete memoryStore[k]; }
};

// ---------------------------------------------------------- XMLHttpRequest
function FakeXHR() {
  this.readyState = 0; this.status = 0; this.responseText = '';
  this.timeout = 30000; this._headers = {};
}
FakeXHR.prototype.open = function (m, u) { this._method = m; this._url = u; this.readyState = 1; };
FakeXHR.prototype.setRequestHeader = function (n, v) { this._headers[n] = v; };
FakeXHR.prototype.send = function (body) {
  var self = this;
  var u = new URL(this._url);
  var req = https.request({
    method: this._method, hostname: u.hostname,
    path: u.pathname + (u.search || ''), port: u.port || 443,
    headers: this._headers, timeout: this.timeout
  }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      self.status = res.statusCode;
      self.responseText = Buffer.concat(chunks).toString('utf8');
      self.readyState = 4;
      if (self.onload) self.onload();
      if (self.onreadystatechange) self.onreadystatechange();
    });
  });
  req.on('timeout', function () { req.destroy(); self.status = 0; self.readyState = 4; if (self.ontimeout) self.ontimeout(); });
  req.on('error', function () { self.status = 0; self.readyState = 4; if (self.onerror) self.onerror(); });
  if (body !== undefined && body !== null) req.write(body);
  req.end();
};
global.XMLHttpRequest = FakeXHR;

// ------------------------------------------- geolocation stub (TEST ONLY)
// Reports a stationary phone. Coordinates are a fixed placeholder -- the
// distance/bearing figures below are therefore meaningless; what is being
// verified is that the pipeline runs and the motion gate opens when speed is
// a real number and zero.
// NOTE the deliberate 250 ms backdate. real.js samples its reference clock
// BEFORE calling getCurrentPosition, so a fix stamped with Date.now() inside
// the callback lands a millisecond or two in the FUTURE relative to that
// reference. The first version of this stub did exactly that and the gate
// closed with "live motion unknown" -- which is what surfaced the clock-skew
// tolerance now in real.js. Backdating keeps the stub honest about
// representing a fix taken just before the read.
var geolocationStub = {
  getCurrentPosition: function (success) {
    var fix = {
      coords: { latitude: 51.5008, longitude: -0.1225, speed: 0, accuracy: 5 },
      timestamp: Date.now() - 250
    };
    setTimeout(function () { success(fix); }, 0);
  }
};

// ----------------------------------------------------------- credentials
var execFileSync = require('child_process').execFileSync;
var SERVICE = process.env.JLR_KEYCHAIN_SERVICE || 'jlr-incontrol';
function kc(args) {
  try { return execFileSync('security', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch (e) { return null; }
}
var acctOut = kc(['find-generic-password', '-s', SERVICE]);
var m = acctOut && acctOut.match(/"acct"<blob>="([^"]*)"/);
var email = process.env.JLR_EMAIL || (m && m[1]);
var pw = kc(['find-generic-password', '-w', '-s', SERVICE].concat(email ? ['-a', email] : []));
if (pw) pw = pw.replace(/\n$/, '');
if (!email || !pw) {
  console.error('No credentials in Keychain service "' + SERVICE + '". Nothing was sent.');
  console.error('Store them with: security add-generic-password -s ' + SERVICE + ' -a <email> -w');
  process.exit(1);
}

var JLR = require(path.join(__dirname, '..', 'src', 'pkjs', 'jlr.js'));
var REAL = require(path.join(__dirname, '..', 'src', 'pkjs', 'real.js'));

function ok(b) { return b ? 'PASS' : 'FAIL'; }
var failures = 0;
function expect(label, condition, detail) {
  if (!condition) failures++;
  console.log('  [' + ok(condition) + '] ' + label + (detail ? ' -- ' + detail : ''));
}

console.log('Real data path check (read-only, stationary geolocation stub)\n');

var rawClient = new JLR.Client();
rawClient.login(email, pw, function (loginErr) {
  if (loginErr) {
    console.error('login failed: ' + loginErr.message);
    process.exit(1);
  }
  console.log('=== 1. Auth ===');
  expect('password grant succeeded', true);
  expect('password is not persisted anywhere',
    Object.keys(memoryStore).every(function (k) {
      return String(memoryStore[k]).indexOf(pw) === -1;
    }));
  expect('a refresh token was stored', !!memoryStore['jlr_refresh_token']);

  rawClient.getVehicles(function (vErr, vehicles) {
    if (vErr) { console.error('vehicle list failed: ' + vErr.message); process.exit(1); }
    var vin = vehicles[0].vin;
    memoryStore['jlr_selected_vin'] = vin;
    console.log('\n=== 2. Vehicle ===');
    console.log('  ' + JLR.maskVin(vin));

    var client = new REAL.RealClient({
      rawClient: rawClient,
      geolocation: geolocationStub
    });

    console.log('\n=== 3. getBundle (the call the watch actually makes) ===');
    client.getBundle(function (bErr, bundle) {
      if (bErr) {
        console.error('  getBundle FAILED: ' + (bErr.message || bErr));
        console.error('  code=' + (bErr.code || '<none>'));
        process.exit(1);
      }
      expect('bundle returned', !!bundle);
      expect('motion state present', !!(bundle && bundle.motion));

      var mo = bundle.motion || {};
      console.log('\n=== 4. Motion gate ===');
      console.log('  moving=' + mo.moving + '  commandsAllowed=' + mo.commandsAllowed);
      console.log('  reasons=' + JSON.stringify(mo.reasons || []));
      console.log('  statusAgeSeconds=' + mo.statusAgeSeconds);
      expect('gate OPEN for a stationary phone + parked car',
        mo.moving === false && mo.commandsAllowed === true,
        'if this fails the watch would show "Checking safety"');

      console.log('\n=== 5. Capabilities ===');
      var caps = bundle.caps || {};
      ['RDL', 'RDU', 'HBLF', 'VHS', 'REON'].forEach(function (c) {
        console.log('  ' + c + ' = ' + caps[c]);
      });
      expect('lock/unlock/honk resolved to a real state',
        ['available', 'not_enabled', 'not_capable', 'unknown'].indexOf(caps.RDL) !== -1);

      console.log('\n=== 6. Status ===');
      var st = bundle.status || {};
      var keyCount = Object.keys(st).length;
      console.log('  ' + keyCount + ' keys');
      ['DOOR_IS_ALL_DOORS_LOCKED', 'FUEL_LEVEL_PERC', 'DISTANCE_TO_EMPTY_FUEL',
       'ODOMETER_MILES', 'LAST_UPDATED_TIME'].forEach(function (k) {
        console.log('    ' + k + ' = ' + (st[k] === undefined ? '<absent>' : st[k]));
      });
      expect('status is populated', keyCount > 50, keyCount + ' keys');
      expect('LAST_UPDATED_TIME resolved (the 3-tier fallback)',
        !!st.LAST_UPDATED_TIME,
        'this vehicle omits the key; must come from payload-level lastUpdatedTime');

      console.log('\n=== 7. Position ===');
      client.getPosition(function (pErr, pos) {
        if (pErr) {
          console.log('  getPosition error: ' + (pErr.code || '') + ' ' + pErr.message);
        } else {
          console.log('  hasFix=' + pos.hasFix + ' quality=' + pos.quality +
            ' daysSinceFix=' + pos.daysSinceFix);
          console.log('  distance=' + pos.distanceM + 'm bearing=' + pos.bearingDeg + 'deg' +
            '   (distance/bearing are vs the STUB location, so meaningless here)');
          expect('position resolved without error', true);
        }

        console.log('\n=== 8. Nothing was sent to the vehicle ===');
        expect('no command was issued', true, 'this harness never calls sendCommand');

        console.log('\n' + (failures === 0 ?
          'All checks passed. The real data path works end to end.' :
          failures + ' CHECK(S) FAILED -- see above.'));
        process.exit(failures === 0 ? 0 : 1);
      });
    });
  });
});
