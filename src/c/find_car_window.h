#pragma once

// Find-my-car: big compass arrow + distance in metres. Bearing comes from
// pkjs's haversine calc (phone GPS -> car position); the arrow rotates
// using the watch's own CompassService relative to that bearing. Position
// uncertainty (positionQuality, days-since-GNSS-fix) is surfaced rather
// than hidden -- a confidently-wrong arrow is worse than an honest one.
void find_car_window_push(void);
