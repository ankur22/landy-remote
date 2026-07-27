#pragma once

// Tiny reusable "just show some text, BACK to dismiss" window. Used for
// capability explanations ("Not enabled on your InControl account") and
// bridge-level errors -- anywhere a full command-outcome window would be
// overkill.
void message_window_push(const char *title, const char *body);
