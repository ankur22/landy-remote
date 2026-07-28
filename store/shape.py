# Boxy 4x4 side profile in unit coords (0..1).
#
# Deliberately generic: no grille, badge, or model-specific line -- the icon
# must not resemble any manufacturer's mark.
#
# Shape notes, each from a correction:
#  - The greenhouse runs back to meet the tail, giving a VERTICAL TAILGATE.
#    An earlier version stopped the cabin short and left body behind it, which
#    read as a saloon boot rather than a 4x4.
#  - Tall and upright (~1.5:1), not the 2:1 estate profile that preceded it.
#  - Wheel ARCHES are cut from the body before the tyres are drawn, so the
#    tyres sit in arches instead of looking like holes in one solid blob.
WHEELS = ((0.265, 0.730), (0.775, 0.730))
TYRE_R = 0.150
HUB_R = 0.055
ARCH_R = 0.182


def inside(x, y, simple=False):
    """simple=True drops detail that turns to mush below ~40px: the roof rack,
    the hub holes and the window mullion."""
    def rect(x0, y0, x1, y1):
        return x0 <= x <= x1 and y0 <= y <= y1

    def circ(cx, cy, r):
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

    for cx, cy in WHEELS:                        # tyres, on top
        if circ(cx, cy, TYRE_R):
            return True if simple else not circ(cx, cy, HUB_R)
    for cx, cy in WHEELS:                        # arches, cut from the body
        if circ(cx, cy, ARCH_R):
            return False

    if not simple and rect(0.345, 0.190, 0.885, 0.222):   # roof rack
        return True
    # Greenhouse: tall, and carried back to the tail -- vertical tailgate.
    if rect(0.345, 0.222, 0.905, 0.430):
        if simple:
            return not rect(0.383, 0.252, 0.867, 0.400)
        if rect(0.383, 0.252, 0.600, 0.400):     # front glass
            return False
        if rect(0.640, 0.252, 0.867, 0.400):     # rear glass
            return False
        return True
    if rect(0.055, 0.430, 0.945, 0.660):         # body: deep flanks, long bonnet
        return True
    if rect(0.320, 0.660, 0.715, 0.700):         # sill, high off the ground
        return True
    return False
