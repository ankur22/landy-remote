#!/usr/bin/env node
// Read-only live smoke test for src/pkjs/jlr.js, run under plain Node.
//
// This exists so the exact client code that ships in the watchapp (not a
// reimplementation of it) can be exercised against the real JLR backend
// before/without going through the emulator or a phone. It is the Node
// equivalent of jlr-probe.py, but calling the actual jlr.js module directly.
//
// Safety, same as jlr-probe.py:
//   - READ-ONLY. Never calls sendCommand()/lock()/unlock()/honkFlash().
//     Nothing is locked, unlocked, honked, or started on the real vehicle.
//   - Credentials come from the Keychain or a hidden prompt (see below), never
//     hardcoded, never committed, never logged (the client itself already
//     enforces "never log a token/credential/PIN"; this harness must not
//     undermine that by printing raw responses that might embed one).
//   - The VIN is masked via JLR.maskVin() in every log line.
//
// Usage:
//   node test/live-smoke-test.js
//
// Credentials come from the macOS Keychain if present, else a hidden prompt.
// Store them once (the -w with no value prompts, so nothing hits your history):
//   security add-generic-password -s jlr-incontrol -a you@example.com -w
//
// Node has no XMLHttpRequest or localStorage; this file polyfills the small
// subset jlr.js actually uses (open/setRequestHeader/send, onload/onerror/
// ontimeout/onreadystatechange, status/responseText/readyState) on top of
// Node's https module, and an in-memory localStorage. Nothing here changes
// jlr.js -- if this harness needs a bigger polyfill surface, that's a signal
// jlr.js drifted from being pkjs-safe, not a reason to patch around it.

'use strict';

var https = require('https');
var urlMod = require('url');

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

// -------------------------------------------------------- XMLHttpRequest
function FakeXHR() {
  this.readyState = 0;
  this.status = 0;
  this.responseText = '';
  this.timeout = 30000;
  this.onload = null;
  this.onerror = null;
  this.ontimeout = null;
  this.onreadystatechange = null;
  this._method = null;
  this._url = null;
  this._headers = {};
}

FakeXHR.prototype.open = function (method, url) {
  this._method = method;
  this._url = url;
  this.readyState = 1;
};

FakeXHR.prototype.setRequestHeader = function (name, value) {
  this._headers[name] = value;
};

