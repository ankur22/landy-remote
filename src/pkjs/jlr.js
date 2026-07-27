// jlr.js -- standalone PebbleKit JS client for the Jaguar Land Rover
// InControl "webview" backend.
//
// This is a straight port of the verified auth chain + endpoint contract in
// jlr-remote-research.md / jlr-vehicle-capabilities.md, cross-checked against
// the reference implementation at willbeeching/ha-jlr-incontrol (branch
// `master`, custom_components/jlr_incontrol/{api.py,const.py}) and against
// jlr-probe.py, which exercised the read paths live against a real account
// and a real 2018 Land Rover Discovery.
//
// Design constraints (pkjs is neither a browser nor Node):
//   - No npm dependencies. No ES6 assumed (var, not let/const; no arrow fns;
//     no Promises -- plain (err, result) callbacks throughout).
//   - XMLHttpRequest only. The emulator's XHR swallows connection failures
//     (readyState 4 + status 0, no onerror) -- every request path guards for
//     that explicitly (see xhrRequest()).
//   - Tokens (and the derived capability cache) are persisted in pkjs
//     localStorage. The plaintext password is NEVER persisted -- only the
//     email (needed to re-run device registration / user lookup) and the
//     refresh token are kept across app restarts. Losing the refresh token
//     means the caller must call login(email, password) again.
//   - Nothing here ever logs a credential, token, or PIN -- not even
//     truncated. VINs are masked in every log line (maskVin()).
//
// Commands are asynchronous: starting a service returns HTTP 202 ("accepted"),
// not "done". sendCommand() polls the service-status endpoint to a terminal
// state and resolves to one of three distinct outcomes -- 'success',
// 'declined' (the vehicle actively refused it, NegativeAcknowledge /
// failureDescription), or 'pending' (still not terminal after the poll
// window -- most often the car is asleep). Callers must be able to tell
// these apart; collapsing them into one generic "it failed" message is
// exactly the mistake the research doc warns against.

