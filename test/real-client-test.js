#!/usr/bin/env node
'use strict';

// Contract tests for the real adapter. Every dependency is injected: these
// tests cannot construct XMLHttpRequest or reach the JLR service.
var assert = require('assert');
var Real = require('../src/pkjs/real');
var packageJson = require('../package.json');

console.log('real-client tests: starting');

var tests = [];
var activeName = null;
function test(name, fn) { tests.push({ name: name, fn: fn }); }

process.on('beforeExit', function () {
  if (activeName) {
    console.error('[FAIL] ' + activeName + ' -- callback never completed');
    process.exitCode = 1;
  }
});

test('Pebble package declares phone location capability', function (done) {
  var capabilities = packageJson.pebble.capabilities || [];
  assert.notStrictEqual(capabilities.indexOf('location'), -1);
  done();
});

function memoryStorage(seed) {
  var values = seed || {};
  return {
    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    setItem: function (key, value) { values[key] = String(value); },
    removeItem: function (key) { delete values[key]; },
    values: values
  };
}

function fakeJlr() {
  return {
    motionState: function (status, position, phone) {
      var moving = (position && position.speed >= 5) ||
        (phone && phone.speed * 3.6 >= 5);
      return {
        moving: !!moving,
        commandsAllowed: !moving,
        reasons: moving ? ['moving'] : [],
        statusAgeSeconds: 10
      };
    }
  };
}

function baseDeps(overrides) {
  var calls = [];
  var raw = {
    getVehicles: function (cb) {
      calls.push('vehicles');
      cb(null, [
        { vin: 'VIN-ONE', vehicleType: 'Discovery', modelYear: 2018 },
        { vin: 'VIN-TWO', vehicleType: 'Defender', modelYear: 2022 }
      ]);
    },
    getStatus: function (vin, cb) {
      calls.push('status:' + vin);
      cb(null, {
        DOOR_IS_ALL_DOORS_LOCKED: 'TRUE',
        TU_STATUS_DAYS_SINCE_GNSS_FIX: '3'
      });
    },
    getCapabilities: function (vin, cb) {
      calls.push('caps:' + vin);
      cb(null, {
        RDL: 'available', RDU: 'available', HBLF: 'available',
        VHS: 'available', REON: 'available',
        vehicleType: 'Discovery', modelYear: 2018
      });
    },
    getPosition: function (vin, cb) {
      calls.push('position:' + vin);
      cb(null, {
        latitude: 51.5033, longitude: -0.1195, speed: 0,
        positionQuality: 'GOOD', timestamp: '2026-07-28T09:59:00Z'
      });
    },
    sendCommand: function (vin, service, pin, params, cb) {
      calls.push('command:' + vin + ':' + service + ':' + pin);
      cb(null, { outcome: 'declined', failureDescription: 'vehicleBusy' });
    }
  };
  var deps = {
    rawClient: raw,
    jlr: fakeJlr(),
    geolocation: {
      getCurrentPosition: function (ok, fail, options) {
        calls.push('geolocation');
        calls.push('geo-options:' + JSON.stringify(options));
        ok({
          timestamp: Date.parse('2026-07-28T10:00:00Z'),
          coords: { latitude: 51.5008, longitude: -0.1225, speed: 0 }
        });
      }
    },
    storage: memoryStorage({ jlr_selected_vin: 'VIN-TWO' }),
    clock: { now: function () { return Date.parse('2026-07-28T10:00:00Z'); } },
    timers: {
      setTimeout: function () { return 1; },
      clearTimeout: function () {}
    },
    pin: '1234'
  };
  overrides = overrides || {};
  Object.keys(overrides).forEach(function (key) { deps[key] = overrides[key]; });
  return { deps: deps, raw: raw, calls: calls };
}

test('getBundle selects the persisted vehicle and performs reads sequentially', function (done) {
  var setup = baseDeps();
  setup.deps.storage.setItem('jlr_selected_vin', 'VIN-TWO');
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err, bundle) {
    assert.ifError(err);
    assert.strictEqual(bundle.vin, 'VIN-TWO');
    assert.strictEqual(bundle.vehicleType, 'Discovery');
    assert.strictEqual(bundle.modelYear, 2018);
    assert.strictEqual(bundle.motion.moving, false);
    assert.deepStrictEqual(setup.calls, [
      'vehicles', 'status:VIN-TWO', 'caps:VIN-TWO',
      'position:VIN-TWO', 'geolocation',
      'geo-options:{"enableHighAccuracy":true,"maximumAge":0,"timeout":10000}'
    ]);
    assert.strictEqual(
      setup.deps.storage.getItem('jlr_real_bundle_VIN-TWO'),
      null,
      'phone/car coordinates and full bundle must not be persisted'
    );
    done();
  });
  if (setup.calls.length < 6) {
    throw new Error('getBundle stopped after calls: ' + JSON.stringify(setup.calls));
  }
});

