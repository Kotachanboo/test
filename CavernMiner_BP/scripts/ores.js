/**
 * 鉱石の定義・鉱脈生成・ドロップ処理
 *
 * ドロップをルートテーブルではなくスクリプトで処理している理由:
 *   - ランダマイトはそもそもルートテーブルで書けない
 *   - 後で載せる採掘ポイント / 炭鉱夫ランクも同じ playerBreakBlock に乗る
 *   - 幸運とシルクタッチの扱いを1か所に集約できる
 * 代償として、爆発や他MODによる破壊ではドロップしない。
 */

import { world, ItemStack } from "@minecraft/server";


// ===========================================================================
// 鉱石テーブル
// ===========================================================================

/**
 * オリジナル鉱石から経験値を出すか。
 * バニラの鉱石はルートテーブル側で経験値を出すのでここは関係ない。
 */
const GIVE_XP = false;

/** ツールの階層。鉱石ごとに必要な最低階層を指定する */
const TIER = {
  "minecraft:wooden_pickaxe": 1,
  "minecraft:golden_pickaxe": 1,
  "minecraft:stone_pickaxe": 2,
  "minecraft:iron_pickaxe": 3,
  "minecraft:diamond_pickaxe": 4,
  "minecraft:netherite_pickaxe": 5,
  // マグナイトはダイヤ相当の採掘階層。ここに無いとオリジナル鉱石が一切落ちない
  "cavern:magnite_pickaxe": 4,
  "cavern:aquamarine_pickaxe": 3,   // 鉄相当。ヘキサイトは掘れない
  "cavern:sunstone_pickaxe": 4,     // ダイヤ相当
  "cavern:cryolite_pickaxe": 4,     // ダイヤ相当
};

export const ORES = [
  {
    id: "cavern:aquamarine_ore",
    deepId: "cavern:deepslate_aquamarine_ore",
    drop: "cavern:aquamarine",
    dropMin: 1, dropMax: 1,
    fortune: true,
    tier: 2,                 // 石のツルハシ以上
    xp: [2, 5],
    // --- 生成 ---
    perChunk: 1.8,           // 1チャンクあたりの鉱脈数 (小数可)
    size: 6,                 // 1鉱脈のブロック数
    yLo: 0.3, yHi: 0.95,
    wallBias: 0.7,           // 洞窟の壁際に寄せる確率
  },
  {
    id: "cavern:magnite_ore",
    deepId: "cavern:deepslate_magnite_ore",
    drop: "cavern:raw_magnite",
    dropMin: 1, dropMax: 1,
    fortune: true,
    tier: 2,
    xp: [0, 2],
    perChunk: 2.8,           // 一番ありふれた鉱石。鉄の代わり
    size: 8,
    yLo: 0.05, yHi: 0.75,
    wallBias: 0.5,
  },
  {
    id: "cavern:randomite_ore",
    deepId: "cavern:deepslate_randomite_ore",
    drop: null,              // ドロップは抽選 (下の RANDOMITE_POOL)
    tier: 2,
    xp: [1, 8],
    perChunk: 0.9,
    size: 2,                 // 小さい塊でぽつぽつ
    yLo: 0.03, yHi: 0.97,
    wallBias: 0.9,           // ほぼ必ず壁際。見つけてもらうための鉱石なので
  },
  {
    id: "cavern:hexcite_ore",
    drop: "cavern:hexcite",
    dropMin: 1, dropMax: 1,
    fortune: true,
    tier: 4,                 // ダイヤのツルハシ以上
    xp: [8, 16],
    perChunk: 0.05,          // 約20チャンクに1鉱脈
    size: 3,
    yLo: 0.02, yHi: 0.2,    // 最下層のみ
    wallBias: 0.35,          // 壁際に出にくい = 掘って探す必要がある
  },
  {
    // 砂漠の洞窟だけに出る。深い層では赤い砂岩の中に埋まる
    id: "cavern:sunstone_ore",
    deepId: "cavern:red_sunstone_ore",
    drop: "cavern:sunstone",
    dropMin: 1, dropMax: 2,
    fortune: true,
    tier: 3,                 // 鉄のツルハシ以上
    xp: [3, 7],
    perChunk: 1.4,
    size: 5,
    yLo: 0.05, yHi: 0.92,
    wallBias: 0.6,
    only: ["cavern:desert_cavern"],
  },
  {
    // 氷の洞窟だけに出る。深い層では青氷の中に埋まる
    id: "cavern:cryolite_ore",
    deepId: "cavern:blue_cryolite_ore",
    drop: "cavern:cryolite",
    dropMin: 1, dropMax: 2,
    fortune: true,
    tier: 3,
    xp: [3, 7],
    perChunk: 1.4,
    size: 5,
    yLo: 0.05, yHi: 0.92,
    wallBias: 0.6,
    only: ["cavern:ice_cavern"],
  },
];

