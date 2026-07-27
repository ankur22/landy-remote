// mock.js -- fixtures + a mock JLR client for milestone 3 (on-watch UI).
//
// Milestone 3 is explicitly built and verified against MOCK data only -- see
// jlr-remote-research.md's build plan and the milestone 3 brief. Real
// backend wiring is milestone 4. This file is the "flag or build-time
// switch" the brief asks for: index.js imports either this module or the
// real src/pkjs/jlr.js based on the USE_MOCK constant at the top of
// index.js. Nothing in here ever touches the network.
//
// Fixture shapes are deliberately the real shapes recorded in
// jlr-remote-research.md / jlr-vehicle-capabilities.md from the live probe
// against Ankur's 2018 Land Rover Discovery (2026-07-27):
//   - status items are {key, value} pairs only -- no per-item
//     lastUpdatedTime on this car -- and LAST_UPDATED_TIME is synthesised
//     from the payload's own top-level lastUpdatedTime (tier 3 in
//     jlr.js::flattenStatus).
//   - availableServices carries {serviceType, vehicleCapable,
//     serviceEnabled} triples.
//   - position carries {latitude, longitude, heading, speed,
//     positionQuality, timestamp} plus TU_STATUS_DAYS_SINCE_GNSS_FIX=3 in
//     status, both flagged in the research doc as things find-my-car must
//     surface rather than hide.
//
// Three build-time switches, exactly per the brief ("a flag or build-time
// switch in pkjs that serves fixtures"). Flip, `pebble build`, reinstall,
// screenshot, flip back -- see README "Toggling mock scenarios".
var MOCK_MOVING = false;        // true -> phone GPS speed high -> in-motion lockdout
var MOCK_LIMITED_CAPS = false;  // true -> Protect-only account (msp1974#13): no RDL/RDU/HBLF/REON
var MOCK_ODD_OUTCOME_FIRST = 'success'; // first command outcome; cycles success -> declined -> pending

