#pragma once

#include <pebble.h>

// AppMessage layer: watch -> pkjs command requests, and pkjs -> watch
// status/position/command-result pushes. Outbox queue + retry pattern
// cribbed from econfeed's comm.c (see ~/go/src/github.com/ankur22/econfeed).

// CMD values sent from the watch. Must match the CMD_* constants in
// src/pkjs/index.js exactly.
typedef enum {
  CMD_GET_STATUS = 1,
  CMD_LOCK = 2,
  CMD_UNLOCK = 3,
  CMD_HONK = 4,
  CMD_REFRESH = 5,
  CMD_REMOTE_START = 6,
  CMD_GET_POSITION = 7,
} Cmd;

void comm_init(void);

// Fires whenever a fresh (non-command-result) status push is applied to
// state.c -- i.e. after state_apply_status_update(). Whoever is showing the
// status window should redraw.
void comm_set_status_callback(void (*cb)(void));

// Fires after a position push is applied to state.c. The find-my-car window
// should redraw (and re-orient its arrow).
void comm_set_position_callback(void (*cb)(void));

// Fires when a MSG_CMD_RESULT arrives. `cmd` is CMD_ECHO (which command this
// result is for), `outcome` and `message` are as sent by pkjs -- never
// collapsed into a generic failure. The command-status window is the only
// expected subscriber.
void comm_set_command_result_callback(void (*cb)(Cmd cmd, int outcome, const char *message));

// Fires on a bridge-level error (MSG_ERROR from pkjs -- e.g. transport
// failure before a command even started).
void comm_set_error_callback(void (*cb)(const char *message));

// Enqueues `cmd` for sending to pkjs. GET_STATUS/GET_POSITION requests
// de-duplicate against an already-queued request of the same kind (only the
// latest matters); LOCK/UNLOCK/HONK/REFRESH/REMOTE_START commands are never
// coalesced or dropped for queue space -- they have real side effects and
// each must be individually acknowledged.
void comm_send_cmd(Cmd cmd);
