"""Draws build/icon.png (512 px): the toolbar's box cube in YDDD's accent colours on a dark rounded square."""
import sys
from PIL import Image, ImageDraw

S, K = 512, 4  # size, supersampling
img = Image.new("RGBA", (S * K, S * K), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([16 * K, 16 * K, (S - 16) * K, (S - 16) * K], radius=96 * K, fill=(36, 40, 48, 255))
p = lambda x, y: (x * K * S / 24, y * K * S / 24)  # the 24-unit icon grid of icons.ts
top, left, right = [p(12, 4), p(19, 8), p(12, 12), p(5, 8)], [p(5, 8), p(12, 12), p(12, 20.5), p(5, 16.5)], [p(12, 12), p(19, 8), p(19, 16.5), p(12, 20.5)]
d.polygon(top, fill=(233, 196, 106, 255))    # --accent-2
d.polygon(left, fill=(244, 162, 89, 255))    # --accent
d.polygon(right, fill=(196, 118, 56, 255))   # accent, shaded
for f in (top, left, right):
    d.line(f + [f[0]], fill=(36, 40, 48, 255), width=6 * K, joint="curve")
img.resize((S, S), Image.LANCZOS).save(sys.argv[1] if len(sys.argv) > 1 else "build/icon.png")
