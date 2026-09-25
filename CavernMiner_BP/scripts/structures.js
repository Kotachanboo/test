/**
 * 構造物の生成
 *
 * すべてチャンク単位で、座標から決まる乱数で配置を決める。
 * 同じチャンクなら何度作り直しても同じ結果になる。
 *
 * 寸法はバニラに合わせてある:
 *   ダンジョン  床面 5x5 / 5x7 / 7x7、丸石の壁、床は丸石と苔石の混在、
 *               スポナー中央、チェスト0〜2個
 *   ジオード    外殻=滑らかな玄武岩 / 中間=方解石 / 内層=アメジストブロック、
 *               うち8.3%が芽生えたアメジスト。95%の確率で亀裂が入る
 */

import { ItemStack } from "@minecraft/server";

// ===========================================================================
// 乱数
// ===========================================================================

function mix(cx, cz, salt, seed) {
  let h = seed | 0;
  h = Math.imul(h ^ cx, 0x27d4eb2d);
  h = Math.imul(h ^ cz, 0x85ebca6b);
  h = Math.imul(h ^ salt, 0xc2b2ae35);
  return (h ^ (h >>> 15)) >>> 0;
}

function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// ===========================================================================
// ヒカリゴケ
// ===========================================================================

/** 面の名前と向き。ヒカリゴケは張り付く面を指定する必要がある */
const FACES = [
  ["down", 0, 1, 0],
  ["up", 0, -1, 0],
  ["north", 0, 0, 1],
  ["south", 0, 0, -1],
  ["west", 1, 0, 0],
  ["east", -1, 0, 0],
];

/**
 * 洞窟の壁沿いにヒカリゴケを生やす。
 * wallSpots は地形生成で拾った「空洞に面した岩」の一覧。
 */
function* placeLichen(ctx, cfg, rand) {
  const spots = ctx.wallSpots;
  if (!spots || spots.length === 0) return;

  let n = Math.floor(cfg.lichenPerChunk);
  if (rand() < cfg.lichenPerChunk - n) n++;

  for (let i = 0; i < n; i++) {
    const j = Math.floor(rand() * (spots.length / 3)) * 3;
    const sx = spots[j], sy = spots[j + 1], sz = spots[j + 2];

    // 起点から少しずつ広げる
    let px = sx, py = sy, pz = sz;
    const size = 1 + Math.floor(rand() * cfg.lichenPatch);

    for (let k = 0; k < size; k++) {
      // 岩に接している空洞側のマスを探して張り付ける
      for (const [face, dx, dy, dz] of FACES) {
        const ax = px + dx, ay = py + dy, az = pz + dz;
        if (ctx.isSolid(ax, ay, az)) continue;
        if (!ctx.isSolid(px, py, pz)) continue;
        ctx.placeLichen(ax, ay, az, face);
        break;
      }
      // 隣の壁へずらす
      const d = Math.floor(rand() * 6);
      if (d === 0) px++; else if (d === 1) px--;
      else if (d === 2) pz++; else if (d === 3) pz--;
      else if (d === 4) py++; else py--;
      if (!ctx.isSolid(px, py, pz)) { px = sx; py = sy; pz = sz; }
    }
    yield;
  }
}

// ===========================================================================
// ダンジョン (スポナールーム / 構造物)
// ===========================================================================
// 7x5x7。丸石と苔石の壁、中央 (3,1,3) にスポナー。
// チェストは候補16か所すべてに焼き込まれているので、0〜2個だけ残して
// 残りは空気に戻す。構造物は形が固定なので、数の変化はここで作る。

const DUNGEON_SIZE = [7, 5, 7];
const DUNGEON_SPAWNER = [3, 1, 3];

/** チェストの候補位置 (相対) */
const DUNGEON_CHESTS = [
  [1, 1, 1], [1, 1, 2], [1, 1, 3], [1, 1, 4], [1, 1, 5],
  [2, 1, 1], [2, 1, 5],
  [3, 1, 1], [3, 1, 5],
  [4, 1, 1], [4, 1, 5],
  [5, 1, 1], [5, 1, 2], [5, 1, 3], [5, 1, 4], [5, 1, 5],
];

const DUNGEON_KINDS = [
  "cavern:dungeon_zombie",
  "cavern:dungeon_skeleton",
  "cavern:dungeon_spider",
];

