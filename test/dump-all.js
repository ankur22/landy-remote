#!/usr/bin/env node
// Read-only full dump of everything the JLR backend will tell us about the
// vehicle. Prints complete, unabridged responses for inspection.
//
// READ-ONLY: sends no commands. Nothing is locked, unlocked, honked or started.
//
//   node test/dump-all.js              # print to stdout
//   node test/dump-all.js -o dump.json # also write raw JSON to a file
//
// PRIVACY: the output contains your VIN, exact GPS coordinates, odometer and
// registration. It is fine on your own machine; do not paste it publicly
// unredacted. Files written with -o land in .gitignore'd dump-*.json.

'use strict';

var https = require('https');
var path = require('path');
var fs = require('fs');

// ------------------------------------------------------------- polyfills
var memoryStore = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(memoryStore, k) ? memoryStore[k] : null; },
  setItem: function (k, v) { memoryStore[k] = String(v); },
  removeItem: function (k) { delete memoryStore[k]; }
};

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

var JLR = require(path.join(__dirname, '..', 'src', 'pkjs', 'jlr.js'));

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
  process.exit(1);
}

var outFile = null;
var oi = process.argv.indexOf('-o');
if (oi !== -1 && process.argv[oi + 1]) outFile = process.argv[oi + 1];

var IF9 = 'https://if9.prod-row.jlrmotor.com/if9/webview';
var MEDIA = {
  json: 'application/json',
  health: 'application/vnd.ngtp.org.if9.healthstatus-v3+json'
};

var collected = {};
var client = new JLR.Client();

function rawGet(url, accept, label, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  var h = client._webviewHeaders(accept);
  Object.keys(h).forEach(function (k) { xhr.setRequestHeader(k, h[k]); });
  xhr.onload = function () {
    var parsed = null;
    try { parsed = JSON.parse(xhr.responseText); } catch (e) { parsed = xhr.responseText; }
    cb(xhr.status, parsed);
  };
  xhr.onerror = function () { cb(0, '<transport error>'); };
  xhr.send();
}

function banner(t) {
  console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72));
}

client.login(email, pw, function (err) {
  if (err) { console.error('login failed: ' + err.message); process.exit(1); }
  client.connect(function (err2) {
    if (err2) { console.error('connect failed: ' + err2.message); process.exit(1); }
    client.getVehicles(function (err3, vehicles) {
      if (err3) { console.error('vehicles failed: ' + err3.message); process.exit(1); }

      banner('VEHICLE LIST  (GET /users/<userId>/vehicles)');
      console.log(JSON.stringify(vehicles, null, 2));
      collected.vehicles = vehicles;

      var vin = vehicles[0].vin;
      collected.perVehicle = {};

      rawGet(IF9 + '/vehicles/' + vin + '/attributes', MEDIA.json, 'attributes', function (s1, attrs) {
        banner('ATTRIBUTES  (GET /vehicles/<vin>/attributes)  HTTP ' + s1);
        console.log(JSON.stringify(attrs, null, 2));

        rawGet(IF9 + '/vehicles/' + vin + '/status', MEDIA.health, 'status', function (s2, status) {
          banner('STATUS -- RAW  (GET /vehicles/<vin>/status)  HTTP ' + s2);
          console.log(JSON.stringify(status, null, 2));

          banner('STATUS -- FLATTENED (what the watch actually consumes)');
          var flat = JLR.flattenStatus(status);
          var keys = Object.keys(flat).sort();
          console.log(keys.length + ' keys\n');
          keys.forEach(function (k) {
            console.log('  ' + k + ' = ' + flat[k]);
          });

          rawGet(IF9 + '/vehicles/' + vin + '/position', MEDIA.json, 'position', function (s3, pos) {
            banner('POSITION  (GET /vehicles/<vin>/position)  HTTP ' + s3);
            console.log(JSON.stringify(pos, null, 2));

            collected.perVehicle[vin] = {
              attributes: attrs, statusRaw: status, statusFlattened: flat, position: pos
            };

            banner('SUMMARY');
            console.log('  flattened status keys : ' + keys.length);
            console.log('  LAST_UPDATED_TIME     : ' +
              (flat.LAST_UPDATED_TIME || '<still absent>'));
            console.log('  availableServices     : ' +
              ((attrs && attrs.availableServices) || []).map(function (x) {
                return x.serviceType;
              }).join(' '));

            if (outFile) {
              fs.writeFileSync(outFile, JSON.stringify(collected, null, 2));
              console.log('\n  raw JSON written to ' + outFile);
            }
            console.log('\nDone -- read-only, nothing was sent to the vehicle.');
          });
        });
      });
    });
  });
});
