#include <pebble.h>

#include "comm.h"
#include "command_window.h"
#include "message_window.h"
#include "state.h"
#include "status_window.h"

static void prv_handle_error(const char *message) {
  if (command_window_is_open()) {
    command_window_handle_error(message);
  } else {
    message_window_push("Error", message);
  }
}

int main(void) {
  state_init();       // load any persisted status cache before anything draws
  comm_init();
  comm_set_command_result_callback(command_window_handle_result);
  comm_set_error_callback(prv_handle_error);

  status_window_push(); // paints the cached status immediately, then requests fresh data

  app_event_loop();
}
