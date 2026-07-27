'use strict';

var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var stateHeader = fs.readFileSync(path.join(root, 'src/c/state.h'), 'utf8');
var stateSource = fs.readFileSync(path.join(root, 'src/c/state.c'), 'utf8');
var statusSource = fs.readFileSync(path.join(root, 'src/c/status_window.c'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  stateHeader.indexOf('state_is_session_stationary_verified') !== -1,
  'state.h must expose current-session stationary verification'
);
assert(
  /static bool s_session_stationary_verified;/.test(stateSource),
  'stationary verification must be separate from the persisted VehicleState'
);
assert(
  /prv_defaults[\s\S]*s_session_stationary_verified = false;/.test(stateSource),
  'startup must reset stationary verification before loading cached state'
);
assert(
  /state_apply_status_update[\s\S]*s_session_stationary_verified = !in_motion;/.test(stateSource),
  'only a fresh non-motion status may establish stationary verification'
);
assert(
  /bool lockdown = !state_is_session_stationary_verified\(\) \|\| st->in_motion;/.test(statusSource),
  'status rendering must hide cached data until current-session proof exists'
);

var clickGuards =
  statusSource.match(/if \(!state_is_session_stationary_verified\(\) \|\| state_get\(\)->in_motion\) \{/g) || [];
assert(
  clickGuards.length === 3,
  'all three status-window buttons must be inert until stationary verification'
);

console.log('startup safety: 6 assertions passed');
