#include "comm.h"

#include "state.h"

#define RETRY_DELAY_MS 500
#define MAX_RETRIES 5
#define QUEUE_SIZE 4

// MSG_TYPE values from pkjs. Must match index.js's MSG_* constants.
#define MSG_STATUS_UPDATE 1
#define MSG_CMD_RESULT 2
#define MSG_POSITION_UPDATE 3
#define MSG_ERROR 4

typedef struct {
  Cmd cmd;
  // Tenths of a degree Celsius for CMD_REMOTE_START (e.g. 215 = 21.5 C).
  // -1 means "no preference"; every other command ignores it.
  int temp_c10;
} QueuedMsg;

static void (*s_status_cb)(void);
static void (*s_position_cb)(void);
static void (*s_cmd_result_cb)(Cmd cmd, int outcome, const char *message);
static void (*s_error_cb)(const char *message);

static QueuedMsg s_queue[QUEUE_SIZE];
static int s_queue_count;
static int s_retry_count;

static bool prv_is_request(Cmd cmd) {
  return cmd == CMD_GET_STATUS || cmd == CMD_GET_POSITION;
}

static void prv_send_head(void);

static void prv_remove_at(int idx) {
  for (int i = idx; i < s_queue_count - 1; i++) {
    s_queue[i] = s_queue[i + 1];
  }
  s_queue_count--;
}

static void prv_advance(void) {
  if (s_queue_count > 0) {
    prv_remove_at(0);
  }
  s_retry_count = 0;
  if (s_queue_count > 0) {
    prv_send_head();
  }
}

static void prv_schedule_retry(void) {
  if (s_retry_count >= MAX_RETRIES) {
    // Give up on this one message only -- never let a stuck send jam every
    // command behind it.
    prv_advance();
    return;
  }
  s_retry_count++;
  app_timer_register(RETRY_DELAY_MS, (AppTimerCallback) prv_send_head, NULL);
}

static void prv_send_head(void) {
  if (s_queue_count == 0) {
    return;
  }
  QueuedMsg *msg = &s_queue[0];

  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK) {
    prv_schedule_retry();
    return;
  }

  dict_write_int32(iter, MESSAGE_KEY_CMD, (int32_t) msg->cmd);
  if (msg->temp_c10 >= 0) {
    dict_write_int32(iter, MESSAGE_KEY_CLIMATE_TEMP_C10, (int32_t) msg->temp_c10);
  }

  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    prv_schedule_retry();
  }
}

static void prv_push(Cmd cmd, int temp_c10) {
  bool was_empty = (s_queue_count == 0);

  if (prv_is_request(cmd)) {
    for (int i = 0; i < s_queue_count; i++) {
      if (prv_is_request(s_queue[i].cmd)) {
        s_queue[i].cmd = cmd; // only the latest status/position request matters
        return;
      }
    }
  }

  if (s_queue_count >= QUEUE_SIZE) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "comm: outbox queue full, dropping cmd %d", (int) cmd);
    return;
  }

  s_queue[s_queue_count].cmd = cmd;
  s_queue[s_queue_count].temp_c10 = temp_c10;
  s_queue_count++;

  if (was_empty) {
    s_retry_count = 0;
    prv_send_head();
  }
}

static void prv_outbox_sent(DictionaryIterator *iter, void *ctx) {
  prv_advance();
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *ctx) {
  prv_schedule_retry();
}

static void prv_inbox_received(DictionaryIterator *iter, void *ctx) {
  Tuple *type_tuple = dict_find(iter, MESSAGE_KEY_MSG_TYPE);
  if (!type_tuple) {
    return;
  }
  int32_t msg_type = type_tuple->value->int32;

  if (msg_type == MSG_STATUS_UPDATE) {
    state_apply_status_update(iter);
    if (s_status_cb) {
      s_status_cb();
    }
    return;
  }

  if (msg_type == MSG_POSITION_UPDATE) {
    state_apply_position_update(iter);
    if (s_position_cb) {
      s_position_cb();
    }
    return;
  }

  if (msg_type == MSG_CMD_RESULT) {
    Tuple *echo_tuple = dict_find(iter, MESSAGE_KEY_CMD_ECHO);
    Tuple *outcome_tuple = dict_find(iter, MESSAGE_KEY_CMD_OUTCOME);
    Tuple *message_tuple = dict_find(iter, MESSAGE_KEY_CMD_MESSAGE);
    if (!echo_tuple || !outcome_tuple) {
      return;
    }
    const char *message = message_tuple ? message_tuple->value->cstring : "";
    if (s_cmd_result_cb) {
      s_cmd_result_cb((Cmd) echo_tuple->value->int32, (int) outcome_tuple->value->int32, message);
    }
    return;
  }

  if (msg_type == MSG_ERROR) {
    Tuple *message_tuple = dict_find(iter, MESSAGE_KEY_ERROR_MESSAGE);
    const char *message = message_tuple ? message_tuple->value->cstring : "unknown error";
    if (s_error_cb) {
      s_error_cb(message);
    }
    return;
  }
}

void comm_init(void) {
  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_outbox_sent(prv_outbox_sent);
  app_message_register_outbox_failed(prv_outbox_failed);
  // Comfortably inside the 8200-byte emery inbox/outbox maximum -- this
  // protocol's largest dict (a full status update, ~25 int32 keys plus one
  // short string) is under 300 bytes.
  app_message_open(2048, 512);
}

void comm_set_status_callback(void (*cb)(void)) {
  s_status_cb = cb;
}

void comm_set_position_callback(void (*cb)(void)) {
  s_position_cb = cb;
}

void comm_set_command_result_callback(void (*cb)(Cmd cmd, int outcome, const char *message)) {
  s_cmd_result_cb = cb;
}

void comm_set_error_callback(void (*cb)(const char *message)) {
  s_error_cb = cb;
}

void comm_send_cmd(Cmd cmd) {
  prv_push(cmd, -1);
}

void comm_send_cmd_with_temp(Cmd cmd, int temp_c10) {
  prv_push(cmd, temp_c10);
}
