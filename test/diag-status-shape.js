#!/usr/bin/env node
// Read-only diagnostic: what does /status actually look like on this vehicle?
//
// The LAST_UPDATED_TIME fallback did not synthesise a timestamp on the real car,
// so either (a) the items carry no per-item timestamp at all, or (b) they carry
// one under a different field name than `lastUpdatedTime`. This prints the
// STRUCTURE (field names, not a full value dump) so we can tell which.
//
// Reuses the smoke test's polyfills + credential sourcing. Sends no commands.

'use strict';

var path = require('path');
var https = require('https');

// --- minimal polyfills (same shape as live-smoke-test.js) ---
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
  var u = new URL(this._url);                      // WHATWG, not url.parse()
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

// --- credentials from Keychain (same service as the smoke test) ---
var execFileSync = require('child_process').execFileSync;
var SERVICE = process.env.JLR_KEYCHAIN_SERVICE || 'jlr-incontrol';
function kc(args) {
  try {
    return execFileSync('security', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) { return null; }
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

// --- raw fetch of /status, bypassing flattenStatus, to inspect structure ---
var client = new JLR.Client();
client.login(email, pw, function (err) {
  if (err) { console.error('login failed: ' + err.message); process.exit(1); }
  client.connect(function (err2) {
    if (err2) { console.error('connect failed: ' + err2.message); process.exit(1); }
    client.getVehicles(function (err3, vehicles) {
      if (err3) { console.error('vehicles failed: ' + err3.message); process.exit(1); }
      var vin = vehicles[0].vin;
      console.log('vehicle ' + JLR.maskVin(vin));

      // Re-issue the status request ourselves so we see the untouched payload.
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://if9.prod-row.jlrmotor.com/if9/webview/vehicles/' + vin + '/status', true);
      var h = client._webviewHeaders
        ? client._webviewHeaders('application/vnd.ngtp.org.if9.healthstatus-v3+json')
        : null;
      if (!h) { console.error('client does not expose _webviewHeaders; cannot raw-fetch'); process.exit(1); }
      Object.keys(h).forEach(function (k) { xhr.setRequestHeader(k, h[k]); });
      xhr.onload = function () {
        if (xhr.status !== 200) { console.error('status HTTP ' + xhr.status); process.exit(1); }
        var payload = JSON.parse(xhr.responseText);
        var vs = payload.vehicleStatus || {};

        console.log('\ntop-level keys of payload : ' + Object.keys(payload).join(', '));
        console.log('keys of vehicleStatus     : ' + Object.keys(vs).join(', '));

        ['coreStatus', 'evStatus'].forEach(function (grp) {
          var items = vs[grp];
          if (!Array.isArray(items) || !items.length) {
            console.log('\n' + grp + ': absent or empty');
            return;
          }
          console.log('\n' + grp + ': ' + items.length + ' items');
          console.log('  field names on item[0]: ' + Object.keys(items[0]).join(', '));
          console.log('  item[0] verbatim      : ' + JSON.stringify(items[0]));
          // Does ANY item carry something timestamp-shaped?
          var tsFields = {};
          items.forEach(function (it) {
            Object.keys(it).forEach(function (k) {
              if (/time|date|updated|ts$/i.test(k)) tsFields[k] = (tsFields[k] || 0) + 1;
            });
          });
          var found = Object.keys(tsFields);
          console.log('  timestamp-ish fields  : ' +
            (found.length ? found.map(function (k) { return k + ' (on ' + tsFields[k] + ' items)'; }).join(', ')
                          : 'NONE'));
        });

        // Any timestamp elsewhere in the payload we could use instead?
        console.log('\nother candidate freshness sources at top level:');
        Object.keys(payload).forEach(function (k) {
          if (typeof payload[k] === 'string' && /\d{4}-\d{2}-\d{2}/.test(payload[k])) {
            console.log('  payload.' + k + ' = ' + payload[k]);
          }
        });
        Object.keys(vs).forEach(function (k) {
          if (typeof vs[k] === 'string' && /\d{4}-\d{2}-\d{2}/.test(vs[k])) {
            console.log('  vehicleStatus.' + k + ' = ' + vs[k]);
          }
        });
        console.log('\nDone (read-only).');
      };
      xhr.onerror = function () { console.error('status request failed'); process.exit(1); };
      xhr.send();
    });
  });
});