(function () {
  'use strict';

  // ---------------------------------------------------------------- hosts
  var IFAS_BASE = 'https://ifas.prod-row.jlrmotor.com/ifas';
  var IFOP_BASE = 'https://ifop.prod-row.jlrmotor.com/ifop/jlr';
  var IF9_BASE = 'https://if9.prod-row.jlrmotor.com/if9/webview';
  var TOKENS_URL = IFAS_BASE + '/webview/tokens';
  var TOKENS_BASIC_AUTH = 'Basic YXM6YXNwYXNz'; // fixed IFAS client cred "as:aspass"

  // ---------------------------------------------------- browser fingerprint
  // The whole webview edge hinges on these three headers. Miss Origin/Referer
  // and you get 498 (Approov wall) or 401. Confirmed to survive PebbleKit JS
  // intact (both the emulator and real iOS JavaScriptCore) -- see
  // jlr-remote-research.md "Spike risk #1 -- RESOLVED".
  var USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36';
  var WEBVIEW_ORIGIN = 'https://webview.prod-row.jlrmotor.com';
  var WEBVIEW_REFERER = 'https://webview.prod-row.jlrmotor.com/';
  var TELEMATICS_PROGRAM = 'landroverprogram';

  function browserHeaders() {
    return {
      'User-Agent': USER_AGENT,
      'Origin': WEBVIEW_ORIGIN,
      'Referer': WEBVIEW_REFERER
    };
  }

  // ------------------------------------------------- per-endpoint media types
  // Wrong Accept 406s. These are exact -- do not "simplify" to application/json
  // anywhere except the two endpoints that specifically require it.
  var MEDIA_JSON = 'application/json';
  var MEDIA_USER = 'application/vnd.wirelesscar.ngtp.if9.User-v4+json';
  var MEDIA_HEALTHSTATUS = 'application/vnd.ngtp.org.if9.healthstatus-v3+json';
  var MEDIA_AUTHENTICATE = 'application/vnd.wirelesscar.ngtp.if9.AuthenticateRequest-v2+json';
  var MEDIA_START_SERVICE = 'application/vnd.wirelesscar.ngtp.if9.StartServiceConfiguration-v3+json';
  // Classic command endpoints (lock, unlock, honkBlink, healthstatus) need v4.
  // v5 and plain application/json both 406 on these. (Only the BEV
  // PhevService endpoints -- preconditioning/chargeProfile, not used here --
  // want v5; deliberately not implemented, this app targets a diesel.)
  var MEDIA_SERVICE_STATUS_V4 = 'application/vnd.wirelesscar.ngtp.if9.ServiceStatus-v4+json';

  // ------------------------------------------------------- service catalogue
  var SERVICE_ENDPOINTS = {
    RDL: 'lock',
    RDU: 'unlock',
    HBLF: 'honkBlink',
    ALOFF: 'alarmOff',
    VHS: 'healthstatus',
    REON: 'engineOn',
    REOFF: 'engineOff'
  };
  // Services that authenticate with an empty PIN regardless of what the
  // caller passes (per jlrpy / willbeeching's native-app-derived behaviour).
  var SERVICES_EMPTY_PIN = { VHS: true };

  // --------------------------------------------------------- localStorage keys
  var LS_ACCESS = 'jlr_access_token';
  var LS_AUTHZ = 'jlr_authorization_token';
  var LS_REFRESH = 'jlr_refresh_token';
  var LS_EXPIRES_AT = 'jlr_expires_at';       // epoch ms
  var LS_DEVICE_ID = 'jlr_device_id';
  var LS_USER_ID = 'jlr_user_id';
  var LS_EMAIL = 'jlr_email';
  var LS_CAPS_PREFIX = 'jlr_caps_';           // + vin -> cached capability map
  var LS_CAPS_AT_PREFIX = 'jlr_caps_at_';     // + vin -> epoch ms of that cache

  var CAPS_TTL_MS = 24 * 60 * 60 * 1000; // attributes/capabilities effectively never change
  var TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before real expiry
  var POLL_ATTEMPTS = 10;   // ~30s, matches the reference implementation
  var POLL_INTERVAL_MS = 3000;

  // ------------------------------------------------------------------ utils

  function hasLocalStorage() {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  }

  function lsGet(key) {
    if (!hasLocalStorage()) return null;
    var v = localStorage.getItem(key);
    return (v === undefined) ? null : v;
  }

  function lsSet(key, value) {
    if (!hasLocalStorage()) return;
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  }

  // Never call this with a token, password, or PIN -- only public-ish values
  // (device ids, VINs via maskVin, HTTP statuses, service names).
  function log(msg) {
    console.log('JLR: ' + msg);
  }

  function maskVin(vin) {
    if (typeof vin === 'string' && vin.length > 9) {
      return vin.substring(0, 5) + '…' + vin.substring(vin.length - 4);
    }
    return '<vin>';
  }

  function uuid4() {
    var hex = '0123456789abcdef';
    var s = [];
    for (var i = 0; i < 36; i++) {
      s[i] = hex.charAt(Math.floor(Math.random() * 16));
    }
    s[14] = '4';
    var y = (parseInt(s[19], 16) & 0x3) | 0x8;
    s[19] = hex.charAt(y);
    s[8] = s[13] = s[18] = s[23] = '-';
    return s.join('');
  }

  function nowMs() {
    return new Date().getTime();
  }

  // Minimal, dependency-free JSON body POST/GET wrapper. Every call site gets
  // (err, status, payload) -- err is set for transport failures (including
  // the emulator's silent status===0 case), never for a clean HTTP error
  // status (callers inspect `status` themselves; that lets 401/406/202 etc.
  // be handled with the right JLR-specific meaning per call site).
  function xhrRequest(method, url, headers, bodyObj, callback) {
    var xhr = new XMLHttpRequest();
    var settled = false;

    function finish(err, status, payload) {
      if (settled) return;
      settled = true;
      callback(err, status, payload);
    }

    function parseBody() {
      var text = null;
      try {
        text = xhr.responseText;
      } catch (e) {
        text = null;
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (e2) {
        return null;
      }
    }

    xhr.timeout = 30000;

    xhr.onload = function () {
      // pkjs's emulator XHR has been observed to fire onload even for
      // status 0 completions in some builds; treat status 0 as a failure
      // uniformly rather than trusting onload alone.
      if (xhr.status === 0) {
        finish(new Error('connection failed (status 0)'), 0, null);
        return;
      }
      finish(null, xhr.status, parseBody());
    };

    xhr.onerror = function () {
      finish(new Error('network error'), 0, null);
    };

    xhr.ontimeout = function () {
      finish(new Error('request timed out'), 0, null);
    };

    // Belt-and-braces per the documented emulator gotcha: readyState===4 with
    // status===0 can complete with none of the above firing.
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4 && xhr.status === 0) {
        finish(new Error('connection failed (readyState 4, status 0)'), 0, null);
      }
    };

    try {
      xhr.open(method, url, true);
      for (var k in headers) {
        if (headers.hasOwnProperty(k)) {
          xhr.setRequestHeader(k, headers[k]);
        }
      }
      if (bodyObj !== undefined && bodyObj !== null) {
        xhr.send(JSON.stringify(bodyObj));
      } else {
        xhr.send();
      }
    } catch (e3) {
      finish(e3, 0, null);
    }
  }

  // ---------------------------------------------------------------- client

  function JlrClient() {
    this._accessToken = lsGet(LS_ACCESS);
    this._authorizationToken = lsGet(LS_AUTHZ);
    this._refreshToken = lsGet(LS_REFRESH);
    var expAt = lsGet(LS_EXPIRES_AT);
    this._expiresAt = expAt ? parseInt(expAt, 10) : 0;
    this._deviceId = lsGet(LS_DEVICE_ID);
    if (!this._deviceId) {
      this._deviceId = uuid4();
      lsSet(LS_DEVICE_ID, this._deviceId);
    }
    this._userId = lsGet(LS_USER_ID);
    this._email = lsGet(LS_EMAIL);
    // Whether the *current* access token has been registered with IFOP yet.
    // Any new token (login or refresh) must flip this back to false.
    this._deviceRegistered = false;
  }

  JlrClient.prototype.getDeviceId = function () {
    return this._deviceId;
  };

  JlrClient.prototype.getUserIdCached = function () {
    return this._userId;
  };

  JlrClient.prototype.isLoggedIn = function () {
    return !!this._accessToken;
  };

  JlrClient.prototype._webviewHeaders = function (accept) {
    var h = browserHeaders();
    h.Authorization = 'Bearer ' + this._accessToken;
    h['X-Device-Id'] = this._deviceId;
    h.clientId = this._deviceId; // yes, camelCase header name -- verified live
    h.Accept = accept;
    return h;
  };

  // -------------------------------------------------------------- auth

  JlrClient.prototype._tokenRequest = function (bodyObj, what, callback) {
    var self = this;
    var headers = browserHeaders();
    headers.Authorization = TOKENS_BASIC_AUTH;
    headers['Content-Type'] = MEDIA_JSON;
    headers.Accept = MEDIA_JSON;

    xhrRequest('POST', TOKENS_URL, headers, bodyObj, function (err, status, payload) {
      if (err) {
        log(what + ' transport error');
        callback(err);
        return;
      }
      if (status !== 200 || !payload || !payload.access_token) {
        log(what + ' failed, status=' + status);
        callback(new Error(what + ' returned status ' + status));
        return;
      }
      self._accessToken = payload.access_token;
      self._authorizationToken = payload.authorization_token || null;
      self._refreshToken = payload.refresh_token || self._refreshToken;
      var expiresInS = payload.expires_in ? parseInt(payload.expires_in, 10) : 86400;
      self._expiresAt = nowMs() + (expiresInS * 1000);
      // A new token means the device registration must be redone.
      self._deviceRegistered = false;

      lsSet(LS_ACCESS, self._accessToken);
      lsSet(LS_AUTHZ, self._authorizationToken);
      lsSet(LS_REFRESH, self._refreshToken);
      lsSet(LS_EXPIRES_AT, String(self._expiresAt));

      log(what + ' ok, expires in ' + expiresInS + 's');
      callback(null);
    });
  };

  // login(email, password, callback(err)) -- password grant. On success,
  // tokens are persisted; the plaintext password is held only in this call's
  // stack, never written to localStorage.
  JlrClient.prototype.login = function (email, password, callback) {
    var self = this;
    this._email = email;
    lsSet(LS_EMAIL, email);
    this._tokenRequest(
      { grant_type: 'password', username: email, password: password },
      'password grant',
      function (err) {
        if (err) {
          callback(err);
          return;
        }
        // Any fresh login invalidates any previously-cached user id (in case
        // this is actually a different account logging in on the same
        // install) -- re-resolve it lazily via connect()/getUserId().
        callback(null);
      }
    );
  };

  // refreshTokens(callback(err)) -- renew via the refresh_token grant.
  JlrClient.prototype.refreshTokens = function (callback) {
    if (!this._refreshToken) {
      callback(new Error('no refresh token available'));
      return;
    }
    this._tokenRequest(
      { grant_type: 'refresh_token', refresh_token: this._refreshToken },
      'token refresh',
      callback
    );
  };

  // ensureToken(callback(err)) -- refresh if near/at expiry. Does NOT fall
  // back to a full password re-login by itself (this module never persists
  // the password) -- if the refresh token is missing or rejected, it surfaces
  // an error so the caller (the watch app / config flow) can prompt for
  // credentials and call login() again.
  JlrClient.prototype.ensureToken = function (callback) {
    if (this._accessToken && nowMs() < (this._expiresAt - TOKEN_REFRESH_SKEW_MS)) {
      callback(null);
      return;
    }
    if (!this._refreshToken) {
      callback(new Error('not authenticated: call login(email, password) first'));
      return;
    }
    this.refreshTokens(callback);
  };

  // registerDevice(callback(err)) -- POST to IFOP. Idempotent server-side,
  // but per the contract MUST be re-run after every new access token, so this
  // tracks that per-client rather than assuming "registered once == forever".
  JlrClient.prototype.registerDevice = function (callback) {
    var self = this;
    if (this._deviceRegistered) {
      callback(null);
      return;
    }
    if (!this._email) {
      callback(new Error('no email on file; call login() first'));
      return;
    }
    var headers = browserHeaders();
    headers.Authorization = 'Bearer ' + this._accessToken;
    headers['X-Device-Id'] = this._deviceId;
    headers.Accept = '*/*';
    headers['Content-Type'] = MEDIA_JSON;
    headers['x-telematicsprogramtype'] = TELEMATICS_PROGRAM;
    var body = {
      access_token: this._accessToken,
      authorization_token: this._authorizationToken,
      expires_in: '86400',
      deviceID: this._deviceId
    };
    xhrRequest(
      'POST',
      IFOP_BASE + '/users/' + encodeURIComponent(this._email) + '/clients',
      headers,
      body,
      function (err, status) {
        if (err) {
          callback(err);
          return;
        }
        if (status !== 200 && status !== 204) {
          log('device registration failed, status=' + status);
          callback(new Error('device registration returned ' + status));
          return;
        }
        self._deviceRegistered = true;
        log('device registration ok, status=' + status);
        callback(null);
      }
    );
  };

  // getUserId(callback(err, userId)) -- resolves + caches the numeric IF9 user id.
  JlrClient.prototype.getUserId = function (callback) {
    var self = this;
    if (this._userId) {
      callback(null, this._userId);
      return;
    }
    if (!this._email) {
      callback(new Error('no email on file; call login() first'));
      return;
    }
    xhrRequest(
      'GET',
      IF9_BASE + '/users?loginName=' + encodeURIComponent(this._email),
      this._webviewHeaders(MEDIA_USER),
      null,
      function (err, status, payload) {
        if (err) {
          callback(err);
          return;
        }
        if (status !== 200 || !payload || !payload.userId) {
          callback(self._authError('user lookup', status));
          return;
        }
        self._userId = payload.userId;
        lsSet(LS_USER_ID, String(self._userId));
        callback(null, self._userId);
      }
    );
  };

  // connect(callback(err)) -- ensure valid token + registered device + known
  // user id. Every higher-level call goes through this first.
  JlrClient.prototype.connect = function (callback) {
    var self = this;
    this.ensureToken(function (err) {
      if (err) {
        callback(err);
        return;
      }
      self.registerDevice(function (err2) {
        if (err2) {
          callback(err2);
          return;
        }
        if (self._userId) {
          callback(null);
          return;
        }
        self.getUserId(function (err3) {
          callback(err3 || null);
        });
      });
    });
  };

  JlrClient.prototype._authError = function (what, status) {
    if (status === 498) {
      return new Error(what + ' returned 498 (Approov edge wall -- ' +
        'Origin/Referer/clientId headers missing or rejected)');
    }
    if (status === 401) {
      return new Error(what + ' returned 401 (token expired or invalid)');
    }
    if (status === 406) {
      return new Error(what + ' returned 406 (wrong Accept media type for this endpoint)');
    }
    return new Error(what + ' returned status ' + status);
  };

  // ----------------------------------------------------------- vehicle reads

  // getVehicles(callback(err, vehicles[])) -- Accept must be plain
  // application/json here; the vnd.* media type 406s on this endpoint.
  JlrClient.prototype.getVehicles = function (callback) {
    var self = this;
    this.connect(function (err) {
      if (err) {
        callback(err);
        return;
      }
      xhrRequest(
        'GET',
        IF9_BASE + '/users/' + self._userId + '/vehicles',
        self._webviewHeaders(MEDIA_JSON),
        null,
        function (err2, status, payload) {
          if (err2) {
            callback(err2);
            return;
          }
          if (status !== 200 || !payload) {
            callback(self._authError('vehicle list', status));
            return;
          }
          callback(null, payload.vehicles || []);
        }
      );
    });
  };

  // getAttributes(vin, callback(err, attributes)) -- also Accept application/json.
  JlrClient.prototype.getAttributes = function (vin, callback) {
    var self = this;
    this.connect(function (err) {
      if (err) {
        callback(err);
        return;
      }
      xhrRequest(
        'GET',
        IF9_BASE + '/vehicles/' + vin + '/attributes',
        self._webviewHeaders(MEDIA_JSON),
        null,
        function (err2, status, payload) {
          if (err2) {
            callback(err2);
            return;
          }
          if (status !== 200 || !payload) {
            callback(self._authError('attributes for ' + maskVin(vin), status));
            return;
          }
          callback(null, payload);
        }
      );
    });
  };

  // serviceState(attributes, code) -> 'available' | 'not_capable' |
  // 'not_enabled' | 'unknown'. Ported from jlr-vehicle-capabilities.md
  // section 2.4 -- msp1974's strictness (require BOTH vehicleCapable and
  // serviceEnabled) combined with willbeeching's fail-open when the whole
  // list is missing.
  function serviceState(attributes, code) {
    var list = attributes && attributes.availableServices;
    if (!isArray(list) || list.length === 0) {
      return 'unknown'; // field absent entirely -- don't hide the button
    }
    var entry = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].serviceType === code) {
        entry = list[i];
        break;
      }
    }
    if (!entry) return 'not_capable';           // enumerated list, code absent
    if (entry.vehicleCapable === false) return 'not_capable';
    if (entry.serviceEnabled === false) return 'not_enabled';
    return 'available';
  }

  function isArray(x) {
    return Object.prototype.toString.call(x) === '[object Array]';
  }

  // getCapabilities(vin, callback(err, caps)) -- fetches attributes (using the
  // 24h cache in localStorage when fresh) and returns:
  //   { RDL: 'available', RDU: 'available', HBLF: 'available', VHS: 'available',
  //     REON: 'available', fuelType: 'Diesel', raw: <attributes> }
  JlrClient.prototype.getCapabilities = function (vin, callback) {
    var self = this;
    var cacheKey = LS_CAPS_PREFIX + vin;
    var cacheAtKey = LS_CAPS_AT_PREFIX + vin;
    var cachedAt = lsGet(cacheAtKey);
    if (cachedAt && (nowMs() - parseInt(cachedAt, 10)) < CAPS_TTL_MS) {
      var cachedRaw = lsGet(cacheKey);
      if (cachedRaw) {
        try {
          callback(null, JSON.parse(cachedRaw));
          return;
        } catch (e) {
          // fall through and re-fetch on a corrupt cache entry
        }
      }
    }
    this.getAttributes(vin, function (err, attrs) {
      if (err) {
        callback(err);
        return;
      }
      var caps = {
        RDL: serviceState(attrs, 'RDL'),
        RDU: serviceState(attrs, 'RDU'),
        HBLF: serviceState(attrs, 'HBLF'),
        VHS: serviceState(attrs, 'VHS'),
        REON: serviceState(attrs, 'REON'),
        REOFF: serviceState(attrs, 'REOFF'),
        ALOFF: serviceState(attrs, 'ALOFF'),
        fuelType: attrs.fuelType || null,
        vehicleType: attrs.vehicleType || null,
        modelYear: attrs.modelYear || null
      };
      lsSet(cacheKey, JSON.stringify(caps));
      lsSet(cacheAtKey, String(nowMs()));
      callback(null, caps);
    });
  };

  // _flatten_status port -- see jlr-remote-research.md's "implementation trap".
  // Resolves LAST_UPDATED_TIME through three tiers, most to least authoritative:
  //
  //   1. a LAST_UPDATED_TIME entry in the coreStatus/evStatus key/value list
  //   2. the newest per-item `lastUpdatedTime` on the individual entries
  //      (willbeeching/api.py::_flatten_status does 1 + 2 and stops there)
  //   3. the payload's OWN top-level `lastUpdatedTime`
  //
  // Tier 3 is ours, and it is not optional. Verified live 2026-07-27 against the
  // target 2018 Discovery: it reports NO LAST_UPDATED_TIME key and its status
  // items carry ONLY {key, value} -- no per-item timestamps at all -- so tiers 1
  // and 2 both come up empty and the reference implementation yields nothing.
  // The freshness signal is there, just one level up:
  //     {vehicleStatus: {...}, vehicleAlerts: [...], lastUpdatedTime: "2026-07-27T08:02:29+0000"}
  // Without tier 3 the status card has no honest "updated N ago" to show.
  //
  // Tiers are ordered, not compared: tier 3's "+0000" offset format differs from
  // the per-item ISO form, so comparing them lexicographically would be unsound.
  function flattenStatus(payload) {
    var status = {};
    var newestItemTs = '';
    var vehicleStatus = (payload && payload.vehicleStatus) || {};
    var groups = ['coreStatus', 'evStatus'];
    for (var g = 0; g < groups.length; g++) {
      var items = vehicleStatus[groups[g]] || [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item) continue;
        if (item.key !== undefined && item.key !== null) {
          status[item.key] = item.value;
        }
        var itemTs = item.lastUpdatedTime;
        // ISO timestamps in a consistent format sort lexicographically.
        if (typeof itemTs === 'string' && itemTs > newestItemTs) {
          newestItemTs = itemTs;
        }
      }
    }
    var existing = status.LAST_UPDATED_TIME || '';
    if (newestItemTs && newestItemTs > existing) {
      status.LAST_UPDATED_TIME = newestItemTs;
    }
    // Tier 3: the response's own top-level timestamp. Only consulted when tiers
    // 1 and 2 produced nothing -- see the note above on why these are not
    // compared against each other.
    if (!status.LAST_UPDATED_TIME &&
        payload && typeof payload.lastUpdatedTime === 'string' &&
        payload.lastUpdatedTime) {
      status.LAST_UPDATED_TIME = payload.lastUpdatedTime;
    }
    return status;
  }
  // Exposed for unit-shape testing without a network round trip.
  JlrClient._flattenStatus = flattenStatus;

  // getStatus(vin, callback(err, flatStatusDict)) -- Accept the healthstatus
  // vnd type; flattened via flattenStatus() above.
  JlrClient.prototype.getStatus = function (vin, callback) {
    var self = this;
    this.connect(function (err) {
      if (err) {
        callback(err);
        return;
      }
      xhrRequest(
        'GET',
        IF9_BASE + '/vehicles/' + vin + '/status',
        self._webviewHeaders(MEDIA_HEALTHSTATUS),
        null,
        function (err2, status, payload) {
          if (err2) {
            callback(err2);
            return;
          }
          if (status !== 200 || !payload) {
            callback(self._authError('status for ' + maskVin(vin), status));
            return;
          }
          callback(null, flattenStatus(payload));
        }
      );
    });
  };

  // getPosition(vin, callback(err, position)) -- {latitude, longitude,
  // heading, speed, positionQuality, timestamp, ...}. Accept application/json.
  JlrClient.prototype.getPosition = function (vin, callback) {
    var self = this;
    this.connect(function (err) {
      if (err) {
        callback(err);
        return;
      }
      xhrRequest(
        'GET',
        IF9_BASE + '/vehicles/' + vin + '/position',
        self._webviewHeaders(MEDIA_JSON),
        null,
        function (err2, status, payload) {
          if (err2) {
            callback(err2);
            return;
          }
          if (status !== 200 || !payload) {
            callback(self._authError('position for ' + maskVin(vin), status));
            return;
          }
          callback(null, payload.position || {});
        }
      );
    });
  };

  // ------------------------------------------------------------- commands
  //
  // sendCommand(vin, serviceName, pin, serviceParameters, callback(err, result))
  //
  // result on a settled poll:
  //   { outcome: 'success', status: <raw terminal payload> }
  //   { outcome: 'declined', status: <raw terminal payload>,
  //     failureReason, failureDescription }
  //   { outcome: 'pending', status: <raw last-seen payload> }
  //
  // `err` is only set for hard failures before a service was even started
  // (auth failure, unknown service, transport error, non-202/200 on the
  // start call). Once a customerServiceId exists, every outcome -- including
  // an eventual vehicle refusal -- comes back through `result`, never `err`,
  // so the caller can't accidentally treat "car said no" as a code bug.
  JlrClient.prototype.sendCommand = function (vin, serviceName, pin, serviceParameters, callback) {
    var self = this;
    var endpoint = SERVICE_ENDPOINTS[serviceName];
    if (!endpoint) {
      callback(new Error('unknown service ' + serviceName));
      return;
    }
    var authPin = SERVICES_EMPTY_PIN[serviceName] ? '' : (pin || '');

    this.connect(function (err) {
      if (err) {
        callback(err);
        return;
      }
      self._authenticateService(vin, serviceName, authPin, function (err2, token) {
        if (err2) {
          callback(err2);
          return;
        }
        self._startService(vin, serviceName, endpoint, token, serviceParameters, function (err3, started) {
          if (err3) {
            callback(err3);
            return;
          }
          var serviceId = started && started.customerServiceId;
          if (!serviceId) {
            // Some responses (e.g. a bare 200 with no id) have nothing to
            // poll; treat as success-shaped rather than guessing.
            callback(null, { outcome: 'success', status: started });
            return;
          }
          self._pollService(vin, serviceId, started, 0, callback);
        });
      });
    });
  };

  JlrClient.prototype._authenticateService = function (vin, serviceName, pin, callback) {
    var self = this;
    var headers = this._webviewHeaders(MEDIA_JSON);
    headers['Content-Type'] = MEDIA_AUTHENTICATE;
    xhrRequest(
      'POST',
      IF9_BASE + '/vehicles/' + vin + '/users/' + this._userId + '/authenticate',
      headers,
      { pin: pin, serviceName: serviceName },
      function (err, status, payload) {
        if (err) {
          callback(err);
          return;
        }
        if ((status !== 200 && status !== 201) || !payload || !payload.token) {
          log('authenticate(' + serviceName + ') for ' + maskVin(vin) + ' failed, status=' + status);
          callback(self._authError('authenticate (' + serviceName + ')', status));
          return;
        }
        callback(null, payload.token);
      }
    );
  };

  JlrClient.prototype._startService = function (vin, serviceName, endpoint, token, serviceParameters, callback) {
    var self = this;
    var headers = this._webviewHeaders(MEDIA_SERVICE_STATUS_V4);
    headers['Content-Type'] = MEDIA_START_SERVICE;
    var body = { token: token };
    if (serviceParameters) {
      body.serviceParameters = serviceParameters;
    }
    xhrRequest(
      'POST',
      IF9_BASE + '/vehicles/' + vin + '/' + endpoint,
      headers,
      body,
      function (err, status, payload) {
        if (err) {
          callback(err);
          return;
        }
        if (status !== 200 && status !== 202) {
          log('start service ' + serviceName + ' for ' + maskVin(vin) + ' failed, status=' + status);
          callback(self._authError('start service (' + serviceName + ')', status));
          return;
        }
        log('start service ' + serviceName + ' for ' + maskVin(vin) + ' -> status=' + status);
        callback(null, payload || {});
      }
    );
  };

  JlrClient.prototype._pollService = function (vin, serviceId, lastStatus, attempt, callback) {
    var self = this;
    var state = String((lastStatus && lastStatus.status) || '').toLowerCase();

    if (state === 'successful' || state === 'success') {
      callback(null, { outcome: 'success', status: lastStatus });
      return;
    }
    if (state === 'failed' || state === 'aborted' || state === 'cancelled') {
      callback(null, {
        outcome: 'declined',
        status: lastStatus,
        failureReason: lastStatus.failureReason || null,
        failureDescription: lastStatus.failureDescription || null
      });
      return;
    }
    if (attempt >= POLL_ATTEMPTS) {
      log('service ' + serviceId + ' for ' + maskVin(vin) + ' still pending after ' +
        (POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000) + 's (last state: ' + state + ')');
      callback(null, { outcome: 'pending', status: lastStatus });
      return;
    }
    setTimeout(function () {
      self.getServiceStatus(vin, serviceId, function (err, status) {
        if (err) {
          // A transport hiccup mid-poll shouldn't kill the whole flow --
          // retry with the last known status until the attempt budget runs out.
          self._pollService(vin, serviceId, lastStatus, attempt + 1, callback);
          return;
        }
        self._pollService(vin, serviceId, status, attempt + 1, callback);
      });
    }, POLL_INTERVAL_MS);
  };

  // getServiceStatus(vin, customerServiceId, callback(err, statusPayload)) --
  // exposed directly too, in case a caller wants to poll on its own schedule.
  JlrClient.prototype.getServiceStatus = function (vin, customerServiceId, callback) {
    var self = this;
    this.connect(function (err) {
      if (err) {
        callback(err);
        return;
      }
      xhrRequest(
        'GET',
        IF9_BASE + '/vehicles/' + vin + '/services/' + customerServiceId,
        self._webviewHeaders(MEDIA_SERVICE_STATUS_V4),
        null,
        function (err2, status, payload) {
          if (err2) {
            callback(err2);
            return;
          }
          if (status !== 200 || !payload) {
            callback(self._authError('service status', status));
            return;
          }
          callback(null, payload);
        }
      );
    });
  };

  // --------------------------------------------------------- convenience API

  JlrClient.prototype.lock = function (vin, pin, callback) {
    this.sendCommand(vin, 'RDL', pin, null, callback);
  };

  JlrClient.prototype.unlock = function (vin, pin, callback) {
    // Unlock is a 45s window on the driver's door only, then the car
    // auto-re-locks -- see jlr-remote-research.md. The caller is
    // responsible for surfacing that as a countdown, not this module.
    this.sendCommand(vin, 'RDU', pin, null, callback);
  };

  JlrClient.prototype.honkFlash = function (vin, pin, callback) {
    this.sendCommand(vin, 'HBLF', pin, null, callback);
  };

  // refreshFromVehicle -- VHS, always an empty PIN regardless of what's
  // passed (SERVICES_EMPTY_PIN enforces this centrally too).
  JlrClient.prototype.refreshFromVehicle = function (vin, callback) {
    this.sendCommand(vin, 'VHS', '', null, callback);
  };

  // ------------------------------------------------------------- lifecycle

  // logout() -- clears every persisted credential/token. Does not touch the
  // capability cache (harmless without a valid session, and re-derived on
  // next login anyway).
  JlrClient.prototype.logout = function () {
    this._accessToken = null;
    this._authorizationToken = null;
    this._refreshToken = null;
    this._expiresAt = 0;
    this._userId = null;
    this._deviceRegistered = false;
    lsSet(LS_ACCESS, null);
    lsSet(LS_AUTHZ, null);
    lsSet(LS_REFRESH, null);
    lsSet(LS_EXPIRES_AT, null);
    lsSet(LS_USER_ID, null);
  };

  // ------------------------------------------------- motion gating / safety
  //
  // Product rule: if the vehicle is (or may be) in motion, the watch shows
  // "Vehicle in motion" and NOTHING else -- no location, no fuel, no doors --
  // and remote commands are refused.
  //
  // Two distinct reasons, and they want different signals:
  //
  //   a) Driver distraction. The person looking at the watch may be the one
  //      driving. The best signal here is the PHONE's own GPS speed, which is
  //      live -- not the car's cloud status, which can be hours stale.
  //   b) Never unlock a moving car. Here the car's own reported speed matters,
  //      even if the phone is stationary (someone else is driving it).
  //
  // Staleness is the crux and it is not solvable from cached status alone: the
  // observed LAST_UPDATED_TIME was hours old, so "car reports parked" is NOT
  // evidence the car is parked now. Hence: phone speed is authoritative for (a),
  // the car's data can only ever ADD a reason to hide, never clear one, and
  // freshness is reported so the UI can be honest about what it knows.

  // ~5 km/h. Below this, GPS noise on a stationary vehicle produces false
  // positives; above it, someone is being moved.
  var MOTION_SPEED_KMH = 5;

  function toKmh(speed, units) {
    if (typeof speed !== 'number' || isNaN(speed)) return null;
    if (units === 'mph') return speed * 1.609344;
    if (units === 'ms') return speed * 3.6;          // m/s, e.g. phone geolocation
    return speed;                                     // assume km/h
  }

  function parseTs(ts) {
    if (typeof ts !== 'string' || !ts) return null;
    // Normalise "+0000" (no colon) which older engines refuse to parse.
    var norm = ts.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    var ms = Date.parse(norm);
    return isNaN(ms) ? null : ms;
  }

  // motionState(status, position, phone) -> {
  //   moving: bool,          // true => show nothing but "Vehicle in motion"
  //   commandsAllowed: bool, // false => refuse lock/unlock/honk/start
  //   reasons: [string],     // why, for logging and the UI's detail line
  //   statusAgeSeconds: number|null
  // }
  //
  // `phone` is optional: { speed: <number>, units: 'ms'|'kmh'|'mph' } from the
  // phone's geolocation. Pass it whenever available -- it is the only live
  // signal we have.
  function motionState(status, position, phone) {
    status = status || {};
    position = position || {};
    var reasons = [];
    var moving = false;

    // (a) Live phone speed -- authoritative for driver distraction.
    var phoneKmh = phone ? toKmh(phone.speed, phone.units || 'ms') : null;
    if (phoneKmh !== null && phoneKmh >= MOTION_SPEED_KMH) {
      moving = true;
      reasons.push('phone moving at ' + Math.round(phoneKmh) + ' km/h');
    }

    // (b) The car's own reported speed. Can only add a reason to hide.
    var carKmh = toKmh(position.speed, position.units || 'kmh');
    if (carKmh !== null && carKmh >= MOTION_SPEED_KMH) {
      moving = true;
      reasons.push('vehicle reported ' + Math.round(carKmh) + ' km/h');
    }

    // Corroboration only. The full VEHICLE_STATE_TYPE enum is NOT publicly
    // documented -- the only value observed on the target car is
    // KEY_ON_ENGINE_OFF (parked). So we deliberately do not allowlist "parked"
    // states, because an unknown value must never be read as "safe to show".
    // We only react to states that positively indicate a running engine.
    var vst = String(status.VEHICLE_STATE_TYPE || '').toUpperCase();
    if (vst && /ENGINE_ON|ENGINE_RUNNING|DRIVING|MOVING/.test(vst)) {
      moving = true;
      reasons.push('vehicle state ' + vst);
    }

    var updatedMs = parseTs(status.LAST_UPDATED_TIME);
    var ageSeconds = updatedMs === null ? null :
      Math.max(0, Math.round((nowMs() - updatedMs) / 1000));

    return {
      moving: moving,
      // Never send a command to a car that might be moving. If the phone is
      // stationary we still refuse when the CAR looks like it is moving.
      commandsAllowed: !moving,
      reasons: reasons,
      statusAgeSeconds: ageSeconds
    };
  }

  // Given a flattened status and a motionState, return only what may be shown.
  // When moving this is deliberately near-empty -- no location, no fuel, no
  // door states, nothing that invites a second look.
  function displaySafeStatus(status, motion) {
    if (motion && motion.moving) {
      return { IN_MOTION: true };
    }
    return status || {};
  }

  // ------------------------------------------------------------------ export

  var JLR = {
    Client: JlrClient,
    maskVin: maskVin,
    serviceState: serviceState,
    flattenStatus: flattenStatus,
    motionState: motionState,
    displaySafeStatus: displaySafeStatus,
    MOTION_SPEED_KMH: MOTION_SPEED_KMH
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = JLR;
  } else {
    // Fallback for environments without CommonJS (shouldn't happen under
    // enableMultiJS, kept defensive).
    this.JLR = JLR;
  }
}).call(this);
