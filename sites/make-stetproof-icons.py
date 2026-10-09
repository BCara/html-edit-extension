"""StetProof's icons: a cream serif S on proof red, over the dotted line a
proofreader puts under words that should stand. Run once; the PNGs are
committed.  python3 sites/make-stetproof-icons.py"""
from PIL import Image, ImageDraw, ImageFont
import os

RED, CREAM = (163, 32, 29, 255), (251, 248, 242, 255)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
OUT = os.path.join(os.path.dirname(__file__), 'brands', 'stetproof', 'icons')

def draw(size, maskable=False):
    s = size * 4                      # draw large, shrink for smooth edges
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable:
        d.rectangle([0, 0, s, s], fill=RED)
        scale = 0.62                  # inside the maskable safe zone
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=RED)
        scale = 0.86
    box = s * scale
    font = ImageFont.truetype(FONT, int(box * 0.78))
    l, t, r, b = d.textbbox((0, 0), 'S', font=font)
    cx = s / 2
    top = (s - box) / 2 + box * 0.06
    d.text((cx - (l + r) / 2, top - t), 'S', font=font, fill=CREAM)
    # Three dots under the letter, the stet mark.
    if size >= 32:
        y = top + (b - t) + box * 0.10
        rad = box * 0.045
        for i in (-1, 0, 1):
            x = cx + i * box * 0.17
            d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=CREAM)
    return im.resize((size, size), Image.LANCZOS)

for n in (16, 32, 48, 128, 192, 512):
    draw(n).save(os.path.join(OUT, 'icon%d.png' % n))
draw(512, True).save(os.path.join(OUT, 'icon512-maskable.png'))
print('icons written to', OUT)