/**
 * バニラ鉱石。この配列のものはドロップをスクリプトで扱わない
 * (バニラのルートテーブルがそのまま効くので、幸運もシルクタッチも自動で正しく動く)。
 * deepId があるものは DEEPSLATE_Y より下で深層岩バリアントに切り替わる。
 */
const VANILLA_ORES = [
  {
    id: "minecraft:coal_ore", deepId: "minecraft:deepslate_coal_ore",
    perChunk: 2.1, size: 12, yLo: 0.5, yHi: 0.98, wallBias: 0.6,
  },
  {
    id: "minecraft:copper_ore", deepId: "minecraft:deepslate_copper_ore",
    perChunk: 1.8, size: 10, yLo: 0.4, yHi: 0.9, wallBias: 0.6,
  },
  {
    id: "minecraft:iron_ore", deepId: "minecraft:deepslate_iron_ore",
    perChunk: 2.75, size: 8, yLo: 0.02, yHi: 0.92, wallBias: 0.55,
  },
  {
    id: "minecraft:redstone_ore", deepId: "minecraft:deepslate_redstone_ore",
    perChunk: 2.3, size: 7, yLo: 0.02, yHi: 0.42, wallBias: 0.5,
  },
  {
    id: "minecraft:lapis_ore", deepId: "minecraft:deepslate_lapis_ore",
    perChunk: 1.0, size: 6, yLo: 0.12, yHi: 0.58, wallBias: 0.5,
  },
  {
    id: "minecraft:gold_ore", deepId: "minecraft:deepslate_gold_ore",
    perChunk: 1.2, size: 5, yLo: 0.02, yHi: 0.38, wallBias: 0.45,
  },
  {
    id: "minecraft:diamond_ore", deepId: "minecraft:deepslate_diamond_ore",
    perChunk: 0.85, size: 3, yLo: 0.02, yHi: 0.25, wallBias: 0.3,
  },
  {
    id: "minecraft:emerald_ore", deepId: "minecraft:deepslate_emerald_ore",
    perChunk: 0.5, size: 1, yLo: 0.02, yHi: 0.97, wallBias: 0.5,
  },
];

/**
 * 岩石の混ざりもの。
 * バニラの地下と同じく、石の中に大きめの塊として散らばる。
 * 鉱石より先に置くので、鉱石があれば上書きされる。
 */
const STONE_VARIANTS = [
  {
    id: "minecraft:diorite",
    perChunk: 0.8, size: 24, yLo: 0.30, yHi: 0.98, wallBias: 0.35,
  },
  {
    id: "minecraft:andesite",
    perChunk: 0.8, size: 24, yLo: 0.30, yHi: 0.98, wallBias: 0.35,
  },
  {
    id: "minecraft:granite",
    perChunk: 0.8, size: 24, yLo: 0.30, yHi: 0.98, wallBias: 0.35,
  },
  {
    // 凝灰岩は深層岩帯に出る
    id: "minecraft:tuff",
    perChunk: 0.9, size: 22, yLo: 0.02, yHi: 0.56, wallBias: 0.35,
  },
  {
    id: "minecraft:gravel",
    perChunk: 0.7, size: 18, yLo: 0.05, yHi: 0.95, wallBias: 0.45,
  },
];

/** 砂漠の洞窟の混ざりもの。砂利の代わりに砂、閃緑岩などの代わりに砂岩の仲間 */
const DESERT_VARIANTS = [
  { id: "minecraft:sand",             perChunk: 0.9, size: 22, yLo: 0.05, yHi: 0.95, wallBias: 0.5 },
  { id: "minecraft:smooth_sandstone", perChunk: 0.8, size: 22, yLo: 0.30, yHi: 0.98, wallBias: 0.35 },
  { id: "minecraft:cut_sandstone",    perChunk: 0.6, size: 18, yLo: 0.30, yHi: 0.98, wallBias: 0.35 },
  { id: "minecraft:hardened_clay",    perChunk: 0.7, size: 20, yLo: 0.05, yHi: 0.60, wallBias: 0.35 },
  { id: "minecraft:red_sand",         perChunk: 0.6, size: 18, yLo: 0.02, yHi: 0.50, wallBias: 0.5 },
];

