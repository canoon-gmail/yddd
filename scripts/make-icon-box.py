"""Draws an icon (512 px): an open storage box with walls, a floor and one divider, in YDDD's accent colours on a dark rounded square."""
import sys, math
from PIL import Image, ImageDraw

S, K = 512, 4  # size, supersampling
BG, OUT = (36, 40, 48, 255), (36, 40, 48, 255)
TOP, LEFT, RIGHT = (233, 196, 106, 255), (244, 162, 89, 255), (196, 118, 56, 255)  # --accent-2, --accent, shaded
IN_X, IN_Y, FLOOR = (150, 92, 48, 255), (176, 106, 54, 255), (118, 74, 42, 255)  # inside, in shadow
img = Image.new("RGBA", (S * K, S * K), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([16 * K, 16 * K, (S - 16) * K, (S - 16) * K], radius=96 * K, fill=BG)

W, D, H, T = 10.0, 10.0, 6.0, 1.0  # box size and wall thickness
c, s, u = math.cos(math.pi / 6), math.sin(math.pi / 6), 19.5 * K  # isometric, units -> px
ox, oy = S * K / 2, S * K / 2 - 2 * u  # centred: the rim top is 6 u above oy, the bottom corner 10 u below
p = lambda x, y, z: (ox + (x - y) * c * u, oy + ((x + y) * s - z) * u)
quad = lambda *pts: [p(*q) for q in pts]
def face(pts, fill):
    d.polygon(pts, fill=fill)
    d.line(pts + [pts[0]], fill=OUT, width=5 * K, joint="curve")

a, b = T, W - T  # inner x range (= inner y range, the box is square)
face(quad((a, a, T), (b, a, T), (b, b, T), (a, b, T)), FLOOR)          # floor
face(quad((a, a, T), (a, b, T), (a, b, H), (a, a, H)), IN_X)           # back-left wall, inside
face(quad((a, a, T), (b, a, T), (b, a, H), (a, a, H)), IN_Y)           # back-right wall, inside
m0, m1, h = W / 2 - T / 2, W / 2 + T / 2, H - 0.8                      # divider
face(quad((m1, a, T), (m1, b, T), (m1, b, h), (m1, a, h)), RIGHT)
face(quad((m0, a, h), (m1, a, h), (m1, b, h), (m0, b, h)), TOP)
face(quad((W, 0, 0), (W, D, 0), (W, D, H), (W, 0, H)), RIGHT)          # outside walls
face(quad((0, D, 0), (W, D, 0), (W, D, H), (0, D, H)), LEFT)
for r in (quad((0, 0, H), (W, 0, H), (b, a, H), (a, a, H)), quad((W, 0, H), (W, D, H), (b, b, H), (b, a, H)),
          quad((W, D, H), (0, D, H), (a, b, H), (b, b, H)), quad((0, D, H), (0, 0, H), (a, a, H), (a, b, H))):
    d.polygon(r, fill=TOP)                                             # rim
d.line(quad((0, 0, H), (W, 0, H), (W, D, H), (0, D, H), (0, 0, H)), fill=OUT, width=5 * K, joint="curve")
d.line(quad((a, a, H), (b, a, H), (b, b, H), (a, b, H), (a, a, H)), fill=OUT, width=5 * K, joint="curve")
img.resize((S, S), Image.LANCZOS).save(sys.argv[1] if len(sys.argv) > 1 else "promo/img/icon-storage-box.png")