function* placeDungeon(ctx, cfg, rand) {
  const floor = findFloor(ctx, rand, DUNGEON_SPAWNER[0]);
  if (!floor) return;

  const [fx, fy, fz] = floor;
  const ox = fx - DUNGEON_SPAWNER[0];
  const oy = fy - DUNGEON_SPAWNER[1];
  const oz = fz - DUNGEON_SPAWNER[2];

  if (oy < ctx.yMin + 1 || oy + DUNGEON_SIZE[1] > ctx.yMax) return;

  if (!ctx.placeStructure(pick(rand, DUNGEON_KINDS), ox, oy, oz)) return;
  yield;

  // 残すチェストを選ぶ。バニラと同じく0〜2個
  const keep = Math.floor(rand() * 3);
  const order = DUNGEON_CHESTS.map((c, i) => [rand(), i]);
  order.sort((a, b) => a[0] - b[0]);
  const chosen = new Set(order.slice(0, keep).map((o) => o[1]));

  for (let i = 0; i < DUNGEON_CHESTS.length; i++) {
    const [dx, dy, dz] = DUNGEON_CHESTS[i];
    const x = ox + dx, y = oy + dy, z = oz + dz;
    if (chosen.has(i)) ctx.fillChestAt(x, y, z);
    else ctx.set(x, y, z, "minecraft:air");
  }
  yield;
}

// ===========================================================================
// アメジストジオード
// ===========================================================================

/** バニラのジオード。芽や結晶の房まで本家どおりに生える */
const VANILLA_GEODE = "minecraft:amethyst_geode_feature";

function* placeGeode(ctx, cfg, rand) {
  // まずバニラの feature を試す。ネイティブ呼び出し1回で済む。
  // ただしバニラは周囲に空洞が多いと生成を中止するので、何か所か試す
  if (ctx.placeFeature) {
    for (let t = 0; t < 3; t++) {
      const s = findAnywhere(ctx, rand);
      if (!s) break;
      if (ctx.placeFeature(VANILLA_GEODE, s[0], s[1], s[2])) {
        yield;
        return;
      }
    }
  }

  // バニラが使えない・どこも置けなかったときは自作で作る
  const spot = findAnywhere(ctx, rand);
  if (!spot) return;

  const [cx, cy, cz] = spot;
  const [rmin, rmax] = cfg.geodeRadius;
  const outer = rmin + Math.floor(rand() * (rmax - rmin + 1));
  const calcite = outer - 1;
  const amethyst = outer - 2;
  const hollow = outer - 3;

  // 95%の確率で亀裂が入る。開ける方向を決めておく
  const cracked = rand() < 0.95;
  const crackDir = Math.floor(rand() * 6);
  const crackWidth = 0.42;

  /** そのマスに置くブロック。null なら球の外 */
  const blockAt = (dx, dy, dz) => {
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + rand() * 0.6 - 0.3;
    if (dist > outer) return null;

    // 亀裂: 中心から特定方向の細い筒だけ空洞にする
    if (cracked && dist > hollow) {
      const n = [dx, -dx, dy, -dy, dz, -dz][crackDir];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len > 0 && n / len > 1 - crackWidth) return "minecraft:air";
    }
    if (dist <= hollow) return "minecraft:air";
    if (dist <= amethyst) {
      // 8.3% が芽生えたアメジスト
      return rand() < 0.083 ? "minecraft:budding_amethyst" : "minecraft:amethyst_block";
    }
    if (dist <= calcite) return "minecraft:calcite";
    return "minecraft:smooth_basalt";
  };

  /*
   * 1マスずつ置くと、半径7で約1400回の設置になる。これを一気にやると
   * 数秒間処理を譲らず、ウォッチドッグにアドオンごと止められる。
   * 同じブロックが z 方向に続く区間はまとめて置き、1層ごとに譲る。
   * (中の空洞はほぼ連続した空気なので、呼び出しが大きく減る)
   */
  for (let dy = -outer; dy <= outer; dy++) {
    for (let dx = -outer; dx <= outer; dx++) {
      let runStart = 0, runBlock = null;
      const flush = (end) => {
        if (runBlock !== null) {
          ctx.fill(cx + dx, cy + dy, cz + runStart, cx + dx, cy + dy, cz + end, runBlock);
        }
      };
      for (let dz = -outer; dz <= outer; dz++) {
        const b = blockAt(dx, dy, dz);
        if (b !== runBlock) {
          flush(dz - 1);
          runStart = dz;
          runBlock = b;
        }
      }
      flush(outer);
    }
    yield;   // 1層ごとに譲る
  }
}