/** 氷の洞窟の混ざりもの。粉雪は踏み抜くと沈む罠になる */
const ICE_VARIANTS = [
  { id: "minecraft:snow",        perChunk: 0.9, size: 22, yLo: 0.30, yHi: 0.98, wallBias: 0.45 },
  { id: "minecraft:ice",         perChunk: 0.8, size: 22, yLo: 0.05, yHi: 0.95, wallBias: 0.40 },
  { id: "minecraft:powder_snow", perChunk: 0.4, size: 14, yLo: 0.20, yHi: 0.90, wallBias: 0.70 },
  { id: "minecraft:calcite",     perChunk: 0.6, size: 18, yLo: 0.05, yHi: 0.60, wallBias: 0.35 },
];

/** 生成対象の全部。ドロップ処理は ORES のものだけが対象になる */
const ALL_VEINS = [...ORES, ...VANILLA_ORES];
const ALL_WITH_STONE = [...STONE_VARIANTS, ...ORES, ...VANILLA_ORES];
const ALL_WITH_DESERT = [...DESERT_VARIANTS, ...ORES, ...VANILLA_ORES];
const ALL_WITH_ICE = [...ICE_VARIANTS, ...ORES, ...VANILLA_ORES];

/** ランダマイトの抽選表。weight が大きいほど出やすい */
const RANDOMITE_POOL = [
  { item: "minecraft:coal", w: 100, max: 3 },
  { item: "minecraft:raw_iron", w: 80, max: 2 },
  { item: "minecraft:raw_copper", w: 80, max: 3 },
  { item: "minecraft:redstone", w: 70, max: 4 },
  { item: "cavern:raw_magnite", w: 60, max: 2 },
  { item: "minecraft:lapis_lazuli", w: 45, max: 4 },
  { item: "minecraft:raw_gold", w: 35, max: 2 },
  { item: "cavern:aquamarine", w: 30, max: 1 },
  { item: "minecraft:amethyst_shard", w: 25, max: 2 },
  { item: "minecraft:quartz", w: 25, max: 2 },
  { item: "minecraft:diamond", w: 8, max: 1 },
  { item: "minecraft:emerald", w: 6, max: 1 },
  { item: "cavern:hexcite", w: 1, max: 1 },
];

const RANDOMITE_TOTAL = RANDOMITE_POOL.reduce((s, e) => s + e.w, 0);

const ORE_BY_ID = new Map();
for (const o of ORES) {
  ORE_BY_ID.set(o.id, o);
  if (o.deepId) ORE_BY_ID.set(o.deepId, o);   // 深層岩バリアントも同じ扱い
}

// ===========================================================================
// 鉱脈の配置
// ===========================================================================

/** mulberry32。チャンク座標から決定論的に鉱脈を決めるためのPRNG */
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

function mix(cx, cz, salt, worldSeed) {
  let h = worldSeed | 0;
  h = Math.imul(h ^ cx, 0x27d4eb2d);
  h = Math.imul(h ^ cz, 0x85ebca6b);
  h = Math.imul(h ^ salt, 0xc2b2ae35);
  return (h ^ (h >>> 15)) >>> 0;
}

/** そこが岩で、かつ6近傍のどれかが空洞か */
function isExposed(ctx, x, y, z) {
  if (!ctx.isSolid(x, y, z)) return false;
  return !ctx.isSolid(x + 1, y, z) || !ctx.isSolid(x - 1, y, z) ||
         !ctx.isSolid(x, y + 1, z) || !ctx.isSolid(x, y - 1, z) ||
         !ctx.isSolid(x, y, z + 1) || !ctx.isSolid(x, y, z - 1);
}

/**
 * 1チャンク分の鉱脈を置く。
 *
 * @param {object} ctx
 *   place(wx, wy, wz, blockId) : ブロックを置く
 *   isSolid(wx, wy, wz)        : そこが岩か (チャンク外は false でよい)
 *   x0, z0                     : チャンクの原点
 *   cx, cz                     : チャンク座標
 *   wallSpots                  : 洞窟の壁の座標を [x,y,z,x,y,z,...] で平坦に並べた配列
 *   worldSeed                  : ワールドのシード
 *   yMin, yMax                 : 生成可能な高さ
 */
