"""モデルの確認用。側面・背面・上面を平面で描く (回転の向きはゲームと同じ扱い)。
    python3 tools/preview_geo.py <geo.json> <texture.png> <出力.png> ['{"bone":[x,y,z]}']
"""
import json, math, sys
from PIL import Image, ImageDraw
geo_path, tex_path, out, *pose = sys.argv[1:]
anim = json.loads(pose[0]) if pose else {}
g = json.load(open(geo_path))["minecraft:geometry"][0]; tex = Image.open(tex_path).convert("RGBA")
B = {b["name"]: b for b in g["bones"]}
def rot(v, r):
    rx, ry, rz = [math.radians(a) for a in r]
    rx, rz = -rx, -rz            # Bedrock: x と z は右手系と逆
    x, y, z = v
    # X, Y, Z の順
    y, z = y * math.cos(rx) - z * math.sin(rx), y * math.sin(rx) + z * math.cos(rx)
    x, z = x * math.cos(ry) + z * math.sin(ry), -x * math.sin(ry) + z * math.cos(ry)
    x, y = x * math.cos(rz) - y * math.sin(rz), x * math.sin(rz) + y * math.cos(rz)
    return (x, y, z)
def world(p, bn):
    while bn:
        b = B[bn]; r = list(b.get("rotation", [0, 0, 0]))
        for i, a in enumerate(anim.get(bn, [0, 0, 0])): r[i] += a
        pv = b["pivot"]; q = rot([p[i] - pv[i] for i in range(3)], r); p = [q[i] + pv[i] for i in range(3)]
        bn = b.get("parent")
    return p
faces = []
for b in g["bones"]:
    for c in b.get("cubes", []):
        o, s, (u, v) = c["origin"], c["size"], c["uv"]
        w, h, d = [math.ceil(t) for t in s]
        col = tex.getpixel((int(u + d + w / 2), int(v + d + h / 2)))[:3]
        top = tex.getpixel((int(u + d + w / 2), int(v + d / 2)))[:3]
        X = [o[0], o[0] + s[0]]; Y = [o[1], o[1] + s[1]]; Z = [o[2], o[2] + s[2]]
        corner = lambda i, j, k: world([X[i], Y[j], Z[k]], b["name"])
        quads = [((0,0,0),(1,0,0),(1,1,0),(0,1,0)), ((0,0,1),(1,0,1),(1,1,1),(0,1,1)), ((0,0,0),(0,1,0),(0,1,1),(0,0,1)),
                 ((1,0,0),(1,1,0),(1,1,1),(1,0,1)), ((0,1,0),(1,1,0),(1,1,1),(0,1,1)), ((0,0,0),(1,0,0),(1,0,1),(0,0,1))]
        for qi, q in enumerate(quads):
            faces.append(([corner(*i) for i in q], top if qi == 4 else col))
S = 12
views = {"side": (lambda p: (p[2], -p[1]), lambda p: p[0]), "back": (lambda p: (-p[0], -p[1]), lambda p: -p[2]), "top": (lambda p: (p[0], p[2]), lambda p: p[1])}
img = Image.new("RGB", (3 * 460, 420), (150, 190, 230)); dr = ImageDraw.Draw(img)
for vi, (name, (proj, depth)) in enumerate(views.items()):
    ox, oy = vi * 460 + 230, 260 if name != "top" else 210
    for pts, col in sorted(faces, key=lambda f: sum(depth(p) for p in f[0]) / 4):
        poly = [(ox + proj(p)[0] * S / 1.6, oy + proj(p)[1] * S / 1.6) for p in pts]
        dr.polygon(poly, fill=col, outline=tuple(int(c * 0.6) for c in col))
    dr.text((vi * 460 + 10, 10), name, fill=(0, 0, 0))
    if name != "top": dr.line((vi * 460, oy, vi * 460 + 460, oy), fill=(120, 100, 60))
img.save(out)
