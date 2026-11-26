from PIL import Image
import os
import shutil

base = r"c:\Users\edwin_q\OneDrive\Documents\astohealthhub\assets"
cursor_assets = r"C:\Users\edwin_q\.cursor\projects\c-Users-edwin-q-OneDrive-Documents-astohealthhub\assets"
for name in ("atlas-wave-green.jpg", "atlas-idle-green.jpg"):
    src = os.path.join(cursor_assets, name)
    if os.path.exists(src):
        shutil.copy(src, os.path.join(base, name))


def chroma_green(src, dest):
    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if g > 120 and g > r + 40 and g > b + 40:
                px[x, y] = (0, 0, 0, 0)
            elif g > 90 and g > r + 25 and g > b + 25 and (r + b) < 180:
                px[x, y] = (0, 0, 0, 0)
    im.save(dest, "PNG")
    print("wrote", dest, im.size)


chroma_green(os.path.join(base, "atlas-idle-green.jpg"), os.path.join(base, "atlas-cutout.png"))
chroma_green(os.path.join(base, "atlas-wave-green.jpg"), os.path.join(base, "atlas-cutout-wave.png"))
print("done")
