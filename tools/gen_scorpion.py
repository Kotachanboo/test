"""
サソリ (cavern:scorpion) のモデル・テクスチャ・アニメーションを作る。

Blockbench が無くても作れるよう、立方体の並びをここに数値で書いている。
形を直したいときはこのファイルの数値を変えて実行し直す:
    python3 tools/gen_scorpion.py            (Pillow が必要)
出力した models/entity/scorpion.geo.json は Blockbench でも開ける。

座標は 16 = 1ブロック。前は -Z、上は +Y。
回転の向きはバニラの馬の首 (x=+30 で前に傾く) とクモの脚 (-x 側で z=-45 が下向き)
から確かめた。x と z は右手系と逆、y はそのまま。
  - +Z へ伸びる尾は x を正にすると上へ反る
  - -X へ伸びる脚は z を負、+X へ伸びる脚は z を正にすると下を向く
"""
import json, hashlib, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RP = os.path.join(ROOT, "CavernMiner_RP")

# ---------------------------------------------------------------- 色
SAND = (222, 188, 128)
SAND_DARK = (176, 140, 86)
TIP = (96, 70, 42)
RED = (184, 32, 30)
RED_DARK = (110, 14, 14)
EYE = (30, 20, 16)

bones = []   # {name, parent, pivot, rotation, cubes:[{origin,size,color,kind}]}

def bone(name, parent, pivot, rotation=(0, 0, 0), cubes=()):
    bones.append({"name": name, "parent": parent, "pivot": list(pivot),
                  "rotation": list(rotation), "cubes": list(cubes)})

def cube(origin, size, color=SAND, kind="plain"):
    return {"origin": list(origin), "size": list(size), "color": color, "kind": kind}

# ---------------------------------------------------------------- 胴と頭
bone("body", None, (0, 6, 0), cubes=[cube((-4, 4, -5), (8, 4, 13), kind="body")])
bone("head", "body", (0, 6, -5), cubes=[cube((-3, 4, -9), (6, 4, 4), kind="head")])

# ---------------------------------------------------------------- 脚 (左右4本ずつ)
# 付け根から外へ水平に伸び、膝で真下に折れる。前の脚ほど前へ、後ろほど後ろへ開く
LEG_Z = [-3, 0, 3, 6]
LEG_SPLAY = [30, 10, -10, -30]   # 前へ開く角度 (度)
KNEE = 25                        # 膝の持ち上げ (度)
for i, (z, splay) in enumerate(zip(LEG_Z, LEG_SPLAY)):
    for side, sx in (("r", -1), ("l", 1)):
        name = f"leg_{side}{i}"
        # -X 側は y を負にすると前、+X 側は正にすると前 (y は右手系)
        ry = -splay if sx < 0 else splay
        x0 = 4 * sx
        upper = cube((x0 if sx > 0 else x0 - 6, 7, z - 1), (6, 2, 2))
        kx = x0 + 6 * sx                          # 膝の位置
        # 上の節を KNEE 度持ち上げて膝を背中より高くする。下の節は逆に回して垂直に戻す。
        # 持ち上げたぶん (6*sin25 ≒ 2.5) 下の節を下へ伸ばして足先を地面に着ける
        lower = cube((kx if sx > 0 else kx - 2, -0.5, z - 1), (2, 10, 2), color=SAND_DARK if i % 2 else SAND)
        tip = cube((kx if sx > 0 else kx - 2, -2.5, z - 1), (2, 2, 2), color=TIP)
        rz = KNEE if sx < 0 else -KNEE             # -X 側は z を正にすると上がる
        bone(name, "body", (x0, 8, z), (0, ry, rz), [upper])
        bone(name + "_low", name, (kx, 8, z), (0, 0, -rz), [lower, tip])

# ---------------------------------------------------------------- はさみ
for side, sx in (("r", -1), ("l", 1)):
    ry = -35 if sx < 0 else 35
    x0 = 3 * sx
    bone(f"arm_{side}", "head", (x0, 6, -7), (0, ry, 0),
         [cube((x0 if sx > 0 else x0 - 6, 5, -8), (6, 2, 2))])
    ex = x0 + 6 * sx                              # 肘
    bone(f"forearm_{side}", f"arm_{side}", (ex, 6, -7), (0, -ry, 0),
         [cube((ex - 1, 5, -14), (2, 2, 7))])
    cx0 = ex - 2.5
    bone(f"claw_{side}", f"forearm_{side}", (ex, 6, -14), cubes=[
        cube((ex - 2, 4, -19), (4, 3, 5), kind="claw"),
        cube((ex - 2, 5, -22), (1, 2, 3), color=TIP),
        cube((ex + 1, 5, -22), (1, 2, 3), color=TIP),
    ])

