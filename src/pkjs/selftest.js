// selftest.js -- in-emulator pure-logic checks for jlr.js, carried over from
// milestone 2's index.js verbatim (moved out of the entry point now that
// index.js's job has grown to include the AppMessage bridge). Run once on
// 'ready'; see README "In-emulator self-test".
var JLR = require('./jlr');

function assertEqual(actual, expected, label, results) {
  var ok = (JSON.stringify(actual) === JSON.stringify(expected));
  results.push({ label: label, ok: ok, actual: actual, expected: expected });
  return ok;
}

function selfTestFlattenStatus(results) {
  var fixture = {
    vehicleStatus: {
      coreStatus: [
        { key: 'DOOR_IS_ALL_DOORS_LOCKED', value: 'TRUE', lastUpdatedTime: '2026-07-27T08:00:00Z' },
        { key: 'FUEL_LEVEL_PERC', value: '90', lastUpdatedTime: '2026-07-27T09:15:00Z' },
        { key: 'ODOMETER_MILES', value: '53516', lastUpdatedTime: '2026-07-27T07:00:00Z' }
      ],
      evStatus: []
    }
  };
  var flat = JLR.flattenStatus(fixture);
  assertEqual(flat.DOOR_IS_ALL_DOORS_LOCKED, 'TRUE', 'flattenStatus: core key present', results);
  assertEqual(flat.LAST_UPDATED_TIME, '2026-07-27T09:15:00Z', 'flattenStatus: synthesises newest per-item timestamp', results);

  var fixtureWithStaleTop = {
    vehicleStatus: {
      coreStatus: [
        { key: 'LAST_UPDATED_TIME', value: '2026-07-27T06:00:00Z' },
        { key: 'FUEL_LEVEL_PERC', value: '88', lastUpdatedTime: '2026-07-27T10:30:00Z' }
      ],
      evStatus: []
    }
  };
  var flat2 = JLR.flattenStatus(fixtureWithStaleTop);
  assertEqual(flat2.LAST_UPDATED_TIME, '2026-07-27T10:30:00Z', 'flattenStatus: fresher per-item timestamp overrides stale top-level key', results);
}

function selfTestServiceState(results) {
  var fullAttrs = {
    availableServices: [
      { serviceType: 'RDL', vehicleCapable: true, serviceEnabled: true },
      { serviceType: 'RDU', vehicleCapable: true, serviceEnabled: true },
      { serviceType: 'HBLF', vehicleCapable: true, serviceEnabled: true },
      { serviceType: 'VHS', vehicleCapable: true, serviceEnabled: true }
    ]
  };
  assertEqual(JLR.serviceState(fullAttrs, 'RDL'), 'available', 'serviceState: RDL available on full account', results);

  var protectOnlyAttrs = {
    availableServices: [
      { serviceType: 'BCALL', vehicleCapable: true, serviceEnabled: true },
      { serviceType: 'ECALL', vehicleCapable: true, serviceEnabled: true },
      { serviceType: 'JL', vehicleCapable: true, serviceEnabled: true },
      { serviceType: 'VHS', vehicleCapable: true, serviceEnabled: true }
    ]
  };
  assertEqual(JLR.serviceState(protectOnlyAttrs, 'RDL'), 'not_capable', 'serviceState: RDL hidden on Protect-only account', results);

  var disabledAttrs = {
    availableServices: [
      { serviceType: 'RDL', vehicleCapable: true, serviceEnabled: false }
    ]
  };
  assertEqual(JLR.serviceState(disabledAttrs, 'RDL'), 'not_enabled', 'serviceState: RDL greyed out when serviceEnabled=false', results);

  var missingListAttrs = {};
  assertEqual(JLR.serviceState(missingListAttrs, 'RDL'), 'unknown', 'serviceState: fail-open when availableServices absent entirely', results);
}

function selfTestMaskVin(results) {
  assertEqual(JLR.maskVin('SALGA2FE8JA123456'), 'SALGA…3456', 'maskVin: masks middle of a real-length VIN', results);
  assertEqual(JLR.maskVin('short'), '<vin>', 'maskVin: refuses to pass through anything too short to be a VIN', results);
}

function selfTestMotionState(results) {
  var status = { VEHICLE_STATE_TYPE: 'KEY_ON_ENGINE_OFF', LAST_UPDATED_TIME: new Date().toISOString() };
  var stillPosition = { speed: 0, units: 'kmh' };
  var stillPhone = { speed: 0, units: 'ms' };
  assertEqual(JLR.motionState(status, stillPosition, stillPhone).moving, false,
    'motionState: parked car + stationary phone -> not moving', results);

  var movingPhone = { speed: 8, units: 'ms' }; // ~29 km/h, above the 5 km/h threshold
  assertEqual(JLR.motionState(status, stillPosition, movingPhone).moving, true,
    'motionState: fast phone alone is enough to trigger lockout', results);

  var movingCarPosition = { speed: 40, units: 'kmh' };
  assertEqual(JLR.motionState(status, movingCarPosition, stillPhone).moving, true,
    'motionState: fast car speed alone is enough, even with a stationary phone', results);

  assertEqual(JLR.displaySafeStatus(status, { moving: true }), { IN_MOTION: true },
    'displaySafeStatus: moving collapses to IN_MOTION only', results);
}

function runSelfTests() {
  var results = [];
  selfTestFlattenStatus(results);
  selfTestServiceState(results);
  selfTestMaskVin(results);
  selfTestMotionState(results);

  var passed = 0;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (r.ok) {
      passed++;
      console.log('JLR: [PASS] ' + r.label);
    } else {
      console.log('JLR: [FAIL] ' + r.label + ' -- expected ' + JSON.stringify(r.expected) + ' got ' + JSON.stringify(r.actual));
    }
  }
  console.log('JLR: self-test summary: ' + passed + '/' + results.length + ' passed');
}

module.exports = { runSelfTests: runSelfTests };