(function () {
  'use strict';

  var JLR = require('./jlr'); // pure helpers only: flattenStatus/serviceState/motionState/displaySafeStatus

  // ---------------------------------------------------------------- fixtures

  // Mutable mock lock state -- flipped by successful LOCK/UNLOCK commands so
  // the status card visibly reflects a command's outcome instead of always
  // reporting the same canned value. Real unlock only holds for ~45s before
  // the car auto-re-locks (see jlr-remote-research.md); the mock does not
  // simulate that timer itself -- the watch UI is responsible for the
  // "re-locks in 45s" messaging, not this fixture.
  var mockLocked = true;

  function rawStatusFixture() {
    return {
      vehicleStatus: {
        coreStatus: [
          { key: 'DOOR_IS_ALL_DOORS_LOCKED', value: mockLocked ? 'TRUE' : 'FALSE' },
          { key: 'FUEL_LEVEL_PERC', value: '90' },
          { key: 'DISTANCE_TO_EMPTY_FUEL', value: '709' },
          { key: 'ODOMETER_MILES', value: '53516' },
          { key: 'THEFT_ALARM_STATUS', value: 'ALARM_OFF' },
          { key: 'VEHICLE_STATE_TYPE', value: 'KEY_ON_ENGINE_OFF' },
          { key: 'DOOR_FRONT_LEFT_POSITION', value: 'CLOSED' },
          { key: 'DOOR_FRONT_RIGHT_POSITION', value: 'CLOSED' },
          { key: 'DOOR_REAR_LEFT_POSITION', value: 'CLOSED' },
          { key: 'DOOR_REAR_RIGHT_POSITION', value: 'CLOSED' },
          { key: 'DOOR_BOOT_POSITION', value: 'CLOSED' },
          { key: 'DOOR_ENGINE_HOOD_POSITION', value: 'CLOSED' },
          // One window cracked -- deliberately, to exercise the
          // doors/windows-open indicator without contradicting "all doors
          // locked" (a locked car can still have a window down).
          { key: 'WINDOW_FRONT_LEFT_STATUS', value: 'OPEN' },
          { key: 'WINDOW_FRONT_RIGHT_STATUS', value: 'CLOSED' },
          { key: 'WINDOW_REAR_LEFT_STATUS', value: 'CLOSED' },
          { key: 'WINDOW_REAR_RIGHT_STATUS', value: 'CLOSED' },
          { key: 'IS_SUNROOF_OPEN', value: 'FALSE' },
          { key: 'TYRE_PRESSURE_FRONT_LEFT', value: '230' },
          { key: 'TYRE_PRESSURE_FRONT_RIGHT', value: '232' },
          { key: 'TYRE_PRESSURE_REAR_LEFT', value: '228' },
          { key: 'TYRE_PRESSURE_REAR_RIGHT', value: '229' },
          { key: 'TYRE_STATUS_FRONT_LEFT', value: 'NORMAL' },
          { key: 'TYRE_STATUS_FRONT_RIGHT', value: 'NORMAL' },
          { key: 'TYRE_STATUS_REAR_LEFT', value: 'NORMAL' },
          { key: 'TYRE_STATUS_REAR_RIGHT', value: 'NORMAL' },
          { key: 'EXT_KILOMETERS_TO_SERVICE', value: '8500' },
          { key: 'EXT_EXHAUST_FLUID_DISTANCE_TO_SERVICE_KM', value: '12000' },
          { key: 'WASHER_FLUID_WARN', value: 'FALSE' },
          // Deliberately TRUE -- exercises the warning-icon render in the
          // tyre/service info screen without needing a second fixture.
          { key: 'EXT_OIL_LEVEL_WARN', value: 'TRUE' },
          { key: 'BRAKE_FLUID_WARN', value: 'FALSE' },
          { key: 'ENG_COOLANT_LEVEL_WARN', value: 'FALSE' },
          { key: 'BATTERY_VOLTAGE', value: '12.6' },
          { key: 'ENGINE_COOLANT_TEMP', value: '89' },
          { key: 'TU_STATUS_DAYS_SINCE_GNSS_FIX', value: '3' },
          { key: 'PRIVACY_SWITCH', value: 'TRUE' }
        ],
        evStatus: []
      },
      // Tier-3 freshness fallback -- this vehicle reports no top-level
      // LAST_UPDATED_TIME key and no per-item lastUpdatedTime, matching the
      // live probe exactly (see jlr-remote-research.md's "implementation
      // trap"). Fixed 47 minutes before "now" at fixture-build time so the
      // freshness line always reads as a plausible age.
      lastUpdatedTime: new Date(Date.now() - 47 * 60 * 1000).toISOString().replace('Z', '+0000')
    };
  }

  function rawAttributesFixture() {
    var services = MOCK_LIMITED_CAPS ?
      // msp1974#13 counter-example: a real Land Rover with only the
      // Protect-tier services -- no lock, no unlock, no honk & flash, no
      // remote start. This is the build the "capability-gated build" screen
      // shot in the milestone brief exercises.
      [
        { serviceType: 'BCALL', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'ECALL', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'JL', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'VHS', vehicleCapable: true, serviceEnabled: true }
      ] :
      // The full 12-service list confirmed on Ankur's actual Discovery.
      [
        { serviceType: 'ALOFF', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'BCALL', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'CI', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'ECALL', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'HBLF', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'JL', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'RDL', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'RDU', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'REOFF', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'REON', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'VHS', vehicleCapable: true, serviceEnabled: true },
        { serviceType: 'WAUA', vehicleCapable: true, serviceEnabled: true }
      ];
    return {
      vehicleBrand: 'Land Rover',
      vehicleType: 'Discovery',
      modelYear: 2018,
      fuelType: 'Diesel',
      numberOfDoors: 5,
      availableServices: services
    };
  }

  function rawPositionFixture() {
    return {
      position: {
        latitude: 51.5033,
        longitude: -0.1195,
        heading: 0,
        // Speed is what MOCK_MOVING flips -- everything else about the
        // fixture stays identical, matching the research doc's point that
        // the car's own status is corroboration only and the phone's live
        // speed is authoritative for "is the wearer driving".
        speed: 0,
        positionQuality: 'POOR',
        timestamp: new Date(Date.now() - 40 * 60 * 1000).toISOString()
      }
    };
  }

  // Simulated phone GPS reading. In mock mode there is no real
  // navigator.geolocation call -- MOCK_MOVING stands in for "phone is
  // moving fast" so the safety-lockout screen is reachable without a real
  // drive. units: 'ms' matches what PebbleKit JS's real geolocation API
  // reports (metres/second), per motionState()'s expected shape.
  function mockPhoneSpeed() {
    return MOCK_MOVING ? { speed: 20, units: 'ms' } : { speed: 0, units: 'ms' };
  }

  // Fixed "phone is here" point ~380m from the car, bearing ~person walking
  // toward it from the southwest -- gives find-my-car a non-trivial arrow
  // and distance to render instead of "0m, bearing undefined".
  function mockPhonePosition() {
    return { latitude: 51.5008, longitude: -0.1225 };
  }

  // -------------------------------------------------------------- haversine
  // Distance (metres) + initial bearing (degrees, 0-360) from `from` to
  // `to`. Per the research doc: "phone GPS via PebbleKit JS geolocation ->
  // haversine distance + bearing to get_position() result". Done here in
  // pkjs, not on the watch -- the watch only rotates an arrow relative to a
  // bearing it's given plus its own compass heading.
  var EARTH_RADIUS_M = 6371000;
  function toRad(deg) { return deg * Math.PI / 180; }
  function toDeg(rad) { return rad * 180 / Math.PI; }

  function haversineDistanceM(from, to) {
    var dLat = toRad(to.latitude - from.latitude);
    var dLon = toRad(to.longitude - from.longitude);
    var lat1 = toRad(from.latitude);
    var lat2 = toRad(to.latitude);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_M * c;
  }

  function initialBearingDeg(from, to) {
    var lat1 = toRad(from.latitude);
    var lat2 = toRad(to.latitude);
    var dLon = toRad(to.longitude - from.longitude);
    var y = Math.sin(dLon) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    var brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
  }

  // ------------------------------------------------------- command outcomes
  // Deterministic cycle rather than random, so screenshotting each of the
  // three distinct outcomes (success / declined / pending) required by the
  // milestone brief is just "press the button three times", not a coin
  // flip. Order starts from MOCK_ODD_OUTCOME_FIRST for convenience when
  // testing a specific one first.
  var OUTCOME_CYCLE = ['success', 'declined', 'pending'];
  var outcomeIndex = (function () {
    var i = OUTCOME_CYCLE.indexOf(MOCK_ODD_OUTCOME_FIRST);
    return i >= 0 ? i : 0;
  })();

  function nextOutcome() {
    var outcome = OUTCOME_CYCLE[outcomeIndex % OUTCOME_CYCLE.length];
    outcomeIndex++;
    return outcome;
  }

  // ------------------------------------------------------------ mock client

  function MockClient() {}

  // getBundle(cb(err, {status, caps, motion, phone})) -- one round trip that
  // hands back everything the status card needs. Real jlr.js exposes these
  // as separate calls (getStatus/getCapabilities); the mock collapses them
  // since index.js's job is just to bridge to AppMessage, not to reproduce
  // the real client's call shape.
  MockClient.prototype.getBundle = function (cb) {
    setTimeout(function () {
      var status = JLR.flattenStatus(rawStatusFixture());
      var attrs = rawAttributesFixture();
      var caps = {
        RDL: JLR.serviceState(attrs, 'RDL'),
        RDU: JLR.serviceState(attrs, 'RDU'),
        HBLF: JLR.serviceState(attrs, 'HBLF'),
        VHS: JLR.serviceState(attrs, 'VHS'),
        REON: JLR.serviceState(attrs, 'REON')
      };
      var phone = mockPhoneSpeed();
      var position = rawPositionFixture().position;
      position.units = 'kmh'; // mockPhoneSpeed already applies its own units for phone
      var motion = JLR.motionState(status, position, phone);
      cb(null, { status: status, caps: caps, motion: motion, vehicleType: attrs.vehicleType,
        modelYear: attrs.modelYear });
    }, 300); // small delay so "cache-then-refresh" is actually observable, not instant
  };

  // getPosition(cb(err, {distanceM, bearingDeg, quality, ageSec, daysSinceFix, hasFix}))
  MockClient.prototype.getPosition = function (cb) {
    setTimeout(function () {
      var raw = rawPositionFixture().position;
      var phonePos = mockPhonePosition();
      var carPos = { latitude: raw.latitude, longitude: raw.longitude };
      var distanceM = Math.round(haversineDistanceM(phonePos, carPos));
      var bearingDeg = Math.round(initialBearingDeg(phonePos, carPos));
      var ageSec = Math.round((Date.now() - new Date(raw.timestamp).getTime()) / 1000);
      cb(null, {
        hasFix: true,
        distanceM: distanceM,
        bearingDeg: bearingDeg,
        quality: raw.positionQuality, // 'POOR' in this fixture -- surfaced, not hidden
        ageSec: ageSec,
        daysSinceFix: 3 // TU_STATUS_DAYS_SINCE_GNSS_FIX from the live probe
      });
    }, 300);
  };

  // sendCommand(serviceCode, cb(err, result)) -- mirrors jlr.js's three-
  // outcome contract exactly (never collapses declined/pending/success),
  // but on a deterministic cycle instead of real polling. The ~2.5s delay
  // is deliberately long enough to screenshot the "Contacting car..."
  // in-flight state before the result lands.
  MockClient.prototype.sendCommand = function (serviceCode, cb) {
    setTimeout(function () {
      var outcome = nextOutcome();
      if (outcome === 'success') {
        if (serviceCode === 'RDL') { mockLocked = true; }
        if (serviceCode === 'RDU') { mockLocked = false; }
        cb(null, { outcome: 'success' });
      } else if (outcome === 'declined') {
        cb(null, {
          outcome: 'declined',
          failureReason: 'NegativeAcknowledge',
          failureDescription: 'conflictWithOnboardChange'
        });
      } else {
        cb(null, { outcome: 'pending' });
      }
    }, 2500);
  };

  module.exports = {
    MockClient: MockClient,
    isMoving: function () { return MOCK_MOVING; },
    isLimitedCaps: function () { return MOCK_LIMITED_CAPS; }
  };
}).call(this);