# ---------------------------------------------------------------- 尾
# 後ろへまっすぐ伸ばした節を、x の回転で1節ずつ反らせて背中の上へ巻き上げる
TAIL = [(5, 35), (5, 28), (4, 22), (4, 16), (4, 12), (3, 8)]   # (幅, 反り)。針は背中の後ろ寄りに構える
z = 8
parent = "body"
for i, (w, pitch) in enumerate(TAIL):
    name = f"tail{i}"
    bone(name, parent, (0, 6, z), (pitch, 0, 0),
         [cube((-w / 2, 4.5, z), (w, 3, 4), color=SAND if i % 2 == 0 else SAND_DARK, kind="tail")])
    parent = name
    z += 4
bone("stinger", parent, (0, 6, z), (20, 0, 0), [
    cube((-2, 4, z), (4, 4, 4), color=RED, kind="bulb"),
    cube((-0.5, 5.5, z + 4), (1, 1, 3), color=RED_DARK),
])

# ---------------------------------------------------------------- テクスチャ (箱UV)
TW, TH = 128, 64

def box_uv_size(s):
    import math
    w, h, d = (math.ceil(v) for v in s)
    return 2 * (d + w), d + h, (w, h, d)

def noise(x, y, salt=0):
    return hashlib.md5(f"{x},{y},{salt}".encode()).digest()[0] / 255.0

def shade(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c)

def pack_and_paint():
    img = Image.new("RGBA", (TW, TH), (0, 0, 0, 0))
    px = img.load()
    cx = cy = row_h = 0
    for b in bones:
        for c in b["cubes"]:
            uw, uh, (w, h, d) = box_uv_size(c["size"])
            if cx + uw > TW:
                cx, cy, row_h = 0, cy + row_h, 0
            if cy + uh > TH:
                sys.exit("テクスチャが足りない: TW/TH を広げる")
            c["uv"] = [cx, cy]
            faces = {
                "top": (cx + d, cy, w, d, 1.12), "bottom": (cx + d + w, cy, w, d, 0.72),
                "east": (cx, cy + d, d, h, 0.95), "north": (cx + d, cy + d, w, h, 1.0),
                "west": (cx + d + w, cy + d, d, h, 0.95), "south": (cx + 2 * d + w, cy + d, w, h, 0.9),
            }
            for face, (fx, fy, fw, fh, f) in faces.items():
                for yy in range(fh):
                    for xx in range(fw):
                        col = shade(c["color"], f * (0.92 + 0.16 * noise(fx + xx, fy + yy)))
                        # 胴の上面は節の縞
                        if c["kind"] in ("body", "tail") and face == "top" and yy % 3 == 2:
                            col = shade(col, 0.82)
                        # 頭の上面の前寄りに目を2つ
                        if c["kind"] == "head" and face == "top" and yy == 1 and xx in (1, fw - 2):
                            col = EYE
                        if c["kind"] == "head" and face == "north" and yy == 1 and xx in (1, fw - 2):
                            col = EYE
                        # はさみの先は少し濃く
                        if c["kind"] == "claw" and face in ("top", "east", "west") and xx < 1:
                            col = shade(col, 0.8)
                        px[fx + xx, fy + yy] = (*col, 255)
            cx += uw
            row_h = max(row_h, uh)
    return img

# UV の割り当ては毎回行う (モデルに必要)。テクスチャは手で描いたものがあれば上書きしない。
# 描き直したいときだけ --repaint を付ける。
# 立方体の大きさや並び順を変えると UV の位置がずれ、手描きのテクスチャが合わなくなる。
# 形を変えるときは回転 (rotation) だけにするか、テクスチャも描き直す。
img = pack_and_paint()
tex_path = os.path.join(RP, "textures/entity/cavern/scorpion.png")
if "--repaint" in sys.argv or not os.path.exists(tex_path):
    os.makedirs(os.path.dirname(tex_path), exist_ok=True)
    img.save(tex_path)

geo = {
    "format_version": "1.12.0",
    "minecraft:geometry": [{
        "description": {
            "identifier": "geometry.cavern.scorpion",
            "texture_width": TW, "texture_height": TH,
            "visible_bounds_width": 3, "visible_bounds_height": 2.5,
            "visible_bounds_offset": [0, 1, 0],
        },
        "bones": [
            {k: v for k, v in {
                "name": b["name"], "parent": b["parent"], "pivot": b["pivot"],
                "rotation": b["rotation"] if any(b["rotation"]) else None,
                "cubes": [{"origin": c["origin"], "size": c["size"], "uv": c["uv"]} for c in b["cubes"]] or None,
            }.items() if v is not None}
            for b in bones
        ],
    }],
}
os.makedirs(os.path.join(RP, "models/entity"), exist_ok=True)
with open(os.path.join(RP, "models/entity/scorpion.geo.json"), "w") as f:
    json.dump(geo, f, indent=2)

print("ok:", len(bones), "bones,", sum(len(b["cubes"]) for b in bones), "cubes")