FakeXHR.prototype.send = function (body) {
  var self = this;
  var parsed = urlMod.parse(this._url);
  var options = {
    method: this._method,
    hostname: parsed.hostname,
    path: parsed.path,
    port: parsed.port || 443,
    headers: this._headers,
    timeout: this.timeout
  };

  var req = https.request(options, function (res) {
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

  req.on('timeout', function () {
    req.destroy();
    self.status = 0;
    self.readyState = 4;
    if (self.ontimeout) self.ontimeout();
  });

  req.on('error', function () {
    self.status = 0;
    self.readyState = 4;
    if (self.onerror) self.onerror();
    if (self.onreadystatechange) self.onreadystatechange();
  });

  if (body !== undefined && body !== null) {
    req.write(body);
  }
  req.end();
};

global.XMLHttpRequest = FakeXHR;

// ---------------------------------------------------------------- run it
var JLR = require('../src/pkjs/jlr.js');

// ------------------------------------------------------- credential sourcing
//
// Deliberately NOT plain env vars by default: `JLR_PASSWORD=... node ...` writes
// the password into shell history and exposes it in `ps` output for the lifetime
// of the run. Preference order:
//
//   1. macOS Keychain  (nothing sensitive typed, stored or echoed -- preferred)
//   2. hidden terminal prompt (nothing persisted anywhere)
//   3. env vars (last resort, e.g. CI; warns loudly)
//
// Store the password in the Keychain once, interactively, with:
//   security add-generic-password -s jlr-incontrol -a you@example.com -w
// (-w with no value prompts, so it never reaches your shell history either.)

var KEYCHAIN_SERVICE = process.env.JLR_KEYCHAIN_SERVICE || 'jlr-incontrol';

function fromKeychain(account) {
  var execFileSync = require('child_process').execFileSync;
  var args = ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE];
  if (account) { args.push('-a', account); }
  try {
    // stdio pipe so a miss doesn't spew to our stderr.
    return execFileSync('security', args, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().replace(/\n$/, '');
  } catch (e) {
    return null;                       // not on macOS, or no such item
  }
}

function keychainAccount() {
  // Recover the stored account (email) so the user need not retype it.
  var execFileSync = require('child_process').execFileSync;
  try {
    var out = execFileSync('security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    var m = out.match(/"acct"<blob>="([^"]*)"/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function promptHidden(question, callback) {
  // Read a line with echo suppressed. No readline-question echo, no history.
  process.stdout.write(question);
  var stdin = process.stdin;
  var wasRaw = stdin.isRaw;
  if (!stdin.isTTY) {
    process.stdout.write('\n');
    return callback(new Error('stdin is not a TTY; cannot prompt securely'));
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  var buf = '';
  function onData(ch) {
    if (ch === '\r' || ch === '\n' || ch === '\u0004') {   // Enter / Ctrl-D
      stdin.setRawMode(!!wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      return callback(null, buf);
    }
    if (ch === '\u0003') {                                  // Ctrl-C
      stdin.setRawMode(!!wasRaw);
      process.stdout.write('\n');
      process.exit(130);
    }
    if (ch === '\u007f' || ch === '\b') {                   // Backspace
      buf = buf.slice(0, -1);
      return;
    }
    buf += ch;
  }
  stdin.on('data', onData);
}

function resolveCredentials(callback) {
  var email = process.env.JLR_EMAIL || keychainAccount();
  var password = fromKeychain(email);

  if (email && password) {
    console.log('Credentials: macOS Keychain (service "' + KEYCHAIN_SERVICE + '")');
    return callback(email, password);
  }

  if (process.env.JLR_PASSWORD) {
    console.warn('WARNING: using JLR_PASSWORD from the environment. This is visible in\n' +
                 '         `ps` output and likely in your shell history. Prefer the Keychain:\n' +
                 '           security add-generic-password -s ' + KEYCHAIN_SERVICE +
                 ' -a <email> -w\n');
    if (!email) {
      console.error('JLR_EMAIL not set. Nothing was sent.');
      process.exit(1);
    }
    return callback(email, process.env.JLR_PASSWORD);
  }

  // Fall back to prompting. Nothing is stored or echoed.
  var readline = require('readline');
  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  function havePassword(addr) {
    promptHidden('InControl password (not echoed, not stored): ', function (err, pw) {
      if (err || !pw) {
        console.error('\nNo password supplied. Nothing was sent.');
        process.exit(1);
      }
      callback(addr, pw);
    });
  }
  if (email) {
    rl.close();
    havePassword(email);
  } else {
    rl.question('InControl email: ', function (answer) {
      rl.close();
      havePassword(answer.trim());
    });
  }
}

var client = new JLR.Client();

function step(label, fn) {
  console.log('\n=== ' + label + ' ===');
  fn();
}

// Credentials are resolved asynchronously (Keychain / hidden prompt), so the
// whole run hangs off that callback rather than module-level env reads.
resolveCredentials(function (email, password) {
step('1/6 Login (password grant)', function () {
  client.login(email, password, function (err) {
    if (err) {
      console.error('  FAILED: ' + err.message);
      process.exit(1);
    }
    console.log('  OK -- token acquired');

    step('2/6 Connect (device registration + user id)', function () {
      client.connect(function (err2) {
        if (err2) {
          console.error('  FAILED: ' + err2.message);
          process.exit(1);
        }
        console.log('  OK -- user id resolved');

        step('3/6 List vehicles', function () {
          client.getVehicles(function (err3, vehicles) {
            if (err3) {
              console.error('  FAILED: ' + err3.message);
              process.exit(1);
            }
            console.log('  OK -- ' + vehicles.length + ' vehicle(s)');
            var vins = [];
            for (var i = 0; i < vehicles.length; i++) {
              if (vehicles[i] && vehicles[i].vin) vins.push(vehicles[i].vin);
            }
            runPerVehicle(vins, 0);
          });
        });
      });
    });
  });
});
});   // end resolveCredentials

function runPerVehicle(vins, idx) {
  if (idx >= vins.length) {
    console.log('\nDone. This was read-only -- nothing was sent to any vehicle.');
    return;
  }
  var vin = vins[idx];
  console.log('\n--- vehicle ' + JLR.maskVin(vin) + ' ---');

  step('4/6 Capabilities (availableServices)', function () {
    client.getCapabilities(vin, function (err, caps) {
      if (err) {
        console.error('  FAILED: ' + err.message);
      } else {
        console.log('  ' + JSON.stringify(caps));
      }

      step('5/6 Status (flattened, LAST_UPDATED_TIME check)', function () {
        client.getStatus(vin, function (err2, status) {
          if (err2) {
            console.error('  FAILED: ' + err2.message);
          } else {
            var keys = Object.keys(status);
            console.log('  ' + keys.length + ' keys; LAST_UPDATED_TIME=' +
              (status.LAST_UPDATED_TIME || '<absent -- fallback did not synthesise one>'));
            console.log('  DOOR_IS_ALL_DOORS_LOCKED=' + status.DOOR_IS_ALL_DOORS_LOCKED +
              ' FUEL_LEVEL_PERC=' + status.FUEL_LEVEL_PERC);
          }

          step('6/6 Position', function () {
            client.getPosition(vin, function (err3, pos) {
              if (err3) {
                console.error('  FAILED: ' + err3.message);
              } else {
                console.log('  fields present: ' + Object.keys(pos).join(', '));
              }
              runPerVehicle(vins, idx + 1);
            });
          });
        });
      });
    });
  });
}
