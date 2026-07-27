#pragma once

// On-watch confirmation step required before unlock -- lock and honk fire
// directly, but unlock opens the driver's door and the car auto-re-locks
// after ~45s, so the brief requires an explicit confirm here rather than
// leaving the user wondering why "locked" reappears a minute later.
void confirm_window_push(void);