test('getBundle fails closed when live phone motion is unknown', function (done) {
  var setup = baseDeps({
    geolocation: {
      getCurrentPosition: function (ok, fail) {
        setup.calls.push('geolocation');
        fail(new Error('permission denied'));
      }
    }
  });
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err, bundle) {
    assert.ifError(err);
    assert.strictEqual(bundle.motion.moving, true);
    assert.strictEqual(bundle.motion.commandsAllowed, false);
    assert.ok(bundle.motion.reasons.join(' ').indexOf('unknown') >= 0);
    done();
  });
});

test('getPosition derives distance, bearing, quality, age and GNSS age', function (done) {
  var setup = baseDeps();
  var client = new Real.RealClient(setup.deps);
  client.getPosition(function (err, position) {
    assert.ifError(err);
    assert.strictEqual(position.hasFix, true);
    assert.ok(position.distanceM > 300 && position.distanceM < 500);
    assert.ok(position.bearingDeg >= 0 && position.bearingDeg < 360);
    assert.strictEqual(position.quality, 'GOOD');
    assert.strictEqual(position.ageSec, 60);
    assert.strictEqual(position.daysSinceFix, 3);
    done();
  });
});

test('sendCommand blocks unavailable services with a typed error', function (done) {
  var setup = baseDeps();
  setup.raw.getCapabilities = function (vin, cb) {
    setup.calls.push('caps:' + vin);
    cb(null, { RDL: 'not_enabled', RDU: 'available', HBLF: 'available',
      VHS: 'available', REON: 'available' });
  };
  var client = new Real.RealClient(setup.deps);
  client.sendCommand('RDL', function (err) {
    assert(err);
    assert.strictEqual(err.code, 'capability_unavailable');
    assert.strictEqual(setup.calls.some(function (x) {
      return x.indexOf('command:') === 0;
    }), false);
    done();
  });
});

test('sendCommand blocks unknown motion and never reaches the raw command', function (done) {
  var setup = baseDeps({
    geolocation: {
      getCurrentPosition: function (ok, fail) { fail(new Error('unavailable')); }
    }
  });
  var client = new Real.RealClient(setup.deps);
  client.sendCommand('RDU', function (err) {
    assert(err);
    assert.strictEqual(err.code, 'motion_unknown');
    assert.strictEqual(setup.calls.some(function (x) {
      return x.indexOf('command:') === 0;
    }), false);
    done();
  });
});

test('sendCommand preserves success, declined and pending results unchanged', function (done) {
  var outcomes = [
    { outcome: 'success' },
    { outcome: 'declined', failureDescription: 'vehicleBusy' },
    { outcome: 'pending' }
  ];
  var setup = baseDeps();
  setup.raw.sendCommand = function (vin, service, pin, params, cb) {
    cb(null, outcomes.shift());
  };
  var client = new Real.RealClient(setup.deps);
  client.sendCommand('HBLF', function (err, first) {
    assert.ifError(err);
    assert.deepStrictEqual(first, { outcome: 'success' });
    client.sendCommand('HBLF', function (err2, second) {
      assert.ifError(err2);
      assert.deepStrictEqual(second, {
        outcome: 'declined', failureDescription: 'vehicleBusy'
      });
      client.sendCommand('HBLF', function (err3, third) {
        assert.ifError(err3);
        assert.deepStrictEqual(third, { outcome: 'pending' });
        done();
      });
    });
  });
});

test('no vehicles returns a distinct actionable error', function (done) {
  var setup = baseDeps();
  setup.raw.getVehicles = function (cb) { cb(null, []); };
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err) {
    assert(err);
    assert.strictEqual(err.code, 'no_vehicles');
    done();
  });
});

test('multiple vehicles without a configured VIN are blocked without persistence', function (done) {
  var setup = baseDeps({ storage: memoryStorage() });
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err) {
    assert(err);
    assert.strictEqual(err.code, 'vehicle_selection_required');
    assert.strictEqual(setup.deps.storage.getItem('jlr_selected_vin'), null);
    assert.deepStrictEqual(setup.calls, ['vehicles']);
    done();
  });
});

