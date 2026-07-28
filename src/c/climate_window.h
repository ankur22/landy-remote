#pragma once

// Target cabin temperature picker, shown before starting remote climate.
// SELECT sends CMD_REMOTE_START with the chosen temperature and pushes the
// command window; BACK cancels without sending anything.
void climate_window_push(void);
