#pragma once

#include "comm.h"

// Shared "Contacting car... / result" window for every command (lock,
// unlock, honk & flash, force refresh, remote start). Distinguishes the
// three terminal outcomes visibly -- success, declined (car refused),
// pending (no response / car may be asleep) -- per the milestone brief;
// never collapses them into one generic failure message.
//
// `title` is the short verb shown while in flight, e.g. "Locking...".
// Push this window, THEN call comm_send_cmd(cmd) -- or have the caller send
// the command first and push immediately after; either order is fine since
// the result callback is wired centrally (see main.c) and this window
// simply ignores results for a cmd it isn't currently waiting on.
void command_window_push(Cmd cmd, const char *title);

// Wired once in main.c via comm_set_command_result_callback(). Public so
// main.c can reference it without command_window.c reaching back into comm.
void command_window_handle_result(Cmd cmd, int outcome, const char *message);
void command_window_handle_error(const char *message);
bool command_window_is_open(void);
