// analytics.js -- anonymous usage counters.
//
// WHAT IS SENT: an event name, a couple of low-cardinality enum labels, an app
// version, and a per-install random id. Nothing else.
//
// WHAT IS NEVER SENT, by construction rather than by care:
//   VIN or any vehicle identifier; coordinates, distance or bearing from
//   either phone or car; any speed; email, tokens, device id, PIN, or whether
//   a PIN is stored; fuel, range, odometer, service distances, tyre pressures;
//   lock/door/window state; vehicle name, model or year; JLR's failure strings;
//   any user-facing message. If a value could identify a vehicle or hint at
//   where it went, it is not here.
//
// NO TIMESTAMP IS SENT. The ingest service records Prometheus counters, which
// are timestamped on arrival, so "when" comes from the time series for free.
// Sending our own timestamp would add nothing and would turn a counter into
// something closer to an event log.
//
// COUNTRY is derived SERVER-SIDE from the connection (the service reads a
// trusted country header and keeps only the two-letter code; it never logs or
// stores the IP). The phone does not send, and does not know, its country.
//
// This module must never delay or break the app. Every send is
// fire-and-forget with a short timeout, failures are swallowed, and it is
// called only AFTER the user-visible work is done.
(function () {
  'use strict';

  var ENDPOINT = 'https://pebble.a22.dev/tracking';
  var APP = 'landy';
  var OPT_OUT_KEY = 'jlr_analytics_off';
  var WID_KEY = 'jlr_analytics_wid';
  var SEND_TIMEOUT_MS = 5000;

  function storage() {
    return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
  }

  function get(key) {
    var s = storage();
    if (!s || typeof s.getItem !== 'function') return null;
    try { return s.getItem(key); } catch (e) { return null; }
  }

  function set(key, value) {
    var s = storage();
    if (!s || typeof s.setItem !== 'function') return;
    try {
      if (value === null) { s.removeItem(key); } else { s.setItem(key, String(value)); }
    } catch (e) { /* best effort */ }
  }

  function isEnabled() {
    return get(OPT_OUT_KEY) !== '1';
  }

  function setEnabled(enabled) {
    set(OPT_OUT_KEY, enabled ? null : '1');
  }

  // A random per-install id, used only so the service can count distinct
  // installs per day. It identifies an installation, never a person or a
  // vehicle, is generated locally, is never derived from anything about the
  // account or car, and disappears if the app is reinstalled.
  function wid() {
    var existing = get(WID_KEY);
    if (existing) return existing;
    var id = '';
    for (var i = 0; i < 16; i++) {
      id += Math.floor(Math.random() * 16).toString(16);
    }
    set(WID_KEY, id);
    return id;
  }

  // The watch model, as the service's platform enum. Reported by the phone
  // app; falls back to "unknown", which the service accepts.
  var PLATFORMS = {
    aplite: 1, basalt: 1, chalk: 1, diorite: 1, emery: 1, flint: 1, gabbro: 1
  };
  var cachedPlatform = null;

  function platform() {
    if (cachedPlatform) return cachedPlatform;
    cachedPlatform = 'unknown';
    try {
      if (typeof Pebble !== 'undefined' && Pebble.getActiveWatchInfo) {
        var info = Pebble.getActiveWatchInfo();
        if (info && info.platform && PLATFORMS[info.platform] === 1) {
          cachedPlatform = info.platform;
        }
      }
    } catch (e) { /* older runtimes throw here; unknown is fine */ }
    return cachedPlatform;
  }

  function create(options) {
    options = options || {};
    var xhrFactory = options.xhrFactory || function () { return new XMLHttpRequest(); };
    var endpoint = options.endpoint || ENDPOINT;
    var version = options.version || '0.0.0';
    var onLog = options.log || function () {};
    var sent = [];          // exposed for tests only

    function send(event, fields) {
      if (!isEnabled()) return;
      // Field names are the ingest service's schema-1 contract, not ours:
      // schema, event, app_version, platform, wid. The service rejects
      // unknown fields outright, so a mismatch here is a silent 400 for every
      // event -- which is exactly what the first version of this shipped as.
      var body = {
        schema: 1,
        app: APP,
        event: event,
        app_version: version,
        platform: platform(),
        wid: wid()
      };
      if (fields) {
        for (var k in fields) {
          if (Object.prototype.hasOwnProperty.call(fields, k)) body[k] = fields[k];
        }
      }
      sent.push(body);
      var payload = JSON.stringify(body);
      var xhr;
      try {
        xhr = xhrFactory();
        xhr.open('POST', endpoint, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = SEND_TIMEOUT_MS;

        // The handlers LOG but never act. A dead or slow endpoint must still
        // be indistinguishable from a healthy one as far as the app is
        // concerned -- nothing here retries, blocks, or surfaces to the user.
        //
        // Logging the outcome matters because the failure mode is otherwise
        // completely silent: the service rejects unknown fields, so a schema
        // drift is a 400 that produces no symptom anywhere. The payload is
        // safe to log in full -- every field is allowlisted and tested, and
        // wid is a random install id.
        xhr.onload = function () {
          // pkjs XHR reports connection failures as status 0 with no onerror
          // (see the emulator note in jlr.js), so treat that as a failure here
          // rather than as a successful send.
          if (xhr.status === 0) {
            onLog('analytics ' + event + ' -> no response (status 0)');
          } else if (xhr.status >= 400) {
            onLog('analytics ' + event + ' -> HTTP ' + xhr.status + ' REJECTED' +
                  ' body=' + String(xhr.responseText).substring(0, 120));
          } else {
            onLog('analytics ' + event + ' -> HTTP ' + xhr.status + ' ok');
          }
        };
        xhr.onerror = function () {
          onLog('analytics ' + event + ' -> network error');
        };
        xhr.ontimeout = function () {
          onLog('analytics ' + event + ' -> timed out after ' + SEND_TIMEOUT_MS + 'ms');
        };
        onLog('analytics ' + event + ' -> sending ' + payload);
        xhr.send(payload);
      } catch (e) {
        onLog('analytics ' + event + ' -> threw before send (ignored): ' + e);
      }
    }

    return {
      // The app was opened. Version-labelled: if a JLR change breaks the app,
      // opens continue while commands collapse, which is the shape of a brick.
      appOpen: function () { send('app_open'); },

      // cmd is our own enum; outcome is one of success/declined/pending/error/
      // blocked. Gives real command reliability across many vehicles, which is
      // currently guesswork from forum anecdotes.
      // cmd is a NAME, not our internal enum number: the service uses it as a
      // Prometheus label, and a renumbered enum would silently change what a
      // metric means.
      command: function (cmd, outcome) {
        send('command', { cmd: String(cmd), outcome: String(outcome) });
      },

      // Why the safety gate closed: the vehicle was genuinely moving, or we
      // could not tell. If "unknown" dominates, the app is mostly locking out
      // people standing next to a parked car.
      safetyGate: function (kind) { send('safety_gate', { kind: String(kind) }); },

      // Which services this account's vehicle exposes. Answers whether
      // capability gating is load-bearing or theoretical.
      capability: function (service, state) {
        send('capability', { service: String(service), state: String(state) });
      },

      // A feature was used. Only features whose existence is in question.
      featureUse: function (feature) { send('feature_use', { feature: String(feature) }); },

      isEnabled: isEnabled,
      setEnabled: setEnabled,
      _sent: sent
    };
  }

  var Analytics = {
    create: create,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    OPT_OUT_KEY: OPT_OUT_KEY,
    ENDPOINT: ENDPOINT
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Analytics;
  } else {
    this.JLRAnalytics = Analytics;
  }
}).call(this);
