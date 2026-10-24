"""Draws promo/img/logo-yddd.png: the storage box icon on the left, "YDDD" and a tagline on the right, on a dark banner."""
import sys
from PIL import Image, ImageDraw, ImageFont

W, H, K = 1200, 400, 2  # size, supersampling
BG, NAME, TAG = (36, 40, 48, 255), (240, 236, 228, 255), (233, 196, 106, 255)  # --accent-2 tagline
FONT = "vendor/fonts/NotoSans-Bold.ttf"
img = Image.new("RGBA", (W * K, H * K), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, W * K - 1, H * K - 1], radius=48 * K, fill=BG)
icon = Image.open("promo/img/icon-storage-box.png").resize((360 * K, 360 * K), Image.LANCZOS)
img.alpha_composite(icon, (30 * K, 20 * K))  # the icon's own dark square merges into the banner
x = 410 * K
d.text((x, 205 * K), "YDDD", font=ImageFont.truetype(FONT, 170 * K), fill=NAME, anchor="ls")
d.text((x + 6 * K, 290 * K), "Easy 3D CAD for 3D printing", font=ImageFont.truetype(FONT, 46 * K), fill=TAG, anchor="ls")
img.resize((W, H), Image.LANCZOS).save(sys.argv[1] if len(sys.argv) > 1 else "promo/img/logo-yddd.png")
