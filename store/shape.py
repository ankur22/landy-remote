# Boxy 4x4 side profile in unit coords (0..1).
#
# Deliberately generic: upright greenhouse, flat roof, roof rack, short
# overhangs, chunky tyres. No grille, badge, or model-specific line -- the
# icon must not resemble any manufacturer's mark.
#
# Proportions matter more than detail at icon sizes. An earlier version was
# ~1.2:1 and read as a tractor; a real SUV side profile is nearer 2:1.
#
# Order matters: wheel ARCHES are cut from the body before the tyres are
# drawn, so the tyres sit in arches rather than looking like holes punched in
# one solid blob.
WHEELS = ((0.255, 0.640), (0.775, 0.640))
TYRE_R = 0.115
HUB_R = 0.042
ARCH_R = 0.145


def inside(x, y, simple=False):
    """simple=True drops detail that turns to mush below ~40px: the roof
    rack, the hub holes and the window mullion. At 25px those become 1-2px
    features that read as noise rather than as a vehicle."""
    def rect(x0, y0, x1, y1):
        return x0 <= x <= x1 and y0 <= y <= y1

    def circ(cx, cy, r):
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

    for cx, cy in WHEELS:                       # tyres, on top
        if circ(cx, cy, TYRE_R):
            return True if simple else not circ(cx, cy, HUB_R)
    for cx, cy in WHEELS:                       # arches, cut from the body
        if circ(cx, cy, ARCH_R):
            return False

    if not simple and rect(0.325, 0.300, 0.800, 0.330):   # roof rack
        return True
    if rect(0.325, 0.330, 0.790, 0.470):        # greenhouse
        if simple:
            # one wide window instead of two -- the mullion is sub-pixel small
            return not rect(0.360, 0.360, 0.755, 0.448)
        if rect(0.360, 0.355, 0.540, 0.448):    # front glass
            return False
        if rect(0.580, 0.355, 0.755, 0.448):    # rear glass
            return False
        return True
    if rect(0.035, 0.470, 0.965, 0.625):        # body
        return True
    if rect(0.290, 0.625, 0.740, 0.660):        # sill
        return True
    return False
