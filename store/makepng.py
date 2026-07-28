"""Minimal RGBA PNG writer + supersampled renderer for the Landy Remote icons.

No PIL/ImageMagick on this machine, so the PNG is emitted directly: signature,
IHDR, one zlib-compressed IDAT of filter-0 scanlines, IEND. That is enough for
a flat RGBA image and avoids adding a build dependency for three icons.
"""
import struct, zlib
from shape import inside

def content_bbox(n=400):
    """Scan the shape for its actual extent.

    Derived rather than hardcoded: a constant here silently drifts every time
    the shape is edited, and the symptom is an icon that looks slightly
    off-centre for reasons nobody can see.
    """
    xs, ys = [], []
    for j in range(n):
        for i in range(n):
            if inside((i + 0.5) / n, (j + 0.5) / n, False):
                xs.append(i / n)
                ys.append(j / n)
    return min(xs), min(ys), max(xs), max(ys)


BBOX = content_bbox()


def render(size, fg, bg, margin=0.06, ss=4, simple=False):
    """Return RGBA bytes. fg/bg are (r,g,b,a). margin is a fraction of size."""
    x0, y0, x1, y1 = BBOX
    cw, ch = x1 - x0, y1 - y0
    scale = (1.0 - 2 * margin) / max(cw, ch)
    # centre the content in the canvas
    ox = margin + ((1.0 - 2 * margin) - cw * scale) / 2.0
    oy = margin + ((1.0 - 2 * margin) - ch * scale) / 2.0

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            hits = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (px + (sx + 0.5) / ss) / size
                    v = (py + (sy + 0.5) / ss) / size
                    # canvas -> shape coords
                    shx = x0 + (u - ox) / scale
                    shy = y0 + (v - oy) / scale
                    if inside(shx, shy, simple):
                        hits += 1
            cov = hits / float(ss * ss)
            px_rgba = [
                int(round(bg[i] * (1 - cov) + fg[i] * cov)) for i in range(4)
            ]
            row += bytes(px_rgba)
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + r for r in rows)   # filter type 0 per scanline

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)
    return len(png)
