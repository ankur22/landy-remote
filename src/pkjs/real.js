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
  // Whole operation: initial fix + two intervals + two settled fixes.
  var PHONE_READING_BUDGET_MS = 35000;
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

  function phoneReading(geolocation, timers, currentTime, clock, callback) {
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

    function getFix(onFix, onFail) {
      try {
        geolocation.getCurrentPosition(onFix, onFail, {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: PHONE_FIX_TIMEOUT_MS
        });
      } catch (err) {
        if (settled) throw err;
        onFail(err);
      }
    }

    function failure(err) {
      finish(typedError('motion_unknown', 'Phone location could not be read.', err));
    }

    // ---- second stage: derive speed from displacement between two fixes ----
    //
    // Reached only when the OS declines to report a speed. iOS returns
    // coords.speed = -1 whenever Core Location has no valid speed measurement,
    // and that is the NORMAL case when the phone is sitting still -- which is
    // precisely when someone wants to use this app. Treating it as
    // motion-unknown made the app permanently unusable next to a parked car
    // (observed on a real iPhone, 2026-07-28).
    //
    // We do NOT solve that by assuming -1 means stationary. That would be an
    // assumption about an OS implementation detail on the one code path that
    // must never be wrong, and -1 also occurs on a cold first fix while
    // genuinely moving. Instead we measure it ourselves: take a second fix a
    // few seconds later and derive speed from the displacement. That keeps the
    // rule intact -- the gate still opens only on positive evidence of being
    // stationary, just evidence we computed rather than evidence we were given.
    // Takes TWO further fixes and measures between those, deliberately
    // discarding the fix that got us here. getCurrentPosition typically
    // answers the first call from a coarse network/cell source and only
    // switches to GPS once it has settled; measuring from that first fix
    // reports the jump between sources as movement (10,495 km/h, seen on real
    // hardware). Ignoring it costs one extra interval and removes the whole
    // class of error.
    function deriveFromFurtherFixes() {
      timers.setTimeout(function () {
        if (settled) return;
        getFix(function (fixA) {
          var aNow = nowMsLocal();
          var aReason = checkFix(fixA, aNow, aNow);
          if (aReason) {
            finish(typedError('motion_unknown',
              'Phone speed is unavailable: settling fix rejected (' + aReason + ')'));
            return;
          }
          var firstTs = fixTimeMs(fixA, aNow).ms;
          var first = fixA.coords;
          timers.setTimeout(function () {
            if (settled) return;
            getFix(function (second) {
          var secondNow = nowMsLocal();
          var reason = checkFix(second, secondNow, secondNow);
          if (reason) {
            finish(typedError('motion_unknown',
              'Phone speed is unavailable: second fix rejected (' + reason + ')'));
            return;
          }
          var c1 = first, c2 = second.coords;
          var secondTs = fixTimeMs(second, secondNow).ms;
          var dtMs = secondTs - firstTs;
          if (!isNumber(dtMs) || dtMs <= 0) {
            // No usable elapsed time from the fixes themselves -- happens when
            // BOTH fall back to receipt time on a platform that sends no
            // timestamps. We still know how long we waited, because we chose
            // the interval, so use that rather than refusing. Failing here
            // would strand exactly the devices the fallback exists to support.
            dtMs = DERIVE_INTERVAL_MS;
          }
          var moved = distanceM(c1, c2);
          // Accuracy-aware noise floor: two stationary fixes still wander by
          // roughly their combined reported accuracy, so anything inside that
          // is indistinguishable from standing still.
          var acc1 = isNumber(c1.accuracy) ? c1.accuracy : DERIVE_ASSUMED_ACCURACY_M;
          var acc2 = isNumber(c2.accuracy) ? c2.accuracy : DERIVE_ASSUMED_ACCURACY_M;
          if (acc1 > DERIVE_MAX_ACCURACY_M || acc2 > DERIVE_MAX_ACCURACY_M) {
            finish(typedError('motion_unknown',
              'Phone speed is unavailable: fix too imprecise to derive speed (' +
              Math.round(Math.max(acc1, acc2)) + 'm)'));
            return;
          }
          var noiseFloorM = Math.max(DERIVE_MIN_NOISE_M, acc1 + acc2);
          var derived = moved <= noiseFloorM ? 0 : (moved / (dtMs / 1000));

          // Diagnostics for a path only observable on real hardware. No
          // coordinates -- just the derived quantities.
          var diag = 'moved=' + Math.round(moved) + 'm dt=' + dtMs +
            'ms acc1=' + (isNumber(c1.accuracy) ? Math.round(c1.accuracy) : 'absent') +
            ' acc2=' + (isNumber(c2.accuracy) ? Math.round(c2.accuracy) : 'absent') +
            ' derived=' + Math.round(derived * 3.6) + 'km/h';

          // A car cannot do this. A derived figure above it means the two fixes
          // came from DIFFERENT SOURCES -- typically a coarse network/cell fix
          // first, then GPS once it settles -- so the "displacement" is the
          // jump between sources, not movement. Observed on real hardware:
          // 10,495 km/h. Reporting that as speed would be false, and reporting
          // it as "moving" would be false for the same reason, so this is
          // unknown: we genuinely cannot tell, and unknown fails closed.
          if (derived > DERIVE_IMPLAUSIBLE_MS) {
            finish(typedError('motion_unknown',
              'Phone speed is unavailable: fixes inconsistent, likely still ' +
              'acquiring GPS (' + diag + ')'));
            return;
          }
          finish(null, {
            diag: diag,
            latitude: c2.latitude,
            longitude: c2.longitude,
            speed: derived,
            timestamp: secondTs,
            units: 'ms',
            derived: true
          });
            }, failure);
          }, DERIVE_INTERVAL_MS);
        }, failure);
      }, DERIVE_INTERVAL_MS);
    }

    function nowMsLocal() {
      // currentTime was sampled by the caller before the first fix; the second
      // fix arrives seconds later, so re-sample rather than ageing it out
      // falsely. Uses the INJECTED clock -- reaching for Date directly here
      // would make the second fix look impossibly stale under a fixed test
      // clock, and silently diverge from the clock everything else uses.
      return nowMs(clock);
    }

    function success(position) {
      var receiptNow = nowMs(clock);
      var reason = checkFix(position, currentTime, receiptNow);
      if (reason) {
        // Deliberately never logs latitude/longitude -- only whether they were
        // present -- so diagnostics cannot leak a location.
        finish(typedError('motion_unknown', 'Phone speed is unavailable: ' + reason));
        return;
      }
      var coords = position.coords;
      if (isNumber(coords.speed) && coords.speed >= 0) {
        finish(null, {                       // fast path: the OS told us
          latitude: coords.latitude,
          longitude: coords.longitude,
          speed: coords.speed,
          timestamp: fixTimeMs(position, receiptNow).ms,
          units: 'ms'
        });
        return;
      }
      deriveFromFurtherFixes();
    }

    // Overall budget covers both fixes plus the interval between them.
    timerId = timers.setTimeout(function () {
      finish(typedError('motion_unknown', 'Phone location timed out.'));
    }, PHONE_READING_BUDGET_MS);

    getFix(success, failure);
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
            phoneReading(self._geolocation, self._timers, nowMs(self._clock), self._clock,
              function (phoneErr, phone) {
              var motion = self._jlr.motionState(status, position, phone);
              if (phoneErr) {
                // Carry the actual cause through. Collapsing every phone-read
                // failure to a fixed string makes a denied permission, a
                // timeout, a stale fix and a missing speed field all look
                // identical in the log -- and they need completely different
                // fixes. phoneErr.message already names which check failed.
                motion = unsafeMotion(
                  'live motion unknown: ' +
                    ((phoneErr && phoneErr.message) || 'no detail'),
                  motion);
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