test('a configured VIN absent from the account is blocked', function (done) {
  var setup = baseDeps({ storage: memoryStorage({ jlr_selected_vin: 'VIN-MISSING' }) });
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err) {
    assert(err);
    assert.strictEqual(err.code, 'vehicle_selection_required');
    assert.deepStrictEqual(setup.calls, ['vehicles']);
    done();
  });
});

test('one account vehicle may be selected and persisted', function (done) {
  var setup = baseDeps({ storage: memoryStorage() });
  setup.raw.getVehicles = function (cb) {
    setup.calls.push('vehicles');
    cb(null, [{ vin: 'VIN-ONE' }]);
  };
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err, bundle) {
    assert.ifError(err);
    assert.strictEqual(bundle.vin, 'VIN-ONE');
    assert.strictEqual(setup.deps.storage.getItem('jlr_selected_vin'), 'VIN-ONE');
    done();
  });
});

test('missing raw-client configuration fails before any read', function (done) {
  var setup = baseDeps({ configured: false });
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err) {
    assert(err);
    assert.strictEqual(err.code, 'not_configured');
    assert.deepStrictEqual(setup.calls, []);
    done();
  });
});

test('expired authentication is normalized to auth_expired', function (done) {
  var setup = baseDeps();
  setup.raw.getVehicles = function (cb) {
    setup.calls.push('vehicles');
    cb(new Error('refresh token missing or rejected'));
  };
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err) {
    assert(err);
    assert.strictEqual(err.code, 'auth_expired');
    done();
  });
});

function geoBundle(name, geo, carSpeed, verify) {
  test(name, function (done) {
    var setup = baseDeps({ geolocation: geo });
    setup.raw.getPosition = function (vin, cb) {
      setup.calls.push('position:' + vin);
      cb(null, {
        latitude: 51.5033,
        longitude: -0.1195,
        speed: carSpeed,
        positionQuality: 'GOOD',
        timestamp: '2026-07-28T09:59:00Z'
      });
    };
    var client = new Real.RealClient(setup.deps);
    client.getBundle(function (err, bundle) {
      assert.ifError(err);
      verify(bundle, setup);
      done();
    });
  });
}

function geoPosition(speed, timestamp, latitude, longitude) {
  return {
    timestamp: timestamp === undefined ? Date.parse('2026-07-28T10:00:00Z') : timestamp,
    coords: {
      latitude: latitude === undefined ? 51.5008 : latitude,
      longitude: longitude === undefined ? -0.1225 : longitude,
      speed: speed
    }
  };
}

geoBundle('geolocation stationary proof permits commands', {
  getCurrentPosition: function (ok) { ok(geoPosition(0)); }
}, undefined, function (bundle) {
  assert.strictEqual(bundle.motion.moving, false);
  assert.strictEqual(bundle.motion.commandsAllowed, true);
});

geoBundle('geolocation moving proof blocks', {
  getCurrentPosition: function (ok) { ok(geoPosition(2)); }
}, 0, function (bundle) {
  assert.strictEqual(bundle.motion.moving, true);
  assert.strictEqual(bundle.motion.commandsAllowed, false);
});

geoBundle('geolocation exact 5 km/h threshold blocks', {
  getCurrentPosition: function (ok) { ok(geoPosition(5 / 3.6)); }
}, 0, function (bundle) {
  assert.strictEqual(bundle.motion.moving, true);
  assert.strictEqual(bundle.motion.commandsAllowed, false);
});

geoBundle('geolocation unavailable fails closed', {
  getCurrentPosition: function (ok, fail) { fail(new Error('unavailable')); }
}, 0, function (bundle) {
  assert.strictEqual(bundle.motion.unknown, true);
});

geoBundle('geolocation absent fails closed', null, 0, function (bundle) {
  assert.strictEqual(bundle.motion.unknown, true);
});

geoBundle('geolocation malformed coordinates fail closed', {
  getCurrentPosition: function (ok) { ok(geoPosition(0, undefined, Infinity, 0)); }
}, 0, function (bundle) {
  assert.strictEqual(bundle.motion.unknown, true);
});

geoBundle('geolocation stale timestamp fails closed', {
  getCurrentPosition: function (ok) {
    ok(geoPosition(0, Date.parse('2026-07-28T09:59:49Z')));
  }
}, 0, function (bundle) {
  assert.strictEqual(bundle.motion.unknown, true);
});

geoBundle('geolocation null speed fails closed', {
  getCurrentPosition: function (ok) { ok(geoPosition(null)); }
}, 0, function (bundle) {
  assert.strictEqual(bundle.motion.unknown, true);
});