/**
 * 設置をまとめるための入れ物。
 * 酔歩で置くと同じ列の縦方向に連続することが多く、まとめると約2割減る。
 */
function flushBatch(ctx, batch) {
  for (const [key, ys] of batch) {
    const sep = key.lastIndexOf("|");
    const id = key.slice(sep + 1);
    const [x, z] = key.slice(0, sep).split(",").map(Number);
    ys.sort((a, b) => a - b);
    let start = ys[0], prev = ys[0];
    for (let i = 1; i <= ys.length; i++) {
      if (i < ys.length && ys[i] === prev + 1) { prev = ys[i]; continue; }
      ctx.place(x, start, z, id, prev);
      if (i < ys.length) { start = ys[i]; prev = ys[i]; }
    }
  }
  batch.clear();
}

export function* placeVeins(ctx) {
  const batch = new Map();
  const put = (x, y, z, id) => {
    const k = `${x},${z}|${id}`;
    let a = batch.get(k);
    if (!a) { a = []; batch.set(k, a); }
    a.push(y);
  };
  // 岩石を混ぜる設定なら、鉱石より先に置いて土台にする
  const veins = ctx.stoneVariants === "desert" ? ALL_WITH_DESERT
              : ctx.stoneVariants === "ice" ? ALL_WITH_ICE
              : ctx.stoneVariants ? ALL_WITH_STONE : ALL_VEINS;

  for (let oi = 0; oi < veins.length; oi++) {
    const ore = veins[oi];
    // そのディメンション限定の鉱石
    if (ore.only && !ore.only.includes(ctx.dimId)) continue;
    const rand = prng(mix(ctx.cx, ctx.cz, oi * 7919 + 13, ctx.worldSeed));

    // 小数の鉱脈数を確率で解決する。ディメンションごとの倍率をここで掛ける
    const per = ore.perChunk * (ctx.multiplier ?? 1);
    let count = Math.floor(per);
    if (rand() < per - count) count++;

    // 高さは生成帯に対する割合で持つ。絶対座標にすると
    // ディメンションの高さが変わったとき鉱石がまるごと消える
    const span = ctx.yMax - ctx.yMin;
    const lo = Math.max(ctx.yMin + 1, Math.round(ctx.yMin + span * ore.yLo));
    const hi = Math.min(ctx.yMax - 1, Math.round(ctx.yMin + span * ore.yHi));
    if (hi <= lo) continue;

    for (let v = 0; v < count; v++) {
      // --- 起点を選ぶ ---
      // 洞窟の壁は地形生成時に列挙済み (ctx.wallSpots)。
      // ランダムに座標を振って壁を探すと、岩だらけの世界ではまず当たらない。
      let sx, sy, sz;
      const wantWall = rand() < ore.wallBias;
      const spots = ctx.wallSpots;

      if (wantWall && spots && spots.length > 0) {
        let ok = false;
        for (let t = 0; t < 8 && !ok; t++) {
          const i = Math.floor(rand() * spots.length) * 3;
          sx = spots[i]; sy = spots[i + 1]; sz = spots[i + 2];
          ok = sy >= lo && sy <= hi;
        }
        if (!ok) continue;
      } else {
        let ok = false;
        for (let t = 0; t < 4 && !ok; t++) {
          sx = ctx.x0 + Math.floor(rand() * 16);
          sz = ctx.z0 + Math.floor(rand() * 16);
          sy = lo + Math.floor(rand() * (hi - lo + 1));
          ok = ctx.isSolid(sx, sy, sz);
        }
        if (!ok) continue;
      }

      // --- 酔歩でブロックを伸ばす ---
      // 壁際の鉱脈は、岩の奥へ潜り込んだら露出済みの位置へ戻す。
      // これをしないと鉱脈のほとんどが壁の内側に隠れてしまう。
      const placed = [];
      let px = sx, py = sy, pz = sz;

      for (let i = 0; i < ore.size; i++) {
        if (ctx.isSolid(px, py, pz)) {
          // 遷移帯では母岩に合わせる。列ごとの深層岩の高さを見る
          let deep = false;
          if (ore.deepId) {
            const top = ctx.deepslateY + (ctx.blendTop ? ctx.blendTop(px, pz) : 0);
            deep = py <= top;
          }
          const id = deep ? ore.deepId : ore.id;
          put(px, py, pz, id);
          placed.push(px, py, pz);
        }

        const d = Math.floor(rand() * 6);
        if (d === 0) px++; else if (d === 1) px--;
        else if (d === 2) pz++; else if (d === 3) pz--;
        else if (d === 4) py++; else py--;

        if (py < lo || py > hi) py = sy;

        if (wantWall && placed.length > 0 && !isExposed(ctx, px, py, pz)) {
          if (rand() < 0.75) {
            const j = Math.floor(rand() * (placed.length / 3)) * 3;
            px = placed[j]; py = placed[j + 1]; pz = placed[j + 2];
          }
        }
      }
    }

    // 種類ごとにまとめて置いてから譲る
    flushBatch(ctx, batch);
    yield;
  }
}

