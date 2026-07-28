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
  var PHONE_FIX_MAX_AGE_MS = 10000;
  // A GPS fix timestamp does not come from the same clock as Date.now() -- iOS
  // stamps it from the location subsystem -- so a fresh fix can legitimately
  // read a few milliseconds INTO THE FUTURE relative to our clock. Rejecting
  // every negative age would then intermittently report motion_unknown and
  // strand the user on "Checking safety" with all controls dead, for no real
  // reason. Tolerate small skew; still reject fixes dated meaningfully ahead,
  // which would indicate a genuinely untrustworthy clock.
  var PHONE_FIX_MAX_SKEW_MS = 2000;
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

  function unsafeMotion(reason, base) {
    var reasons = (base && base.reasons) ? base.reasons.slice(0) : [];
    reasons.push(reason);
    return {
      moving: true,
      commandsAllowed: false,
      reasons: reasons,
      statusAgeSeconds: base ? base.statusAgeSeconds : null,
      unknown: true
    };
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

  function phoneReading(geolocation, timers, currentTime, callback) {
    if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
      callback(typedError('motion_unknown', 'Phone location is unavailable.'));
      return;
    }
    var settled = false;
    var timerId = null;
    function finish(err, value) {
      if (settled) return;
      settled = true;
      if (timerId !== null && timers && typeof timers.clearTimeout === 'function') {
        timers.clearTimeout(timerId);
      }
      callback(err, value);
    }
    function success(position) {
      var coords = position && position.coords;
      var timestamp = position && position.timestamp;
      var age = isNumber(timestamp) ? currentTime - timestamp : null;
      if (!coords || !isNumber(coords.latitude) || !isNumber(coords.longitude) ||
          !isNumber(coords.speed) || coords.speed < 0 ||
          age === null || age < -PHONE_FIX_MAX_SKEW_MS ||
          age > PHONE_FIX_MAX_AGE_MS) {
        finish(typedError('motion_unknown', 'Phone speed is unavailable.'));
        return;
      }
      finish(null, {
        latitude: coords.latitude,
        longitude: coords.longitude,
        speed: coords.speed,
        timestamp: timestamp,
        units: 'ms'
      });
    }
    function failure(err) {
      finish(typedError('motion_unknown', 'Phone location could not be read.', err));
    }
    timerId = timers.setTimeout(function () {
      finish(typedError('motion_unknown', 'Phone location timed out.'));
    }, 10000);
    try {
      geolocation.getCurrentPosition(success, failure, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
      });
    } catch (err2) {
      if (settled) throw err2;
      failure(err2);
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
      cached.cached = true;
      cached.motion = unsafeMotion('live motion unknown (cached data)', cached.motion);
      callback(null, cached);
      return;
    }
    callback(normalizedReadError(cause, code, message));
  };

  RealClient.prototype.getBundle = function (callback) {
    var self = this;
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
            phoneReading(self._geolocation, self._timers, nowMs(self._clock),
              function (phoneErr, phone) {
              var motion = self._jlr.motionState(status, position, phone);
              if (phoneErr) {
                motion = unsafeMotion('live motion unknown', motion);
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
          phoneReading(self._geolocation, self._timers, nowMs(self._clock),
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

  RealClient.prototype.sendCommand = function (serviceCode, callback) {
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
      self._raw.sendCommand(bundle.vin, serviceCode, pin, null, function (err, result) {
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
      });
    });
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
