from PIL import Image
import os

base = r"c:\Users\edwin_q\OneDrive\Documents\astohealthhub\assets"


def cutout(src, dest, dark_thresh=48):
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    px = im.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r < dark_thresh and g < dark_thresh and b < dark_thresh + 12:
                px[x, y] = (r, g, b, 0)
            elif (r + g + b) / 3 < 36:
                px[x, y] = (r, g, b, 0)
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            lum = (r + g + b) / 3
            if lum < 55 and b >= r and b >= g and max(r, g, b) < 95:
                t = 0
                for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    if px[x + dx, y + dy][3] == 0:
                        t += 1
                if t >= 2:
                    px[x, y] = (r, g, b, 0)
    im.save(dest, "PNG")
    print("wrote", dest, im.size)


cutout(os.path.join(base, "atlas-mascot.jpg"), os.path.join(base, "atlas-cutout.png"), 52)
cutout(os.path.join(base, "atlas-mascot-wave.jpg"), os.path.join(base, "atlas-cutout-wave.png"), 52)
src2 = r"C:\Users\edwin_q\.cursor\projects\c-Users-edwin-q-OneDrive-Documents-astohealthhub\assets\image-596b16a0-7839-412c-b762-0bccf98e616f.png"
if os.path.exists(src2):
    # Prefer the latest idle screenshot cutout if available
    cutout(src2, os.path.join(base, "atlas-cutout.png"), 42)
print("done")