// ===========================================================================
// ドロップ
// ===========================================================================

function toolInfo(player) {
  try {
    const eq = player.getComponent("minecraft:equippable");
    const stack = eq?.getEquipment("Mainhand");
    if (!stack) return { tier: 0, fortune: 0, silk: false, id: null };

    let fortune = 0, silk = false;
    try {
      const ench = stack.getComponent("minecraft:enchantable");
      if (ench) {
        for (const e of ench.getEnchantments()) {
          if (e.type.id === "fortune") fortune = e.level;
          else if (e.type.id === "silk_touch") silk = true;
        }
      }
    } catch (e) { /* 付呪コンポーネントが無いツール */ }

    return { tier: TIER[stack.typeId] ?? 0, fortune, silk, id: stack.typeId };
  } catch (e) {
    return { tier: 0, fortune: 0, silk: false, id: null };
  }
}

function rollRandomite() {
  let r = Math.random() * RANDOMITE_TOTAL;
  for (const e of RANDOMITE_POOL) {
    r -= e.w;
    if (r <= 0) return { item: e.item, count: 1 + Math.floor(Math.random() * e.max) };
  }
  return { item: "minecraft:coal", count: 1 };
}

/** 幸運: 1/(level+2) の確率で等倍、そうでなければ 2〜level+1 倍 (バニラ準拠) */
function fortuneMultiply(base, level) {
  if (level <= 0) return base;
  const r = Math.floor(Math.random() * (level + 2));
  return r <= 1 ? base : base * r;
}

function drop(dimension, loc, itemId, count) {
  try {
    dimension.spawnItem(new ItemStack(itemId, count), loc);
  } catch (e) {
    console.warn(`[CavernMiner] drop failed ${itemId}: ${e}`);
  }
}

export function registerOreDrops() {
  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    const ore = ORE_BY_ID.get(ev.brokenBlockPermutation.type.id);
    if (!ore) return;

    const player = ev.player;
    if (player.getGameMode?.() === "creative") return;

    const tool = toolInfo(player);
    const loc = {
      x: ev.block.location.x + 0.5,
      y: ev.block.location.y + 0.5,
      z: ev.block.location.z + 0.5,
    };
    const dim = ev.dimension;

    // 階層不足: 何も落ちない
    if (tool.tier < ore.tier) return;

    // シルクタッチ: 壊したブロックそのもの (深層岩バリアントならそちら)
    if (tool.silk) {
      drop(dim, loc, ev.brokenBlockPermutation.type.id, 1);
      return;
    }

    if (ore.drop === null) {   // ランダマイト
      const n = 1 + (tool.fortune > 0 && Math.random() < 0.35 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const r = rollRandomite();
        drop(dim, loc, r.item, r.count);
      }
    } else {
      const base = ore.dropMin + Math.floor(Math.random() * (ore.dropMax - ore.dropMin + 1));
      const n = ore.fortune ? fortuneMultiply(base, tool.fortune) : base;
      drop(dim, loc, ore.drop, n);
    }

    // 経験値
    if (GIVE_XP && ore.xp) {
      const amount = ore.xp[0] + Math.floor(Math.random() * (ore.xp[1] - ore.xp[0] + 1));
      if (amount > 0) {
        try { player.addExperience(amount); } catch (e) { /* noop */ }
      }
    }
  });
}