// ===========================================================================
// 石レンガの小部屋 (構造物)
// ===========================================================================
// 7x7x7。壁は石レンガ1枚、内部は 5x5x5。
// 相対 (3,1,3) が床の中央、(3,1,5) に構造物ブロックが焼き込まれているので
// 配置後に消す必要がある。
// スポナーの種類は構造物に保存されているため、スクリプトで湧かせる必要はない。

const VAULT_SIZE = 7;
const VAULT_STRUCTURE_BLOCK = [3, 1, 5];   // 消すべき構造物ブロックの相対位置
const VAULT_CENTER = [3, 1, 3];            // 床の中央

/** 何の部屋を出すか。合計が1になるように */
const VAULT_KINDS = [
  { id: "cavern:vault_chest",    w: 0.34, chest: true },
  { id: "cavern:vault_zombie",   w: 0.16 },
  { id: "cavern:vault_skeleton", w: 0.16 },
  { id: "cavern:vault_spider",   w: 0.16 },
  { id: "cavern:vault_empty",    w: 0.18, captive: true },
];

function pickVault(rand) {
  let r = rand();
  for (const k of VAULT_KINDS) {
    r -= k.w;
    if (r <= 0) return k;
  }
  return VAULT_KINDS[0];
}

function* placeVault(ctx, cfg, rand) {
  const floor = findFloor(ctx, rand, VAULT_CENTER[0]);
  if (!floor) return;

  const [fx, fy, fz] = floor;
  const kind = pickVault(rand);

  // 床の中央が (fx, fy, fz) に来るよう原点をずらす
  const ox = fx - VAULT_CENTER[0];
  const oy = fy - VAULT_CENTER[1];
  const oz = fz - VAULT_CENTER[2];

  if (oy < ctx.yMin + 1 || oy + VAULT_SIZE > ctx.yMax) return;

  if (!ctx.placeStructure(kind.id, ox, oy, oz)) return;
  yield;

  // 焼き込まれた構造物ブロックを消す
  ctx.set(ox + VAULT_STRUCTURE_BLOCK[0],
          oy + VAULT_STRUCTURE_BLOCK[1],
          oz + VAULT_STRUCTURE_BLOCK[2], "minecraft:air");

  if (kind.chest) {
    // 中身は毎回抽選する。構造物に入れると固定になってしまう
    ctx.fillChestAt(fx, fy, fz);
  }

  if (kind.captive) {
    // 何もない部屋には囚われた者を。構造物に含めると
    // 保存時の見た目のまま固定されるので、ここで湧かせる
    ctx.captive(fx + 0.5, fy, fz + 0.5, rand);
  }

  yield;
}

// ===========================================================================
// 置き場所を探す
// ===========================================================================

/**
 * 洞窟の床を探す。壁リストのうち、上が空洞になっているもの。
 *
 * half を渡すと、床を中心にその幅の範囲が水や溶岩に掛からない場所だけを選ぶ。
 * 帯の下半分が彫られるようになって溶岩湖や水没した一帯の底も
 * 「床」に数えられるので、そのままだと湖の底に部屋が沈む。
 */
function findFloor(ctx, rand, half = 0) {
  const spots = ctx.wallSpots;
  if (!spots || spots.length === 0) return null;

  for (let t = 0; t < 24; t++) {
    const j = Math.floor(rand() * (spots.length / 3)) * 3;
    const x = spots[j], y = spots[j + 1], z = spots[j + 2];
    if (y < ctx.yMin + 4 || y > ctx.yMax - 8) continue;
    if (!ctx.isSolid(x, y, z)) continue;
    if (ctx.isSolid(x, y + 1, z)) continue;   // 上が空洞 = 床
    if (ctx.wetNear && ctx.wetNear(x, y + 1, z, half)) continue;
    return [x, y + 1, z];
  }
  return null;
}

/** 岩の中ならどこでもいい場所 (ジオード用) */
function findAnywhere(ctx, rand) {
  for (let t = 0; t < 24; t++) {
    const x = ctx.x0 + Math.floor(rand() * 16);
    const z = ctx.z0 + Math.floor(rand() * 16);
    const y = ctx.yMin + 8 + Math.floor(rand() * (ctx.yMax - ctx.yMin - 20));
    if (ctx.isSolid(x, y, z)) return [x, y, z];
  }
  return null;
}

// ===========================================================================
// 入口
// ===========================================================================

/**
 * このチャンクの構造物をまとめて生成する。
 * ctx には set / fill / spawner / chest / villager / placeLichen / isSolid が要る。
 */
