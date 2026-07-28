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
// The gate now separates DISPLAY from ACTUATION (owner's decision 2026-07-28):
// read-only data is always shown; only commands require proof of being
// stationary. These assertions therefore track cmds_blocked, not in_motion.
assert(
  /state_apply_status_update[\s\S]*s_session_stationary_verified = !cmds_blocked;/.test(stateSource),
  'only a fresh commands-allowed status may establish stationary verification'
);
assert(
  /MESSAGE_KEY_CMDS_BLOCKED, true\)/.test(stateSource),
  'cmds_blocked must default to TRUE when the key is absent, so an older or ' +
  'malformed push can never enable the action bar by omission'
);
assert(
  /bool cmds_blocked = !state_is_session_stationary_verified\(\) \|\| st->cmds_blocked;/.test(statusSource),
  'the action bar must be gated on cmds_blocked'
);

// UP (lock/unlock) and SELECT (a menu of commands) must both be inert without
// proof. DOWN is find-my-car, a read, and is deliberately NOT gated.
var upGuard = /if \(!state_is_session_stationary_verified\(\) \|\| st->cmds_blocked\) \{/
  .test(statusSource);
var selectGuard = /if \(!state_is_session_stationary_verified\(\) \|\| state_get\(\)->cmds_blocked\) \{/
  .test(statusSource);
assert(upGuard, 'the UP (lock/unlock) handler must be inert without stationary proof');
assert(selectGuard, 'the SELECT (command menu) handler must be inert without stationary proof');

// Regression guard: the actuating handlers must not be reachable via the old
// display-only flag, which no longer implies anything about commands.
assert(
  statusSource.indexOf('state_get()->in_motion) {\n    return;') === -1,
  'command handlers must gate on cmds_blocked, never on the in_motion display hint'
);

console.log('startup safety: 8 assertions passed');

// Motion must never be restored from the persisted cache. A cached "moving"
// (or, before the engine-state heuristic was dropped, a cached "idling")
// made every launch open claiming the vehicle was in motion.
assert(
  /s_state = loaded;[\s\S]*s_state\.in_motion = false;/.test(stateSource),
  'prv_load_cache must clear in_motion after restoring the cache'
);
assert(
  /s_state = loaded;[\s\S]*s_state\.cmds_blocked = true;/.test(stateSource),
  'a restored cache must never imply commands are allowed'
);

// A running engine is not a moving vehicle. Remote climate starts the engine,
// so treating engine-on as motion blocked the very command that stops it.
var jlrSource = fs.readFileSync(path.join(root, 'src/pkjs/jlr.js'), 'utf8');
assert(
  !/ENGINE_ON\|ENGINE_RUNNING/.test(jlrSource),
  'motionState must not infer motion from a running engine'
);

console.log('startup safety: 3 further assertions passed');