test('geolocation callback-never path uses injected timeout', function (done) {
  var timeoutFn = null;
  var setup = baseDeps({
    geolocation: { getCurrentPosition: function () {} },
    timers: {
      setTimeout: function (fn, delay) {
        assert.strictEqual(delay, 10000);
        timeoutFn = fn;
        return 7;
      },
      clearTimeout: function () {}
    }
  });
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err, bundle) {
    assert.ifError(err);
    assert.strictEqual(bundle.motion.unknown, true);
    done();
  });
  assert(timeoutFn);
  timeoutFn();
});

test('late geolocation callback after timeout is ignored', function (done) {
  var timeoutFn = null;
  var lateOk = null;
  var callbackCount = 0;
  var setup = baseDeps({
    geolocation: {
      getCurrentPosition: function (ok) { lateOk = ok; }
    },
    timers: {
      setTimeout: function (fn) { timeoutFn = fn; return 8; },
      clearTimeout: function () {}
    }
  });
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err, bundle) {
    callbackCount++;
    assert.ifError(err);
    assert.strictEqual(bundle.motion.unknown, true);
  });
  timeoutFn();
  lateOk(geoPosition(0));
  assert.strictEqual(callbackCount, 1);
  done();
});

test('getPosition reuses an immediately recent safe bundle without duplicate reads', function (done) {
  var setup = baseDeps();
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err) {
    assert.ifError(err);
    var before = setup.calls.slice(0);
    client.getPosition(function (positionErr, position) {
      assert.ifError(positionErr);
      assert.strictEqual(position.hasFix, true);
      assert.deepStrictEqual(setup.calls, before);
      done();
    });
  });
});

test('find-car equal positions return zero distance and a stable bearing', function (done) {
  var setup = baseDeps({
    geolocation: {
      getCurrentPosition: function (ok) {
        ok(geoPosition(0, undefined, 51.5033, -0.1195));
      }
    }
  });
  var client = new Real.RealClient(setup.deps);
  client.getPosition(function (err, position) {
    assert.ifError(err);
    assert.strictEqual(position.distanceM, 0);
    assert.strictEqual(position.bearingDeg, 0);
    done();
  });
});

test('find-car missing or invalid car fix returns hasFix false', function (done) {
  var values = [{}, { latitude: Infinity, longitude: -0.1 }];
  function runNext() {
    if (!values.length) { done(); return; }
    var setup = baseDeps();
    setup.raw.getPosition = function (vin, cb) { cb(null, values.shift()); };
    new Real.RealClient(setup.deps).getPosition(function (err, position) {
      assert.ifError(err);
      assert.strictEqual(position.hasFix, false);
      runNext();
    });
  }
  runNext();
});

test('find-car preserves poor quality and identifies stale fixes', function (done) {
  var setup = baseDeps();
  setup.raw.getPosition = function (vin, cb) {
    cb(null, {
      latitude: 51.5033, longitude: -0.1195, speed: 0,
      positionQuality: 'POOR', timestamp: '2026-07-28T09:00:00Z'
    });
  };
  var client = new Real.RealClient(setup.deps);
  client.getPosition(function (err, position) {
    assert.ifError(err);
    assert.strictEqual(position.quality, 'POOR');
    assert.strictEqual(position.ageSec, 3600);
    assert.strictEqual(position.stale, true);
    done();
  });
});

test('all supported services are blocked for unknown phone motion', function (done) {
  var services = ['RDL', 'RDU', 'HBLF', 'VHS', 'REON'];
  function runNext() {
    if (!services.length) { done(); return; }
    var service = services.shift();
    var setup = baseDeps({
      geolocation: {
        getCurrentPosition: function (ok, fail) { fail(new Error('denied')); }
      }
    });
    new Real.RealClient(setup.deps).sendCommand(service, function (err) {
      assert(err);
      assert.strictEqual(err.code, 'motion_unknown');
      assert.strictEqual(setup.calls.some(function (x) {
        return x.indexOf('command:') === 0;
      }), false);
      runNext();
    });
  }
  runNext();
});

test('all supported services are blocked for phone or car movement', function (done) {
  var scenarios = [
    { phone: 2, car: 0 },
    { phone: 0, car: 5 }
  ];
  function nextScenario() {
    if (!scenarios.length) { done(); return; }
    var scenario = scenarios.shift();
    var setup = baseDeps({
      geolocation: {
        getCurrentPosition: function (ok) { ok(geoPosition(scenario.phone)); }
      }
    });
    setup.raw.getPosition = function (vin, cb) {
      cb(null, {
        latitude: 1, longitude: 1, speed: scenario.car,
        timestamp: '2026-07-28T10:00:00Z'
      });
    };
    var services = ['RDL', 'RDU', 'HBLF', 'VHS', 'REON'];
    function nextService() {
      if (!services.length) { nextScenario(); return; }
      var service = services.shift();
      new Real.RealClient(setup.deps).sendCommand(service, function (err) {
        assert(err);
        assert.strictEqual(err.code, 'motion_unknown');
        assert.strictEqual(setup.calls.some(function (x) {
          return x.indexOf('command:') === 0;
        }), false);
        nextService();
      });
    }
    nextService();
  }
  nextScenario();
});