export function* placeStructures(ctx, cfg, worldSeed) {
  if (!cfg) return;

  if (cfg.lichenPerChunk > 0) {
    yield* placeLichen(ctx, cfg, prng(mix(ctx.cx, ctx.cz, 4111, worldSeed)));
  }

  if (rollChance(ctx, worldSeed, 5231, cfg.dungeonChance)) {
    yield* placeDungeon(ctx, cfg, prng(mix(ctx.cx, ctx.cz, 5232, worldSeed)));
  }

  if (rollChance(ctx, worldSeed, 6337, cfg.geodeChance)) {
    yield* placeGeode(ctx, cfg, prng(mix(ctx.cx, ctx.cz, 6338, worldSeed)));
  }

  if (rollChance(ctx, worldSeed, 7457, cfg.vaultChance)) {
    yield* placeVault(ctx, cfg, prng(mix(ctx.cx, ctx.cz, 7458, worldSeed)));
  }
}

function rollChance(ctx, worldSeed, salt, chance) {
  if (!chance || chance <= 0) return false;
  return prng(mix(ctx.cx, ctx.cz, salt, worldSeed))() < chance;
}

// ===========================================================================
// チェストの中身
// ===========================================================================

/**
 * 抽選表。ダンジョン相当の品揃えに、マグナイト・アクアマリン・
 * レベル1のエンチャント本を足したもの。
 */
const LOOT = [
  { item: "minecraft:rotten_flesh", w: 90, max: 6 },
  { item: "minecraft:bone", w: 90, max: 6 },
  { item: "minecraft:string", w: 80, max: 6 },
  { item: "minecraft:gunpowder", w: 70, max: 4 },
  { item: "minecraft:wheat", w: 60, max: 4 },
  { item: "minecraft:bread", w: 50, max: 3 },
  { item: "minecraft:redstone", w: 45, max: 6 },
  { item: "cavern:raw_magnite", w: 55, max: 5 },
  { item: "cavern:aquamarine", w: 45, max: 4 },
  { item: "minecraft:iron_ingot", w: 40, max: 4 },
  { item: "minecraft:bucket", w: 18, max: 1 },
  { item: "minecraft:saddle", w: 16, max: 1 },
  { item: "minecraft:gold_ingot", w: 15, max: 3 },
  { item: "cavern:magnite_ingot", w: 20, max: 3 },
  { item: "minecraft:golden_apple", w: 8, max: 1 },
  { item: "minecraft:diamond", w: 6, max: 2 },
  { item: "cavern:hexcite", w: 2, max: 1 },
  { item: "__enchanted_book", w: 30, max: 1 },
];

const LOOT_TOTAL = LOOT.reduce((s, e) => s + e.w, 0);

/** レベル1で付けられる代表的なエンチャント */
const BOOK_ENCHANTS = [
  "protection", "sharpness", "efficiency", "unbreaking", "feather_falling",
  "fortune", "looting", "power", "respiration", "fire_aspect", "knockback",
];

function rollLoot(rand) {
  let r = rand() * LOOT_TOTAL;
  for (const e of LOOT) {
    r -= e.w;
    if (r <= 0) return { item: e.item, count: 1 + Math.floor(rand() * e.max) };
  }
  return { item: "minecraft:bone", count: 2 };
}

/**
 * チェストに中身を詰める。
 * 抽選は 4〜8 回。同じ枠に重ならないようスロットをずらす。
 */
export function fillChest(block, rand) {
  let inv;
  try {
    inv = block.getComponent("minecraft:inventory");
  } catch (e) {
    return;
  }
  if (!inv?.container) return;

  const rolls = 4 + Math.floor(rand() * 5);
  const used = new Set();

  for (let i = 0; i < rolls; i++) {
    const r = rollLoot(rand);

    let slot = Math.floor(rand() * inv.container.size);
    for (let t = 0; t < 8 && used.has(slot); t++) {
      slot = Math.floor(rand() * inv.container.size);
    }
    if (used.has(slot)) continue;
    used.add(slot);

    try {
      if (r.item === "__enchanted_book") {
        const book = new ItemStack("minecraft:enchanted_book", 1);
        const ench = book.getComponent("minecraft:enchantable");
        const type = BOOK_ENCHANTS[Math.floor(rand() * BOOK_ENCHANTS.length)];
        ench?.addEnchantment({ type, level: 1 });
        inv.container.setItem(slot, book);
      } else {
        inv.container.setItem(slot, new ItemStack(r.item, r.count));
      }
    } catch (e) {
      // 存在しないアイテムIDは無視して次へ
    }
  }
}

export { prng, mix };
