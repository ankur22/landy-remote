// real.js -- safety-first adapter from JLR.Client to the small client surface
// consumed by the PebbleKit bridge.
//
// All side-effecting dependencies can be injected. In particular, tests pass
// a rawClient fake, so merely loading/testing this module can never issue an
// XMLHttpRequest or contact a vehicle.
(function () {
  'use strict';

  var DEFAULT_JLR = require('./jlr');
  var SELECTED_VIN_KEY = 'jlr_selected_vin';
  var PIN_KEY = 'jlr_pin';
  var CLIMATE_TEMP_KEY = 'jlr_climate_temp_c';
  var CLIMATE_TEMP_DEFAULT_C = 21;
  var PHONE_FIX_MAX_AGE_MS = 10000;
  // A GPS fix timestamp does not come from the same clock as Date.now() -- iOS
  // stamps it from the location subsystem -- so a fresh fix can legitimately
  // read a few milliseconds INTO THE FUTURE relative to our clock. Rejecting
  // every negative age would then intermittently report motion_unknown and
  // strand the user on "Checking safety" with all controls dead, for no real
  // reason. Tolerate small skew; still reject fixes dated meaningfully ahead,
  // which would indicate a genuinely untrustworthy clock.
  var PHONE_FIX_MAX_SKEW_MS = 2000;

  // ---- deriving speed when the OS will not report one ----
  // Gap between the two fixes used to measure displacement. Long enough that a
  // moving vehicle travels well clear of GPS noise, short enough not to make
  // opening the app feel broken.
  var DERIVE_INTERVAL_MS = 3000;
  var PHONE_FIX_TIMEOUT_MS = 10000;
  // One fix, so the budget is just the fix timeout plus a little slack. It was
  // 35s when this took three fixes six seconds apart -- which is most of why a
  // status refresh used to take the best part of ten seconds.
  var PHONE_READING_BUDGET_MS = 12000;
  // Two stationary fixes still wander. Below this displacement we cannot
  // distinguish movement from noise, so we call it stationary.
  //
  // TRADE-OFF, stated plainly: with a 3 s gap and a 15 m floor, this cannot
  // detect motion below roughly 18 km/h -- walking pace reads as stationary.
  // That is accepted deliberately. The risk this gate exists to prevent is
  // unlocking or distracting someone in a MOVING VEHICLE, which is far above
  // that; and the car's own reported speed is still checked independently and
  // can veto on its own. The alternative -- refusing to act without a
  // sub-walking-pace guarantee -- means the app never works at all, which is
  // what shipped before this fix.
  var DERIVE_MIN_NOISE_M = 15;
  // Beyond this reported accuracy the displacement figure is meaningless, so
  // we return unknown rather than guess.
  var DERIVE_MAX_ACCURACY_M = 65;
  var DERIVE_ASSUMED_ACCURACY_M = 25;   // when the OS omits accuracy entirely
  // ~250 km/h. Above this the two fixes disagree by more than any car could
  // travel, which means they came from different sources rather than that
  // anything moved.
  var DERIVE_IMPLAUSIBLE_MS = 70;

  var BUNDLE_REUSE_MS = 10000;

  function typedError(code, message, cause) {
    var err = new Error(message);
    err.code = code;
    if (cause) err.cause = cause;
    return err;
  }

  function globalStorage() {
    return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
  }

  function globalGeolocation() {
    return (typeof navigator !== 'undefined' && navigator.geolocation) ?
      navigator.geolocation : null;
  }

  function storageGet(storage, key) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try { return storage.getItem(key); } catch (err) { return null; }
  }

  function storageSet(storage, key, value) {
    if (!storage || typeof storage.setItem !== 'function') return;
    try { storage.setItem(key, value); } catch (err) { /* cache is best effort */ }
  }

  function nowMs(clock) {
    if (clock && typeof clock.now === 'function') return clock.now();
    if (typeof clock === 'function') return clock();
    return new Date().getTime();
  }

  function isNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function vehicleVin(vehicle) {
    if (!vehicle) return null;
    return vehicle.vin || vehicle.VIN || vehicle.vehicleId || null;
  }

  function findVehicle(vehicles, vin) {
    for (var i = 0; i < vehicles.length; i++) {
      if (vehicleVin(vehicles[i]) === vin) return vehicles[i];
    }
    return null;
  }



  function normalizedReadError(cause, fallbackCode, message) {
    var detail = cause && cause.message ? String(cause.message).toLowerCase() : '';
    if (detail.indexOf('refresh token') !== -1 ||
        detail.indexOf('not authenticated') !== -1 ||
        detail.indexOf('token expired') !== -1 ||
        detail.indexOf('401') !== -1) {
      return typedError('auth_expired', 'Sign in again.', cause);
    }
    return typedError(fallbackCode, message, cause);
  }

  // Normalise a fix timestamp to epoch ms. The W3C geolocation spec says
  // DOMTimeStamp, but the Pebble Core iOS runtime was observed (2026-07-28)
  // returning something isNumber() rejects, so accept the plausible shapes
  // rather than assume one: number, Date, or parseable string.
  //
  // Returns {ms, source} where source is 'fix' or 'receipt'. A fix with no
  // usable timestamp of any kind falls back to OUR receipt time -- see
  // checkFix for why that is defensible and what it costs.
  function fixTimeMs(position, receiptTime) {
    var raw = position ? position.timestamp : null;
    if (isNumber(raw)) return { ms: raw, source: 'fix' };
    if (raw && typeof raw.getTime === 'function') {
      var viaDate = raw.getTime();
      if (isNumber(viaDate)) return { ms: viaDate, source: 'fix' };
    }
    if (typeof raw === 'string' && raw) {
      var parsed = Date.parse(raw);
      if (isNumber(parsed)) return { ms: parsed, source: 'fix' };
    }
    return { ms: receiptTime, source: 'receipt' };
  }

  // Validate a raw geolocation fix's position and freshness (NOT its speed).
  // Returns null if usable, else a reason string describing what failed.
  //
  // On the receipt-time fallback: when the platform gives us no usable
  // timestamp we cannot verify freshness independently, so we treat the fix as
  // taken now. That is weaker than a real timestamp, and it is a deliberate
  // trade: every request passes maximumAge:0, so the OS has been asked not to
  // hand back a cached fix, and the alternative is an app that refuses to work
  // at all on a platform that never sends timestamps (observed on real
  // hardware). The car's own reported speed is still checked independently.
  function checkFix(position, currentTime, receiptTime) {
    var coords = position && position.coords;
    if (!coords) return 'no coords';
    if (!isNumber(coords.latitude) || !isNumber(coords.longitude)) return 'no lat/lon';
    var t = fixTimeMs(position, receiptTime === undefined ? currentTime : receiptTime);
    if (t.source === 'receipt') return null;   // freshness unverifiable; see above
    var age = currentTime - t.ms;
    if (age < -PHONE_FIX_MAX_SKEW_MS) return 'fix ' + (-age) + 'ms in the future';
    if (age > PHONE_FIX_MAX_AGE_MS) {
      return 'fix ' + age + 'ms old, limit ' + PHONE_FIX_MAX_AGE_MS + 'ms';
    }
    return null;
  }

  // Read the phone's speed. ONE fix, and a failure is not fatal.
  //
  // This replaced a much larger routine: three fixes six seconds apart, a
  // displacement calculation, accuracy bounds, clock-skew tolerance and an
  // implausible-speed check. Every piece of that was added to fix something
  // real, but the aggregate had nine ways to fail and one way to succeed --
  // and each failure locked the user out of their own car. Observed stuck on
  // "Checking safety" both indoors and outdoors.
  //
  // The rule is now: a speed we can trust is used; anything else means we
  // simply do not know, and not knowing is no longer treated as motion. See
  // motionState() -- only POSITIVE evidence of movement blocks a command.
  //
  // Note iOS reports coords.speed = -1 when Core Location has no valid speed,
  // which is the normal case standing still. Under the old rules that was the
  // trigger for the whole three-fix dance; now it just means "unknown".
  function phoneReading(geolocation, timers, currentTime, clock, callback) {
    if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
      callback(null, null);            // unknown, not an error
      return;
    }
    var settled = false;
    var timerId = null;

    function finish(value) {
      if (settled) return;
      settled = true;
      if (timerId !== null && timers && typeof timers.clearTimeout === 'function') {
        timers.clearTimeout(timerId);
      }
      callback(null, value);
    }

    timerId = timers.setTimeout(function () {
      finish(null);                    // slow fix -> unknown, not blocked
    }, PHONE_READING_BUDGET_MS);

    try {
      geolocation.getCurrentPosition(function (position) {
        var coords = position && position.coords;
        if (!coords || !isNumber(coords.latitude) || !isNumber(coords.longitude)) {
          finish(null);
          return;
        }
        if (!isNumber(coords.speed) || coords.speed < 0) {
          // No usable speed. We still know WHERE the phone is, which
          // find-my-car needs, so return the position with speed unknown.
          finish({
            latitude: coords.latitude,
            longitude: coords.longitude,
            speed: null,
            units: 'ms'
          });
          return;
        }
        finish({
          latitude: coords.latitude,
          longitude: coords.longitude,
          speed: coords.speed,
          units: 'ms'
        });
      }, function () {
        finish(null);                  // denied or unavailable -> unknown
      }, {
        enableHighAccuracy: true,
        maximumAge: PHONE_FIX_MAX_AGE_MS,
        timeout: PHONE_FIX_TIMEOUT_MS
      });
    } catch (err) {
      finish(null);
    }
  }


  function toRad(degrees) { return degrees * Math.PI / 180; }
  function toDeg(radians) { return radians * 180 / Math.PI; }

  function distanceM(from, to) {
    var dLat = toRad(to.latitude - from.latitude);
    var dLon = toRad(to.longitude - from.longitude);
    var lat1 = toRad(from.latitude);
    var lat2 = toRad(to.latitude);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) *
      Math.cos(lat1) * Math.cos(lat2);
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingDeg(from, to) {
    var lat1 = toRad(from.latitude);
    var lat2 = toRad(to.latitude);
    var dLon = toRad(to.longitude - from.longitude);
    var y = Math.sin(dLon) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function parseTimestamp(value) {
    if (!value) return null;
    var ms = Date.parse(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return isNaN(ms) ? null : ms;
  }

  function RealClient(options) {
    options = options || {};
    this._jlr = options.jlr || DEFAULT_JLR;
    this._raw = options.rawClient || new this._jlr.Client();
    this._geolocation = options.geolocation || globalGeolocation();
    this._storage = options.storage || globalStorage();
    this._clock = options.clock || null;
    this._timers = options.timers || {
      setTimeout: function (fn, delay) { return setTimeout(fn, delay); },
      clearTimeout: function (id) { clearTimeout(id); }
    };
    this._configured = options.configured !== undefined ?
      !!options.configured :
      (!!options.rawClient ||
        (this._raw && typeof this._raw.isLoggedIn === 'function' &&
          this._raw.isLoggedIn()));
    this._pin = options.pin;
    this._climateTempC = options.climateTempC;
    this._selectedVin = null;
    this._selectedVehicle = null;
    this._latestBundle = null;
  }

  RealClient.prototype._selectVehicle = function (callback) {
    var self = this;
    if (!this._configured) {
      callback(typedError('not_configured', 'Configure Landy Remote first.'));
      return;
    }
    if (this._selectedVin) {
      callback(null, this._selectedVin, this._selectedVehicle);
      return;
    }
    this._raw.getVehicles(function (err, vehicles) {
      if (err) {
        callback(normalizedReadError(err, 'transport_failure',
          'Could not read vehicles.'));
        return;
      }
      vehicles = vehicles || [];
      if (!vehicles.length) {
        callback(typedError('no_vehicles',
          'No vehicle is available on this account.'));
        return;
      }
      var storedVin = storageGet(self._storage, SELECTED_VIN_KEY);
      var selected = storedVin ? findVehicle(vehicles, storedVin) : null;
      if (storedVin && !selected) {
        callback(typedError('vehicle_selection_required',
          'The configured vehicle is not on this account.'));
        return;
      }
      if (!storedVin && vehicles.length !== 1) {
        callback(typedError('vehicle_selection_required',
          'Select a vehicle before continuing.'));
        return;
      }
      if (!selected) selected = vehicles[0];
      var vin = vehicleVin(selected);
      if (!vin) {
        callback(typedError('vehicle_selection_required',
          'The selected vehicle is invalid.'));
        return;
      }
      self._selectedVin = vin;
      self._selectedVehicle = selected;
      storageSet(self._storage, SELECTED_VIN_KEY, vin);
      callback(null, vin, selected);
    });
  };

  RealClient.prototype._cacheBundle = function (vin, bundle) {
    this._latestBundle = {
      vin: vin,
      bundle: bundle,
      cachedAt: nowMs(this._clock)
    };
  };

  RealClient.prototype._cachedBundle = function (vin) {
    if (!this._latestBundle || this._latestBundle.vin !== vin) return null;
    if (nowMs(this._clock) - this._latestBundle.cachedAt > BUNDLE_REUSE_MS) {
      return null;
    }
    return this._latestBundle.bundle;
  };

  RealClient.prototype._readError = function (vin, code, message, cause, callback) {
    var cached = this._cachedBundle(vin);
    if (cached) {
      // Serving cached data is a reason to label it stale, not a reason to
      // refuse commands: the cache is at most BUNDLE_REUSE_MS old, and the
      // motion assessment in it was made from the same signals we would use
      // now.
      cached.cached = true;
      callback(null, cached);
      return;
    }
    callback(normalizedReadError(cause, code, message));
  };

  // Reuse a very recent bundle rather than re-reading everything.
  //
  // A single button press used to trigger five full reads -- the bridge's gate
  // check, sendCommand's own gate check, then the same again around the
  // confirmation -- each one a status call, a position call and a fresh GPS
  // acquisition. Within BUNDLE_REUSE_MS none of those can have changed
  // meaningfully, and the motion assessment in the cached bundle was made from
  // the same signals a new one would use.
  //
  // force:true skips the cache, for the read taken AFTER a VHS where the whole
  // point is to see what changed.
  RealClient.prototype.getBundle = function (callback, force) {
    var self = this;
    if (!force && this._latestBundle) {
      var reusable = this._cachedBundle(this._latestBundle.vin);
      if (reusable) {
        callback(null, reusable);
        return;
      }
    }
    this._selectVehicle(function (selectErr, vin, vehicle) {
      if (selectErr) { callback(selectErr); return; }
      self._raw.getStatus(vin, function (statusErr, status) {
        if (statusErr) {
          self._readError(vin, 'STATUS_FAILED', 'Could not read vehicle status.',
            statusErr, callback);
          return;
        }
        self._raw.getCapabilities(vin, function (capsErr, caps) {
          if (capsErr) {
            self._readError(vin, 'CAPABILITIES_FAILED',
              'Could not read vehicle capabilities.', capsErr, callback);
            return;
          }
          self._raw.getPosition(vin, function (positionErr, position) {
            if (positionErr) {
              self._readError(vin, 'POSITION_FAILED',
                'Could not read vehicle position.', positionErr, callback);
              return;
            }
            phoneReading(self._geolocation, self._timers, nowMs(self._clock), self._clock,
              function (phoneErr, phone) {
              // A missing or speed-less phone fix no longer blocks anything.
              // motionState only reports motion on POSITIVE evidence, so an
              // unreadable phone simply leaves the car's own speed as the only
              // signal. Previously this branch forced moving=true and locked
              // the user out of a parked car whenever GPS was unavailable.
              var motion = self._jlr.motionState(status, position, phone);
              motion.speedVerified = !!(phone && isNumber(phone.speed));
              if (!motion.speedVerified) {
                motion.reasons = (motion.reasons || []).concat(
                  ['phone speed unavailable (not treated as motion)']);
              }
              var bundle = {
                vin: vin,
                status: status || {},
                caps: caps || {},
                motion: motion,
                phone: phone || null,
                position: position || {},
                vehicleType: (caps && caps.vehicleType) ||
                  (vehicle && vehicle.vehicleType) || null,
                modelYear: (caps && caps.modelYear) ||
                  (vehicle && vehicle.modelYear) || null,
                cachedAt: nowMs(self._clock)
              };
              self._cacheBundle(vin, bundle);
              callback(null, bundle);
            });
          });
        });
      });
    });
  };

  RealClient.prototype.getPosition = function (callback) {
    var self = this;
    this._selectVehicle(function (selectErr, vin) {
      if (selectErr) { callback(selectErr); return; }
      var cached = self._cachedBundle(vin);
      if (cached && cached.phone && cached.position) {
        callback(null, self._positionResult(cached.status, cached.position,
          cached.phone));
        return;
      }
      self._raw.getStatus(vin, function (statusErr, status) {
        if (statusErr) {
          callback(typedError('STATUS_FAILED', 'Could not read vehicle status.', statusErr));
          return;
        }
        self._raw.getPosition(vin, function (positionErr, car) {
          if (positionErr) {
            callback(typedError('POSITION_FAILED', 'Could not read vehicle position.',
              positionErr));
            return;
          }
          if (!car || !isNumber(car.latitude) || !isNumber(car.longitude)) {
            callback(null, self._positionResult(status, car, null));
            return;
          }
          phoneReading(self._geolocation, self._timers, nowMs(self._clock), self._clock,
            function (phoneErr, phone) {
            if (phoneErr) { callback(phoneErr); return; }
            callback(null, self._positionResult(status, car, phone));
          });
        });
      });
    });
  };

  RealClient.prototype._positionResult = function (status, car, phone) {
    var days = parseInt(status && status.TU_STATUS_DAYS_SINCE_GNSS_FIX, 10);
    if (isNaN(days)) days = -1;
    if (!car || !isNumber(car.latitude) || !isNumber(car.longitude) ||
        !phone || !isNumber(phone.latitude) || !isNumber(phone.longitude)) {
      return {
        hasFix: false,
        distanceM: 0,
        bearingDeg: 0,
        quality: car && car.positionQuality || 'UNKNOWN',
        ageSec: -1,
        daysSinceFix: days,
        stale: true
      };
    }
    var carPoint = { latitude: car.latitude, longitude: car.longitude };
    var phonePoint = { latitude: phone.latitude, longitude: phone.longitude };
    var timestamp = parseTimestamp(car.timestamp);
    var ageSec = timestamp === null ? -1 :
      Math.max(0, Math.round((nowMs(this._clock) - timestamp) / 1000));
    var distance = Math.round(distanceM(phonePoint, carPoint));
    return {
      hasFix: true,
      distanceM: distance,
      bearingDeg: distance === 0 ? 0 :
        Math.round(bearingDeg(phonePoint, carPoint)) % 360,
      quality: car.positionQuality || 'UNKNOWN',
      ageSec: ageSec,
      daysSinceFix: days,
      stale: ageSec < 0 || ageSec > 900
    };
  };

  RealClient.prototype.sendCommand = function (serviceCode, callback, climateTempC) {
    var self = this;
    this.getBundle(function (bundleErr, bundle) {
      if (bundleErr) { callback(bundleErr); return; }
      if (!bundle.motion || !bundle.motion.commandsAllowed) {
        callback(typedError('motion_unknown',
          'Cannot confirm that the vehicle is stationary.'));
        return;
      }
      if (!bundle.caps || bundle.caps[serviceCode] !== 'available') {
        callback(typedError('capability_unavailable',
          'Service ' + serviceCode + ' is not available.'));
        return;
      }
      var pin = serviceCode === 'VHS' ? '' :
        (self._pin !== undefined ? self._pin : storageGet(self._storage, PIN_KEY));
      if (serviceCode !== 'VHS' && (pin === null || pin === undefined || pin === '')) {
        callback(typedError('pin_required', 'A PIN is required for this command.'));
        return;
      }
      function onResult(err, result) {
        if (err) {
          callback(err);
          return;
        }
        if (!result || (result.outcome !== 'success' &&
            result.outcome !== 'declined' && result.outcome !== 'pending')) {
          callback(typedError('INVALID_COMMAND_RESULT',
            'The command returned an unknown outcome.'));
          return;
        }
        callback(null, result);
      }

      // REON is remote CLIMATE on an ICE car, so it carries the target
      // temperature; everything else is a plain command.
      if (serviceCode === 'REON' &&
          typeof self._raw.remoteEngineStart === 'function') {
        var target = isNumber(climateTempC) ? climateTempC : self.climateTargetC();
        self._raw.remoteEngineStart(bundle.vin, pin, target, onResult);
        return;
      }
      self._raw.sendCommand(bundle.vin, serviceCode, pin, null, onResult);
    });
  };

  // Target cabin temperature in Celsius for remote start. Stored as a phone
  // preference; falls back to a sane default rather than refusing to start.
  RealClient.prototype.climateTargetC = function () {
    if (isNumber(this._climateTempC)) return this._climateTempC;
    var raw = storageGet(this._storage, CLIMATE_TEMP_KEY);
    var parsed = raw === null ? NaN : parseFloat(raw);
    return isNumber(parsed) ? parsed : CLIMATE_TEMP_DEFAULT_C;
  };

  var Real = {
    RealClient: RealClient,
    Error: typedError,
    distanceM: distanceM,
    bearingDeg: bearingDeg
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Real;
  } else {
    this.JLRReal = Real;
  }
}).call(this);