test('expired stationary proof is not reused for a command', function (done) {
  var current = Date.parse('2026-07-28T10:00:00Z');
  var geoCalls = 0;
  var setup = baseDeps({
    clock: { now: function () { return current; } },
    geolocation: {
      getCurrentPosition: function (ok, fail) {
        geoCalls++;
        if (geoCalls === 1) ok(geoPosition(0, current));
        else fail(new Error('expired proof cannot refresh'));
      }
    }
  });
  var client = new Real.RealClient(setup.deps);
  client.getBundle(function (err) {
    assert.ifError(err);
    current += 10001;
    client.sendCommand('RDL', function (commandErr) {
      assert(commandErr);
      assert.strictEqual(commandErr.code, 'motion_unknown');
      assert.strictEqual(geoCalls, 2);
      assert.strictEqual(setup.calls.some(function (x) {
        return x.indexOf('command:') === 0;
      }), false);
      done();
    });
  });
});

test('PIN is required except VHS, which forwards an empty PIN', function (done) {
  var withoutPin = baseDeps({ pin: undefined });
  delete withoutPin.deps.pin;
  new Real.RealClient(withoutPin.deps).sendCommand('RDL', function (err) {
    assert(err);
    assert.strictEqual(err.code, 'pin_required');
    assert.strictEqual(withoutPin.calls.some(function (x) {
      return x.indexOf('command:') === 0;
    }), false);

    var refresh = baseDeps({ pin: undefined });
    delete refresh.deps.pin;
    new Real.RealClient(refresh.deps).sendCommand('VHS', function (refreshErr) {
      assert.ifError(refreshErr);
      assert.ok(refresh.calls.indexOf('command:VIN-TWO:VHS:') >= 0);
      done();
    });
  });
});

test('command forwards the exact selected VIN and PIN', function (done) {
  var setup = baseDeps({ pin: '9876' });
  var client = new Real.RealClient(setup.deps);
  client.sendCommand('HBLF', function (err) {
    assert.ifError(err);
    assert.ok(setup.calls.indexOf('command:VIN-TWO:HBLF:9876') >= 0);
    done();
  });
});

test('command preserves hard errors and all three outcome payloads', function (done) {
  var hard = new Error('hard transport failure');
  var sequence = [
    { err: hard },
    { result: { outcome: 'success', marker: 1 } },
    { result: { outcome: 'declined', failureReason: 'no', marker: 2 } },
    { result: { outcome: 'pending', marker: 3 } }
  ];
  var setup = baseDeps();
  setup.raw.sendCommand = function (vin, service, pin, params, cb) {
    var next = sequence.shift();
    cb(next.err || null, next.result);
  };
  var client = new Real.RealClient(setup.deps);
  client.sendCommand('HBLF', function (err) {
    assert.strictEqual(err, hard);
    client.sendCommand('HBLF', function (err2, success) {
      assert.ifError(err2);
      assert.deepStrictEqual(success, { outcome: 'success', marker: 1 });
      client.sendCommand('HBLF', function (err3, declined) {
        assert.ifError(err3);
        assert.deepStrictEqual(declined, {
          outcome: 'declined', failureReason: 'no', marker: 2
        });
        client.sendCommand('HBLF', function (err4, pending) {
          assert.ifError(err4);
          assert.deepStrictEqual(pending, { outcome: 'pending', marker: 3 });
          done();
        });
      });
    });
  });
});

var passed = 0;
function next() {
  if (!tests.length) {
    console.log('\n' + passed + ' passed, 0 failed');
    return;
  }
  var current = tests.shift();
  console.log('[RUN] ' + current.name);
  activeName = current.name;
  var finished = false;
  function done(err) {
    if (finished) return;
    finished = true;
    if (err) {
      console.error('[FAIL] ' + current.name + ' -- ' + (err.stack || err));
      process.exit(1);
      return;
    }
    activeName = null;
    passed++;
    console.log('[PASS] ' + current.name);
    next();
  }
  try {
    current.fn(done);
  } catch (err) {
    done(err);
  }
}
next();
