/**
 * 洞窟採掘記 ～Cavern Miner～
 * 洞窟ディメンションの生成
 *
 * 設計:
 *   - registerCustomDimension は void 生成器しか作らないので、地形は全部スクリプトで彫る
 *   - 洞窟の形: 2枚のノイズのゼロ交差帯の交差 (トンネル) + 低周波ノイズ (大空洞)
 *   - 設置: 列ごとに「連続した空洞区間 = ラン」を求め、fillBlocks でまとめて抜く
 *   - ディメンションごとの違いは dimensions.js の設定だけで表現する
 */

import { world, system, BlockVolume, BlockPermutation, ItemStack,
         InputPermissionCategory } from "@minecraft/server";
import { DIMENSIONS, isCaveDimension, DEFAULT_DIM, SEED } from "./dimensions.js";
import { placeVeins, registerOreDrops } from "./ores.js";
import { registerMiner, showStatus, getRank, setRank, RANKS } from "./miner.js";
import { registerAssist, showAssist } from "./assist.js";
import { registerPortal, setTravelHandlers, saveReturn, loadReturn,
         buildReturnPortal, restorePortals } from "./portal.js";
import { registerMusic, skipTrack } from "./music.js";
import { registerAquamarine } from "./aquamarine.js";
import { placeStructures, fillChest, prng, mix } from "./structures.js";

// ===========================================================================
// 全体設定
// ===========================================================================

/** 進行状況や内部事情をチャットに出すか。不具合を追うときだけ true */
const VERBOSE = false;

/** 入場時にバニラの音楽を止める */
const SILENCE_MUSIC = true;

/** 専用BGMを流す */
const MUSIC = true;

/**
 * プレイヤー周辺の何チャンクを生成するか。
 *
 * 生成するチャンク数は円内でおよそ (2r+1)^2 * 0.8、
 * 強制ロードする範囲は (2*(r+AREA_MARGIN)+1)^2 チャンク。
 *   r=2 → 生成13 / ロード25    安全だが視界が狭い
 *   r=4 → 生成49 / ロード121   これくらいが見た目と負荷の釣り合いが取れる
 *   r=4 + 余白3 → ロード225    広すぎてロードが追いつかない (一度失敗した設定)
 *
 * 飛ばされるチャンクが増えるようならここを下げる。
 */
const GEN_RADIUS = 4;

/**
 * tickingarea を生成範囲より何チャンク広く取るか。
 * 強制ロードは (2*(genRadius+AREA_MARGIN)+1)^2 チャンクになる。
 * 225 を超えるとロードが追いつかなくなった実績があるので、そこが上限の目安。
 */
const AREA_MARGIN = 1;

/** 進行方向へ何チャンク先読みするか。AREA_MARGIN を超えないこと */
const LOOK_AHEAD = 3;

/** そのディメンションの生成範囲 */
function radiusOf(st) {
  return st.cfg.genRadius ?? GEN_RADIUS;
}

/**
 * 暇なときに先回りして作る範囲。
 *
 * 追従型のまま「要求される前に作っておく」ための仕組み。
 * スポーン中心に渦巻きで作る方式は、半径の2乗で増えるうえ
 * プレイヤーが遠出すると永久に追いつかないので採らない。
 * プレイヤーの周りを外へ広げていき、離れたら作り直す。
 */
const PRE_RADIUS_MAX = 7;

/** ポーリング間隔 (tick) */
const SCAN_INTERVAL = 10;

/** 生成キューの上限 */
const QUEUE_LIMIT = 256;

/**
 * 生成の互換バージョン。帯や密度式を変えたらここを上げる。
 * 値が変わると「生成済み」の記録を捨てて作り直す。
 */
const GEN_VERSION = 6;

/** バッファが確保する最大の高さ */
const MAX_H = 400;

const SW = 18;     // 16 + 左右1マスの余白
const PAD = 1;

const BLOCK_AIR = "minecraft:air";

function note(player, msg) {
  if (VERBOSE) player.sendMessage(msg);
}

/**
 * 生成を飛ばしたチャンクの報告。
 * 1件ずつ出すとログが流れて他が読めなくなるので、まとめて数える。
 */
let skipCount = 0;
let skipLast = "";
let skipTimer = null;

function reportSkip(cx, cz, why) {
  skipCount++;
  skipLast = `${cx},${cz} (${why})`;
  if (skipTimer !== null) return;
  skipTimer = system.runTimeout(() => {
    skipTimer = null;
    if (skipCount > 0) {
      console.warn(`[CavernMiner] 生成を飛ばしたチャンク: ${skipCount}件 直近 ${skipLast}`);
      skipCount = 0;
    }
  }, 200);
}

// ===========================================================================
// ノイズ
// ===========================================================================

function hash3(ix, iy, iz) {
  let h = SEED | 0;
  h = Math.imul(h ^ (ix | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (iy | 0), 0x85ebca6b);
  h = Math.imul(h ^ (iz | 0), 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return ((h >>> 0) / 2147483647.5) - 1;
}

function fade(t) { return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }

function valueNoise3(x, y, z, salt) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const sx = ix + salt * 8191;

  const x00 = lerp(hash3(sx, iy, iz),         hash3(sx + 1, iy, iz),         fx);
  const x10 = lerp(hash3(sx, iy + 1, iz),     hash3(sx + 1, iy + 1, iz),     fx);
  const x01 = lerp(hash3(sx, iy, iz + 1),     hash3(sx + 1, iy, iz + 1),     fx);
  const x11 = lerp(hash3(sx, iy + 1, iz + 1), hash3(sx + 1, iy + 1, iz + 1), fx);

  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

function fractal3(x, y, z, salt) {
  return valueNoise3(x, y, z, salt) * 0.68
       + valueNoise3(x * 2.13, y * 2.13, z * 2.13, salt + 100) * 0.32;
}

// ===========================================================================
// ディメンションごとの実行時状態
// ===========================================================================

/**
 * 設定は dimensions.js、可変な状態はここ。
 * 記録のキーも含めてディメンションごとに分けておかないと、
 * 2つ目を足した瞬間に「生成済みなのに空っぽ」が起きる。
 */
class DimState {
  constructor(cfg) {
    this.cfg = cfg;
    this.field = cfg.field;
    this.blocks = cfg.blocks;

    this.resolved = false;
    this.yMin = -64;
    this.yMax = 63;
    this.h = 128;
    this.deepslateY = 0;

    this.areaChunk = null;

    this.regionCache = new Map();
  }
}

const STATES = new Map(DIMENSIONS.map((c) => [c.id, new DimState(c)]));

function stateOf(id) { return STATES.get(id) ?? null; }

/**
 * 作業用バッファ。
 *
 * 参考にしたアドオンはチャンクごとに独立した runJob を起動して
 * 複数本を同時に走らせていた。こちらもそうしたいが、バッファを
 * 共有したまま同時に走らせると踏み合って地形が壊れる。
 * ジョブの本数ぶん用意して、1本ずつ貸し出す。
 */
const WORKERS = 4;

const bufPool = [];
for (let i = 0; i < WORKERS; i++) {
  bufPool.push({
    a: new Uint8Array(SW * SW * MAX_H),
    b: new Uint8Array(SW * SW * MAX_H),
    busy: false,
  });
}

function takeBuffer() {
  for (const s of bufPool) {
    if (!s.busy) { s.busy = true; return s; }
  }
  return null;
}


// ===========================================================================
// 密度
// ===========================================================================

function columnContext(st, wx, wz) {
  const F = st.field;
  let t = F.threshold;
  if (F.varyAmount !== 0) {
    const n = fractal3(wx / F.varyScale, 0, wz / F.varyScale, 9);
    t += (n > 0 ? n : 0) * F.varyAmount;   // 広げる方向にだけ効かせる
  }
  return t;
}

function density(st, wx, wy, wz, localT) {
  const F = st.field;

  let clamp = 0;
  const dTop = wy - (st.yMax - F.ceilMargin);
  if (dTop > 0) clamp -= dTop * F.ceilStrength;
  const dBot = (st.yMin + F.floorMargin) - wy;
  if (dBot > 0) clamp -= dBot * F.floorStrength;
  if (clamp <= -0.5) return -1;

  const bias = (st.deepslateY - wy) * F.depthBias;

  const c = valueNoise3(
    wx / F.chamberScale,
    wy / (F.chamberScale * F.chamberSquash),
    wz / F.chamberScale, 7);
  let d = (c - F.chamberThreshold) * F.chamberWeight;

  const nx = wx / F.scaleXZ;
  const ny = wy / F.scaleY;
  const nz = wz / F.scaleXZ;
  const a1 = Math.abs(fractal3(nx, ny, nz, 1));
  if (a1 < localT) {
    const a2 = Math.abs(fractal3(nx, ny, nz, 2));
    const tunnel = localT - (a1 > a2 ? a1 : a2);
    if (tunnel > d) d = tunnel;
  }

  return d + bias + clamp;
}

// ===========================================================================
// 深層岩の遷移帯
// ===========================================================================

const BLEND = 8;
const BLEND_WAVE = 6;
const BLEND_SCALE = 46;

function blendTop(wx, wz) {
  const wave = fractal3(wx / BLEND_SCALE, 0, wz / BLEND_SCALE, 11) * BLEND_WAVE;
  const r = (hash3(wx, 7777, wz) + 1) / 2;
  const dither = Math.floor(r * (BLEND + 1)) - 1;
  return Math.round(wave) + dither;
}

// ===========================================================================
// 流体
// ===========================================================================

/**
 * 溶岩面の高さ。
 * 岩盤の近くは常に溶岩。加えて中層にも溶岩の一帯を置く。
 */
function lavaTop(st, wx, wz) {
  const f = st.cfg.fluids;
  if (!f) return -Infinity;

  const n = fractal3(wx / f.lavaScale, 0, wz / f.lavaScale, 21);
  let top = st.yMin + f.lavaDepth + Math.round(n * f.lavaWave);

  if (f.lavaPocketScale) {
    const r = fractal3(wx / f.lavaPocketScale, 0, wz / f.lavaPocketScale, 24);
    if (r > f.lavaPocketThreshold) {
      const w = fractal3(wx / 36, 0, wz / 36, 25);
      const pocket = st.yMin + Math.round(st.h * f.lavaPocketLevel)
                   + Math.round(w * f.lavaPocketWave);
      if (pocket > top) top = pocket;
    }
  }
  return top;
}

/** 水面の高さ。地帯ごとに水没していたりいなかったりする */
function waterTop(st, wx, wz) {
  const f = st.cfg.fluids;
  if (!f) return -Infinity;
  const region = fractal3(wx / f.waterRegionScale, 0, wz / f.waterRegionScale, 22);
  if (region < f.waterRegionThreshold) return -Infinity;
  const n = fractal3(wx / 40, 0, wz / 40, 23);
  return st.yMin + Math.round(st.h * f.waterLevel) + Math.round(n * f.waterWave);
}

/**
 * 洞窟の床に溜まる溶岩。
 *
 * 「一定の高さより下は全部溶岩」だけだと、そこまで掘り下げないと
 * 出会えない。バニラの洞窟のように、床のくぼみに溜まり場を作る。
 * 深いほど出やすい。
 */
function lavaPuddle(st, wx, wy, wz) {
  const f = st.cfg.fluids;
  if (!f || !f.puddleChance) return false;

  // 深さに応じて確率を上げる (0 = 帯の上端 / 1 = 下端)
  const depth = 1 - (wy - st.yMin) / st.h;
  const chance = f.puddleChance * (0.25 + depth * 1.75);

  // 位置から決まる乱数。塊になるよう低周波ノイズで地帯を絞る
  const region = fractal3(wx / (f.puddleScale ?? 70), 0, wz / (f.puddleScale ?? 70), 31);
  if (region < (f.puddleRegion ?? 0.1)) return false;

  return ((hash3(wx, 5150, wz) + 1) / 2) < chance;
}

/** 流体の縁を塞ぐ岩の目印。置くときに石か深層岩へ置き換える */
const BARRIER = "#barrier";

/**
 * 空洞のそのマスに入るブロック (隣の列を見ない素の判定)。
 *
 * 水と溶岩の間は空気ではなく岩で仕切る。以前は空気を空けていたが、
 * 水が空気の上に乗る形になり、流れ落ちて溶岩と触れていた。
 */
function fluidAt(st, y, lava, water) {
  if (y <= lava) return "minecraft:lava";
  const f = st.cfg.fluids;
  const clearance = f?.lavaClearance ?? 3;
  if (water > -Infinity && y <= water) {
    // 氷の洞窟では水の代わりに氷で満たす (凍った湖)
    if (y > lava + clearance) return f?.waterBlock ?? "minecraft:water";
    // 溶岩面のすぐ上。この上に水があるなら岩の層にする
    if (water > lava + clearance) return BARRIER;
  }
  return BLOCK_AIR;
}

/** 流れる流体か。氷など流れないものは縁を塞がなくてよい */
function isFlowing(block) {
  return block === "minecraft:lava" || block === "minecraft:water";
}

// ===========================================================================
// 生成済みビットマップ
// ===========================================================================

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REGION_SHIFT = 5;
const REGION_CHUNKS = 1 << REGION_SHIFT;
const REGION_CHARS = Math.ceil((REGION_CHUNKS * REGION_CHUNKS) / 6);

function regionKey(st, cx, cz) {
  return `${st.cfg.short}:${cx >> REGION_SHIFT},${cz >> REGION_SHIFT}`;
}

function readBits(st, key) {
  let arr = st.regionCache.get(key);
  if (arr) return arr;
  const raw = world.getDynamicProperty(key);
  arr = (typeof raw === "string" && raw.length === REGION_CHARS)
    ? raw.split("")
    : new Array(REGION_CHARS).fill("A");
  st.regionCache.set(key, arr);
  return arr;
}

/** 地形の記録と同じ領域の、構造物の記録のキー ("rc:1,2" → "rc:d:1,2") */
function decoKeyOf(terrainKey) {
  const i = terrainKey.indexOf(":");
  return `${terrainKey.slice(0, i)}:d:${terrainKey.slice(i + 1)}`;
}

function loadRegion(st, key) {
  const cached = st.regionCache.get(key);
  if (cached) return cached;
  const arr = readBits(st, key);
  // 構造物の記録が無い領域は、構造物を後回しにする前の版で作られたもの。
  // そこで生成済みのチャンクは構造物も置き済みなので、同じ内容で記録を作る。
  // 地形の記録を初めて読むこの時点なら、まだ今の版では何も生成していない。
  const dk = decoKeyOf(key);
  if (world.getDynamicProperty(dk) === undefined) {
    world.setDynamicProperty(dk, arr.join(""));
  }
  return arr;
}

function bitIndex(cx, cz) {
  const lx = ((cx % REGION_CHUNKS) + REGION_CHUNKS) % REGION_CHUNKS;
  const lz = ((cz % REGION_CHUNKS) + REGION_CHUNKS) % REGION_CHUNKS;
  return lz * REGION_CHUNKS + lx;
}

function isGenerated(st, cx, cz) {
  const arr = loadRegion(st, regionKey(st, cx, cz));
  const bi = bitIndex(cx, cz);
  return (B64.indexOf(arr[Math.floor(bi / 6)]) & (1 << (bi % 6))) !== 0;
}

function markGenerated(st, cx, cz) {
  const key = regionKey(st, cx, cz);
  const arr = loadRegion(st, key);
  const bi = bitIndex(cx, cz);
  const ci = Math.floor(bi / 6);
  arr[ci] = B64[B64.indexOf(arr[ci]) | (1 << (bi % 6))];
  world.setDynamicProperty(key, arr.join(""));
}

/** 構造物を置き終えたか */
function isDecorated(st, cx, cz) {
  const key = regionKey(st, cx, cz);
  loadRegion(st, key);   // 旧版の記録からの引き継ぎを先に済ませる
  const arr = readBits(st, decoKeyOf(key));
  const bi = bitIndex(cx, cz);
  return (B64.indexOf(arr[Math.floor(bi / 6)]) & (1 << (bi % 6))) !== 0;
}

function markDecorated(st, cx, cz) {
  const key = regionKey(st, cx, cz);
  loadRegion(st, key);
  const dk = decoKeyOf(key);
  const arr = readBits(st, dk);
  const bi = bitIndex(cx, cz);
  const ci = Math.floor(bi / 6);
  arr[ci] = B64[B64.indexOf(arr[ci]) | (1 << (bi % 6))];
  world.setDynamicProperty(dk, arr.join(""));
}

const PROP_SIGNATURE = "gc:signature";   // 旧形式 (全ディメンション共通)

/**
 * 生成記録の署名はディメンションごとに持つ。
 *
 * 以前は全ディメンションを1つの署名にまとめていたため、ディメンションを
 * 1つ足しただけで既存の記録が全部破棄され、再訪時に作り直されて
 * プレイヤーの建築が消える恐れがあった。
 */
function sigKey(c) { return `cavern:sig_${c.short}`; }
function sigOf(c) { return `v${GEN_VERSION}|${c.short}${c.bandHeight}|${SEED}`; }

/** 旧形式の署名にこのディメンションが同条件で含まれていれば、一致とみなす */
function legacyMatches(c) {
  const legacy = world.getDynamicProperty(PROP_SIGNATURE);
  if (typeof legacy !== "string") return false;
  const [v, parts, seed] = legacy.split("|");
  return v === `v${GEN_VERSION}` && seed === String(SEED)
      && (parts ?? "").split(",").includes(`${c.short}${c.bandHeight}`);
}

function checkSignature() {
  for (const c of DIMENSIONS) {
    const want = sigOf(c);
    let cur = world.getDynamicProperty(sigKey(c));
    if (cur === undefined && legacyMatches(c)) cur = want;   // 旧形式から引き継ぐ

    if (cur === undefined || cur === want) {
      // 新しいディメンション、または変化なし。記録はそのまま
      world.setDynamicProperty(sigKey(c), want);
      continue;
    }

    // このディメンションの生成条件だけが変わった。その記録だけ破棄する
    let cleared = 0;
    try {
      for (const id of world.getDynamicPropertyIds()) {
        if (id === PROP_SIGNATURE) continue;   // 旧署名は移行判定に使うので残す
        if (id.startsWith(`${c.short}:`)) { world.setDynamicProperty(id, undefined); cleared++; }
      }
    } catch (e) {
      console.warn(`[CavernMiner] 記録の破棄に失敗: ${e}`);
    }
    stateOf(c.id)?.regionCache.clear();
    world.setDynamicProperty(sigKey(c), want);
    console.warn(`[CavernMiner] ${c.name}: 生成設定が変わったため記録を破棄 (${cleared}件) → ${want}`);
  }
}

// ===========================================================================
// ディメンションの取得と高さの確定
// ===========================================================================

export function caveDim(id) {
  const st = stateOf(id);
  if (!st) return null;

  let dim;
  try {
    dim = world.getDimension(id);
  } catch (e) {
    console.warn(`[CavernMiner] getDimension failed (${id}): ${e}`);
    return null;
  }

  if (!st.resolved) {
    st.resolved = true;
    let min = -64, max = 63, source = "既定値";
    try {
      const r = dim.heightRange;
      if (r && typeof r.min === "number" && typeof r.max === "number") {
        min = r.min;
        max = r.max - 1;
        source = "heightRange";
      }
    } catch (e) {
      console.warn(`[CavernMiner] heightRange 取得エラー: ${e}`);
    }

    // 帯の厚みは固定。丸ごと使うと1チャンクの仕事が膨れて生成が追いつかない。
    // BP/dimensions/*.json の dimension_height を同じ値にしてあるので、
    // 正しく読めていれば切り詰めは発生しない。
    const before = max;
    max = Math.min(max, min + st.cfg.bandHeight - 1);
    if (before !== max) {
      console.warn(`[CavernMiner] ${st.cfg.name}: 生成帯を ${before} から ${max} に切り詰め`);
    }
    if (max - min + 1 > MAX_H) max = min + MAX_H - 1;

    st.yMin = min;
    st.yMax = max;
    st.h = max - min + 1;
    st.deepslateY = min + Math.floor(st.h * st.cfg.deepslateAt);

    console.warn(`[CavernMiner] ${st.cfg.name}: 生成帯 ${min}..${max} (${st.h}ブロック, ${source}) / 深層岩境界 ${st.deepslateY}`);
    checkSignature();
  }

  return dim;
}

// ===========================================================================
// ブロック設置
// ===========================================================================

let lastFillError = null;

function fillSafe(st, dim, x1, y1, z1, x2, y2, z2, block) {
  if (y2 < st.yMin || y1 > st.yMax) return false;
  if (y1 < st.yMin) y1 = st.yMin;
  if (y2 > st.yMax) y2 = st.yMax;
  try {
    dim.fillBlocks(new BlockVolume({ x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 }), block);
    return true;
  } catch (e) {
    lastFillError = `${e}`;
    return false;
  }
}

function setSafe(st, dim, x, y, z, block) {
  if (y < st.yMin || y > st.yMax) return false;
  try {
    dim.getBlock({ x, y, z })?.setType(block);
    return true;
  } catch (e) {
    return false;
  }
}

// ===========================================================================
// チャンクのロード待ちと検証
// ===========================================================================

function* waitForChunk(st, dim, x, z, maxTicks) {
  const y = Math.floor((st.yMin + st.yMax) / 2);
  const start = system.currentTick;
  while (system.currentTick - start < maxTicks) {
    try {
      if (dim.getBlock({ x, y, z })) return true;
    } catch (e) { /* まだロードされていない */ }
    yield;
  }
  return false;
}

const VERIFY_SPOTS = [[1, 1], [8, 8], [14, 14], [3, 12], [12, 3]];

/**
 * 母岩が入っているかを確かめる。
 *
 * isSolid を渡さないときは母岩を埋めた直後とみなし、16段ごとの全層で
 * 全点が埋まっていることを求める。fillBlocks は層ごとに失敗しうるので、
 * 中央の1層だけでは「一部の層だけ空っぽ」のチャンクを見逃していた。
 *
 * isSolid を渡したときは彫ったあとの確認で、岩のはずの点だけを見る。
 * 以前は中央の高さの3点が全部空気だと「消失」と判定していたが、
 * 大きな空洞がちょうどそこを通るチャンクでは毎回そうなる。
 * 記録されないまま作り直しを繰り返し、そこに立つプレイヤーは
 * 凍結されたままになっていた。
 * ジオードや部屋も岩を抜くので、彫ったあとは半分以上が残っていれば良しとする。
 * アンロードで消えたときはほぼ全点が空気になる。
 */
function verifyFilled(st, dim, x0, z0, isSolid) {
  let checked = 0, missing = 0;
  for (let y = st.yMin + 1; y < st.yMax; y += 16) {
    for (const [dx, dz] of VERIFY_SPOTS) {
      const x = x0 + dx, z = z0 + dz;
      if (isSolid && !isSolid(x, y, z)) continue;
      checked++;
      try {
        const b = dim.getBlock({ x, y, z });
        if (!b || b.typeId === BLOCK_AIR) missing++;
      } catch (e) {
        missing++;
      }
    }
  }
  if (!isSolid) return missing === 0;
  // 岩のはずの点が1つも無いことはまず無いが、そのときは確かめようがない
  return checked === 0 || missing * 2 <= checked;
}

// ===========================================================================
// 密度をバッファに書く
// ===========================================================================

function* fillDensity(st, buf, x0, z0) {
  const step = Math.max(1, st.field.sampleStep | 0);
  if (step === 1) yield* fillDensityExact(st, buf, x0, z0);
  else yield* fillDensityInterpolated(st, buf, x0, z0, step);
}

function* fillDensityExact(st, buf, x0, z0) {
  for (let lx = 0; lx < SW; lx++) {
    const wx = x0 - PAD + lx;
    for (let lz = 0; lz < SW; lz++) {
      const wz = z0 - PAD + lz;
      const localT = columnContext(st, wx, wz);
      const base = (lx * SW + lz) * MAX_H;
      for (let y = st.yMin; y <= st.yMax; y++) {
        buf.a[base + (y - st.yMin)] = density(st, wx, y, wz, localT) > 0 ? 1 : 0;
      }
    }
  }
  yield;   // 工程の切れ目でだけ譲る
}

/** 粗いグリッドで評価して三線形補間する。バニラの地形生成と同じ考え方 */
function* fillDensityInterpolated(st, buf, x0, z0, step) {
  const gxz = Math.floor((SW - 1) / step) + 2;
  const gy = Math.floor((st.h - 1) / step) + 2;
  const grid = new Float32Array(gxz * gxz * gy);

  for (let i = 0; i < gxz; i++) {
    const wx = x0 - PAD + i * step;
    for (let j = 0; j < gxz; j++) {
      const wz = z0 - PAD + j * step;
      const localT = columnContext(st, wx, wz);
      const base = (i * gxz + j) * gy;
      for (let k = 0; k < gy; k++) {
        grid[base + k] = density(st, wx, st.yMin + k * step, wz, localT);
      }
    }
  }
  yield;

  const inv = 1 / step;
  for (let lx = 0; lx < SW; lx++) {
    const i = Math.floor(lx / step);
    const fx = (lx - i * step) * inv;
    for (let lz = 0; lz < SW; lz++) {
      const j = Math.floor(lz / step);
      const fz = (lz - j * step) * inv;
      const out = (lx * SW + lz) * MAX_H;

      const b00 = (i * gxz + j) * gy;
      const b10 = ((i + 1) * gxz + j) * gy;
      const b01 = (i * gxz + (j + 1)) * gy;
      const b11 = ((i + 1) * gxz + (j + 1)) * gy;

      for (let y = 0; y < st.h; y++) {
        const k = Math.floor(y / step);
        const fy = (y - k * step) * inv;

        const c00 = grid[b00 + k]     + (grid[b10 + k]     - grid[b00 + k])     * fx;
        const c10 = grid[b01 + k]     + (grid[b11 + k]     - grid[b01 + k])     * fx;
        const c01 = grid[b00 + k + 1] + (grid[b10 + k + 1] - grid[b00 + k + 1]) * fx;
        const c11 = grid[b01 + k + 1] + (grid[b11 + k + 1] - grid[b01 + k + 1]) * fx;
        const c0 = c00 + (c10 - c00) * fz;
        const c1 = c01 + (c11 - c01) * fz;

        buf.a[out + y] = (c0 + (c1 - c0) * fy) > 0 ? 1 : 0;
      }
    }
  }
  yield;
}

/**
 * 多数決フィルタ。
 * 浮き岩と1マスの空気ポケットを消す。床の段差はほぼ変わらない (実測)。
 */
function* smoothPass(st, buf) {
  buf.b.set(buf.a);
  const N = st.field.smoothNeighbors;
  const idx = (lx, lz, y) => (lx * SW + lz) * MAX_H + (y - st.yMin);

  for (let lx = PAD; lx < SW - PAD; lx++) {
    for (let lz = PAD; lz < SW - PAD; lz++) {
      for (let y = st.yMin + 1; y < st.yMax; y++) {
        const i = idx(lx, lz, y);
        const here = buf.a[i];

        let air = 0;
        if (buf.a[idx(lx - 1, lz, y)]) air++;
        if (buf.a[idx(lx + 1, lz, y)]) air++;
        if (buf.a[idx(lx, lz - 1, y)]) air++;
        if (buf.a[idx(lx, lz + 1, y)]) air++;

        if (here === 0) {
          if (air >= N && buf.a[i + 1]) buf.b[i] = 1;
        } else {
          if ((4 - air) >= N && buf.a[i - 1] === 0) buf.b[i] = 0;
        }
      }
    }
  }
  yield;
}

// ===========================================================================
// 母岩
// ===========================================================================

/**
 * 母岩で置き換えてよいもの。
 *
 * 空気に加えて流体も含める。先に生成した隣のチャンクの溶岩や水は、
 * 生成前の空っぽのチャンクへ流れ込んで底まで落ちる。空気だけを埋めると
 * それが岩の中に残り、彫らない場所に溶岩が浮いて見えていた。
 * 生成をやり直すときに、前回置いた流体を消す役目もある。
 * 隣のチャンクが正当に置く流体がこのチャンクの中にあることは無い。
 */
const REPLACEABLE = [
  "minecraft:air",
  "minecraft:lava", "minecraft:flowing_lava",
  "minecraft:water", "minecraft:flowing_water",
];

/**
 * 空気 (と流れ込んだ流体) の場所だけを埋める。
 *
 * 隣のチャンクで生成したジオードや部屋は、このチャンクへはみ出すことがある。
 * チャンクを丸ごと埋めると、そのはみ出した部分を石で塗りつぶして壊してしまう
 * (ジオードの芽だけ宙に残る、といった形で現れていた)。
 * 生成前のチャンクは空気なので、空気だけを埋めれば結果は同じで、
 * 既に置かれたものは残る。
 */
function fillAirOnly(st, dim, x1, y1, z1, x2, y2, z2, block) {
  if (y2 < st.yMin || y1 > st.yMax) return false;
  if (y1 < st.yMin) y1 = st.yMin;
  if (y2 > st.yMax) y2 = st.yMax;
  const vol = new BlockVolume({ x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 });
  for (const types of [REPLACEABLE, ["minecraft:air"]]) {
    try {
      dim.fillBlocks(vol, block, { blockFilter: { includeTypes: types } });
      return true;
    } catch (e) { /* 次の指定で試す */ }
  }
  // 置き換え指定に対応していない環境では丸ごと埋める (以前の挙動)
  return fillSafe(st, dim, x1, y1, z1, x2, y2, z2, block);
}

function* fillSolid(st, dim, x0, z0) {
  const B = st.blocks;
  const solidTop = Math.max(st.yMin, st.deepslateY - BLEND_WAVE - 2);
  const bandHi = Math.min(st.yMax, st.deepslateY + BLEND_WAVE + BLEND);

  for (let y = st.yMin; y <= solidTop; y += 16) {
    fillAirOnly(st, dim, x0, y, z0, x0 + 15, Math.min(y + 15, solidTop), z0 + 15, B.deepslate);
  }
  for (let y = solidTop + 1; y <= st.yMax; y += 16) {
    fillAirOnly(st, dim, x0, y, z0, x0 + 15, Math.min(y + 15, st.yMax), z0 + 15, B.stone);
  }

  blendDeepslate(st, dim, x0, z0);
}

// ===========================================================================
// チャンク生成
// ===========================================================================

/**
 * 生成中のチャンクに居るプレイヤーを守る。
 *
 * fillSolid はチャンク全体をいったん石で埋めてから彫る。その間に
 * 中に居ると埋まって窒息し、モブもダメージを受ける。
 * 深層岩の遷移帯は列ごとに埋めるので、彫られた空間に柱が立って見える。
 */
function protectInside(st, dim, cx, cz) {
  for (const p of world.getAllPlayers()) {
    if (p.dimension.id !== st.cfg.id) continue;
    const l = p.location;
    if (Math.floor(l.x / 16) !== cx || Math.floor(l.z / 16) !== cz) continue;

    const px = Math.floor(l.x), py = Math.floor(l.y), pz = Math.floor(l.z);
    fillSafe(st, dim, px - 1, py - 1, pz - 1, px + 1, py - 1, pz + 1, st.blocks.stone);
    fillSafe(st, dim, px - 1, py, pz - 1, px + 1, py + 2, pz + 1, BLOCK_AIR);
    freeze(p);   // 生成が終わるまで動かさない
  }
}

/**
 * 深層岩の遷移帯。
 *
 * 列ごとに256回埋めていたのを、置き換え付きの fillBlocks に変えた。
 * 下側は1回で丸ごと置き換え、上側は斑を散らして勾配にする。
 */
const BLEND_SPECKLES = 40;

function blendDeepslate(st, dim, x0, z0) {
  const B = st.blocks;
  const lo = Math.max(st.yMin, st.deepslateY - 8);
  const mid = Math.min(st.yMax, st.deepslateY - 2);
  const hi = Math.min(st.yMax, st.deepslateY + 8);
  if (mid <= lo) return;

  // 下側: 石だけを深層岩に置き換える
  try {
    dim.fillBlocks(
      new BlockVolume({ x: x0, y: lo, z: z0 }, { x: x0 + 15, y: mid, z: z0 + 15 }),
      B.deepslate,
      { blockFilter: { includeTypes: [B.stone] } });
  } catch (e) {
    // 置き換えに対応していない環境では境界が平らになるだけ
    fillSafe(st, dim, x0, lo, z0, x0 + 15, mid, z0 + 15, B.deepslate);
  }

  // 上側: 斑を散らして境界をぼかす
  for (let i = 0; i < BLEND_SPECKLES; i++) {
    const x = x0 + Math.floor(chunkRand(x0, z0, 900 + i * 3) * 16);
    const z = z0 + Math.floor(chunkRand(x0, z0, 901 + i * 3) * 16);
    const y = mid + 1 + Math.floor(chunkRand(x0, z0, 902 + i * 3) * (hi - mid));
    const h = 1 + Math.floor(chunkRand(x0, z0, 903 + i * 3) * 3);
    fillSafe(st, dim, x, y, z, x, Math.min(hi, y + h), z, B.deepslate);
  }
}

/** 座標から決まる乱数。同じチャンクなら毎回同じ配置になる */
function chunkRand(cx, cz, salt) {
  let h = SEED | 0;
  h = Math.imul(h ^ cx, 0x27d4eb2d);
  h = Math.imul(h ^ cz, 0x85ebca6b);
  h = Math.imul(h ^ salt, 0xc2b2ae35);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967296);
}

/**
 * 流体のマスが閉じ込められているかを判定する関数を作る。
 *
 * 流体の高さは列ごとにノイズで決まるので、隣の列より1段高いだけで
 * 横の空気へ流れ出していた。流れた溶岩は隣の水と触れて丸石や黒曜石を作り、
 * 生成前の隣のチャンクへ落ちて岩の中に残る。これが「溶岩の配置が安定しない」
 * の正体だった。
 *
 * 横の4マスがどれも「岩」か「同じ流体」か「仕切りの岩」なら閉じている。
 * 隣の判定は隣の列の水面・溶岩面から直接求めるので、チャンクの境目でも
 * 両側で同じ答えになる。閉じていないマスは岩で塞ぐ。塞いだマスは岩なので、
 * そのせいで別のマスが開くことは無い。
 *
 * 床の溜まり場 (lavaPuddle) は小さくこぼれる前提なので対象にしない。
 */
function fluidContainment(st, buf, src, x0, z0) {
  const lavaA = new Float64Array(SW * SW);
  const waterA = new Float64Array(SW * SW);
  for (let i = 0; i < SW; i++) {
    for (let j = 0; j < SW; j++) {
      const wx = x0 - PAD + i, wz = z0 - PAD + j;
      lavaA[i * SW + j] = lavaTop(st, wx, wz);
      waterA[i * SW + j] = waterTop(st, wx, wz);
    }
  }
  const smooth = st.field.smooth;

  // 確実に岩か。チャンクの外の縁は均し前の値しか無いので、
  // 均しで空気に変わりうるもの (真上が空気) は岩とみなさない
  const surelySolid = (lx, lz, y) => {
    const i = ((lx + PAD) * SW + (lz + PAD)) * MAX_H + (y - st.yMin);
    if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) return src[i] === 0;
    return buf.a[i] === 0 && (!smooth || y >= st.yMax || buf.a[i + 1] === 0);
  };

  return (lx, lz, y, kind) => {
    for (const [dx, dz] of NEIGHBORS4) {
      const nx = lx + dx, nz = lz + dz;
      if (surelySolid(nx, nz, y)) continue;
      const ci = (nx + PAD) * SW + (nz + PAD);
      const b = fluidAt(st, y, lavaA[ci], waterA[ci]);
      if (b !== kind && b !== BARRIER) return false;
    }
    return true;
  };
}

const NEIGHBORS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 彫る区間が開いていないことの印 */
const NO_RUN = -Infinity;

/**
 * 空洞に面した岩の一覧 (x, y, z を平たく並べたもの)。
 * 鉱脈・床の雪・構造物の置き場所に使う。構造物は地形とは別の時に置くので、
 * 密度から同じものを作り直せるよう関数に分けてある。
 */
function collectWallSpots(st, src, x0, z0) {
  const spots = [];
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const base = ((lx + PAD) * SW + (lz + PAD)) * MAX_H;
      let open = false;
      for (let y = st.yMin + 1; y <= st.yMax - 1; y++) {
        if (src[base + (y - st.yMin)]) {
          if (!open) {
            open = true;
            spots.push(x0 + lx, y - 1, z0 + lz);
          }
        } else if (open) {
          open = false;
          spots.push(x0 + lx, y, z0 + lz);
        }
      }
    }
  }
  return spots;
}

/** 密度のバッファから「そこは岩か」を引く関数を作る */
function solidTester(st, src, x0, z0) {
  return (wx, wy, wz) => {
    const lx = wx - x0 + PAD;
    const lz = wz - z0 + PAD;
    if (lx < 0 || lx >= SW || lz < 0 || lz >= SW) return false;
    if (wy < st.yMin || wy > st.yMax) return false;
    // ストライドは MAX_H。h を使うと別の高さを読み、空中に鉱石が置かれる
    return src[(lx * SW + lz) * MAX_H + (wy - st.yMin)] === 0;
  };
}

function* generateChunk(st, buf, cx, cz) {
  const dim = caveDim(st.cfg.id);
  if (!dim) return;

  const x0 = cx * 16;
  const z0 = cz * 16;

  try {
    // ロードを待つ。ワーカーは4本あるので、1本詰まっても全体は止まらない。
    // ここで後ろへ回すと、順番が来る頃には巡回が同じチャンクを積み直していて
    // 同じ場所を延々と往復することになる。
    if (!(yield* waitForChunk(st, dim, x0 + 8, z0 + 8, 30))) {
      reportSkip(cx, cz, "未ロード");
      return;   // 記録しないので、必要になれば巡回が積み直す
    }

    // 1. 先に密度を計算する。
    //    石で埋めてから計算すると、その間チャンクは中身の詰まった石のままで、
    //    そこに居るプレイヤーやモブが窒息する。計算は数msだが runJob で
    //    細切れに実行されるため、実時間では数秒かかる。
    yield* fillDensity(st, buf, x0, z0);

    if (st.field.smooth) yield* smoothPass(st, buf);
    const src = st.field.smooth ? buf.b : buf.a;

    // 2. 母岩。ここから彫り終わるまでが「詰まっている」時間
    //    確認はプレイヤーの避難場所を空ける前に行う。空けたあとだと
    //    その空気を「埋まっていない」と数えて埋め直してしまう
    yield* fillSolid(st, dim, x0, z0);
    if (!verifyFilled(st, dim, x0, z0)) {
      yield* waitForChunk(st, dim, x0 + 8, z0 + 8, 30);
      yield* fillSolid(st, dim, x0, z0);
      if (!verifyFilled(st, dim, x0, z0)) {
        protectInside(st, dim, cx, cz);
        reportSkip(cx, cz, "充填失敗");
        return;
      }
    }
    protectInside(st, dim, cx, cz);

    // 4. 空洞を抜く。
    //    列ごとに fillBlocks すると132回かかる。同じ高さ・同じ中身の区間を
    //    矩形にまとめると56回まで減る (実測で58%削減)。
    const carveMin = st.yMin + 1;
    const carveMax = st.yMax - 1;
    const wallSpots = collectWallSpots(st, src, x0, z0);
    const hasFluid = !!st.cfg.fluids;
    const contained = hasFluid ? fluidContainment(st, buf, src, x0, z0) : null;
    const rockAt = (y) => (y < st.deepslateY ? st.blocks.deepslate : st.blocks.stone);

    // 区間をまとめるための入れ物。key = "開始_終了_ブロック"
    const groups = new Map();

    for (let lx = 0; lx < 16; lx++) {
      const wx = x0 + lx;
      for (let lz = 0; lz < 16; lz++) {
        const wz = z0 + lz;
        const base = ((lx + PAD) * SW + (lz + PAD)) * MAX_H;
        const lava = hasFluid ? lavaTop(st, wx, wz) : -Infinity;
        const water = hasFluid ? waterTop(st, wx, wz) : -Infinity;

        const push = (a, b, block) => {
          const k = `${a}_${b}_${block}`;
          let g = groups.get(k);
          if (!g) { g = { a, b, block, cells: [] }; groups.set(k, g); }
          g.cells.push(lx * 16 + lz);
        };

        // 区間が開いていないことの印。帯は y<0 まであるので -1 は使えない。
        // 以前は -1 を印にしていたため、y<0 で始まる空洞が一切彫られず、
        // 帯の下半分 (深層岩の層と溶岩湖) が丸ごと岩のままになっていた。
        let runStart = NO_RUN;
        const closeRun = (end2) => {
          if (runStart === NO_RUN) return;
          if (!hasFluid) {
            push(runStart, end2, BLOCK_AIR);
          } else {
            let segStart = runStart;
            let segBlock = fluidAt(st, runStart, lava, water);
            if (segBlock === BLOCK_AIR && lavaPuddle(st, wx, runStart, wz)) {
              segBlock = "minecraft:lava";
            }
            if (isFlowing(segBlock) && segBlock === fluidAt(st, runStart, lava, water)
                && !contained(lx, lz, runStart, segBlock)) segBlock = BARRIER;
            if (segBlock === BARRIER) segBlock = rockAt(runStart);
            for (let y = runStart + 1; y <= end2; y++) {
              let b = fluidAt(st, y, lava, water);
              // 横が空気なら流れ出すので、そのマスは岩で塞ぐ
              if (isFlowing(b) && !contained(lx, lz, y, b)) b = BARRIER;
              if (b === BARRIER) b = rockAt(y);
              if (b !== segBlock) {
                push(segStart, y - 1, segBlock);
                segStart = y;
                segBlock = b;
              }
            }
            push(segStart, end2, segBlock);
          }
          runStart = NO_RUN;
        };

        for (let y = carveMin; y <= carveMax; y++) {
          if (src[base + (y - st.yMin)]) {
            if (runStart === NO_RUN) runStart = y;
          } else if (runStart !== NO_RUN) {
            closeRun(y - 1);
          }
        }
        closeRun(carveMax);
      }
    }
    yield;

    // 同じ区間を持つ列を貪欲に矩形へまとめて置く
    for (const g of groups.values()) {
      const set = new Set(g.cells);
      const used = new Set();
      for (const cell of g.cells) {
        if (used.has(cell)) continue;
        const lx = cell >> 4, lz = cell & 15;

        let w = 1;
        while (lx + w < 16 && set.has((lx + w) * 16 + lz) && !used.has((lx + w) * 16 + lz)) w++;

        let h = 1;
        outer: while (lz + h < 16) {
          for (let i = 0; i < w; i++) {
            const k = (lx + i) * 16 + (lz + h);
            if (!set.has(k) || used.has(k)) break outer;
          }
          h++;
        }

        for (let i = 0; i < w; i++) {
          for (let j = 0; j < h; j++) used.add((lx + i) * 16 + (lz + j));
        }

        fillSafe(st, dim, x0 + lx, g.a, z0 + lz,
                 x0 + lx + w - 1, g.b, z0 + lz + h - 1, g.block);
      }
    }
    yield;

    // 5. 岩盤で蓋
    fillSafe(st, dim, x0, st.yMin, z0, x0 + 15, st.yMin, z0 + 15, st.blocks.bedrock);
    fillSafe(st, dim, x0, st.yMax, z0, x0 + 15, st.yMax, z0 + 15, st.blocks.bedrock);
    protectInside(st, dim, cx, cz);   // 彫ったあとも念のため確保
    yield;

    const isSolid = solidTester(st, src, x0, z0);

    // 彫ったあとは岩のはずの点だけを見る (大空洞のチャンクを誤って弾かない)
    if (!verifyFilled(st, dim, x0, z0, isSolid)) {
      reportSkip(cx, cz, "鉱脈前に消失");
      return;
    }

    // 6. 鉱脈
    yield* placeVeins({
      dimId: st.cfg.id,
      cx, cz, x0, z0,
      worldSeed: SEED,
      wallSpots,
      deepslateY: st.deepslateY,
      blendTop,
      multiplier: st.cfg.oreMultiplier,
      stoneVariants: st.cfg.stoneVariants,
      yMin: carveMin,
      yMax: carveMax,
      isSolid,
      // y2 が来たら縦に連続した区間としてまとめて置く
      place: (wx, wy, wz, id, wy2) =>
        fillSafe(st, dim, wx, wy, wz, wx, wy2 ?? wy, wz, id),
    });

    // 7. 床を覆う (氷の洞窟の雪など)
    if (st.cfg.floorCover) {
      const fc = st.cfg.floorCover;
      let placed = 0;
      for (let i = 0; i < wallSpots.length; i += 3) {
        const x = wallSpots[i], y = wallSpots[i + 1], z = wallSpots[i + 2];
        // 床 = そこが岩で、真上が空洞
        if (!isSolid(x, y, z) || isSolid(x, y + 1, z)) continue;
        // 凍った湖や溶岩の上には積もらせない
        if (y + 1 <= waterTop(st, x, z) || y + 1 <= lavaTop(st, x, z)) continue;
        if ((hash3(x, 6060, z) + 1) / 2 >= fc.chance) continue;
        setSafe(st, dim, x, y + 1, z, fc.block);
        // 1つずつ置くと重いので、こまめに譲る
        if (++placed % 24 === 0) yield;
      }
      yield;
    }

    // 8. 薄明かり。空洞の格子点に見えない光源を置く
    if (st.cfg.ambientLight) {
      const al = st.cfg.ambientLight;
      const id = `minecraft:light_block_${Math.max(0, Math.min(7, al.level))}`;
      const sp = Math.max(4, al.spacing | 0);
      // 格子をチャンクごとにずらすと、境目で明るさが揃いすぎない
      const ox = Math.floor(chunkRand(cx, cz, 7100) * sp);
      const oz = Math.floor(chunkRand(cx, cz, 7101) * sp);
      const oy = Math.floor(chunkRand(cx, cz, 7102) * sp);
      let lit = 0;
      for (let lx = ox; lx < 16; lx += sp) {
        for (let lz = oz; lz < 16; lz += sp) {
          const x = x0 + lx, z = z0 + lz;
          const lava = lavaTop(st, x, z), water = waterTop(st, x, z);
          for (let y = st.yMin + 2 + oy; y < st.yMax - 1; y += sp) {
            if (isSolid(x, y, z)) continue;           // 岩の中には置かない
            if (y <= lava || y <= water) continue;     // 湖や溶岩の中にも置かない
            setSafe(st, dim, x, y, z, id);
            // 光源は置くたびに明るさの再計算が走って重い。
            // まとめて置くと1工程が長引き、ウォッチドッグに止められる
            if (++lit % 8 === 0) yield;
          }
        }
      }
      yield;
    }

    // 9. 構造物はここでは置かない (decorateChunk で周りが揃ってから置く)
    yield;

    if (!verifyFilled(st, dim, x0, z0, isSolid)) {
      reportSkip(cx, cz, "途中で消失");
      return;
    }
    markGenerated(st, cx, cz);
    queueDecorationAround(st, cx, cz);

    try {
      restorePortals(st.cfg.id, cx, cz, dim,
        (d, a, b, c, e, f, g, blk) => fillSafe(st, d, a, b, c, e, f, g, blk));
    } catch (e) { /* noop */ }
  } catch (e) {
    console.warn(`[CavernMiner] chunk ${cx},${cz}: ${e}`);
  }
}

// ===========================================================================
// 構造物 (地形とは別の工程)
// ===========================================================================

/**
 * 構造物は、そのチャンクと周囲8チャンクの地形が揃ってから置く。
 *
 * ジオードや部屋は最大7マスほど隣のチャンクへはみ出す。地形と同時に
 * 置いていた頃は、あとから隣を生成したときに
 *   - 母岩の充填でジオードの中の空洞が石で埋まる
 *   - 隣の洞窟がジオードの殻や部屋の壁を彫り抜く
 *   - 隣の鉱脈や深層岩の斑が殻を置き換える
 * といった形で上書きされていた (生成順しだいで約4割のジオードが欠けた)。
 * 周りが全部できてから置けば、あとから地形に踏まれることは無い。
 * 本家マイクラが地形と地物を別の段階で置くのと同じ考え方。
 */
function neighborsReady(st, cx, cz) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!isGenerated(st, cx + dx, cz + dz)) return false;
    }
  }
  return true;
}

function dkey(st, cx, cz) { return `${st.cfg.short}:d:${cx},${cz}`; }

/** 構造物を置ける状態なら積む */
function enqueueDecoration(st, cx, cz) {
  if (!st.cfg.structures) return;
  const k = dkey(st, cx, cz);
  if (gQueued.has(k) || building.has(k)) return;
  if (isDecorated(st, cx, cz) || !neighborsReady(st, cx, cz)) return;
  // 上限で捨てると二度と積まれない場所が出るので、上限は見ない
  gQueued.add(k);
  gQueue.push([st, cx, cz, k, true]);
}

/** 生成し終えたチャンクと、それで周りが揃った隣を積む */
function queueDecorationAround(st, cx, cz) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) enqueueDecoration(st, cx + dx, cz + dz);
  }
}

function* decorateChunk(st, buf, cx, cz) {
  const dim = caveDim(st.cfg.id);
  if (!dim || !st.cfg.structures) return;
  if (isDecorated(st, cx, cz) || !neighborsReady(st, cx, cz)) return;

  const x0 = cx * 16;
  const z0 = cz * 16;
  try {
    if (!(yield* waitForChunk(st, dim, x0 + 8, z0 + 8, 30))) return;

    // 置き場所は地形と同じ密度から求め直す。ブロックを読むより速く、結果も同じ
    yield* fillDensity(st, buf, x0, z0);
    if (st.field.smooth) yield* smoothPass(st, buf);
    const src = st.field.smooth ? buf.b : buf.a;
    const isSolid = solidTester(st, src, x0, z0);
    const wallSpots = collectWallSpots(st, src, x0, z0);

    yield* placeStructures(structureCtx(st, dim, cx, cz, x0, z0, wallSpots, isSolid),
                           st.cfg.structures, SEED);
    markDecorated(st, cx, cz);
  } catch (e) {
    console.warn(`[CavernMiner] structures ${cx},${cz}: ${e}`);
  }
}

/** 構造物側に渡す道具一式 */
function structureCtx(st, dim, cx, cz, x0, z0, wallSpots, isSolid) {
  return {
    cx, cz, x0, z0,
    yMin: st.yMin, yMax: st.yMax,
    wallSpots,
    isSolid,

    /** (x,z) を中心に ±r の範囲で、高さ y より上まで水か溶岩が来ている列があるか */
    wetNear: (x, y, z, r) => {
      if (!st.cfg.fluids) return false;
      for (const dx of r > 0 ? [-r, 0, r] : [0]) {
        for (const dz of r > 0 ? [-r, 0, r] : [0]) {
          const top = Math.max(lavaTop(st, x + dx, z + dz), waterTop(st, x + dx, z + dz));
          if (top >= y - 1) return true;
        }
      }
      return false;
    },

    set: (x, y, z, block) => setSafe(st, dim, x, y, z, block),
    fill: (x1, y1, z1, x2, y2, z2, block) =>
      fillSafe(st, dim, x1, y1, z1, x2, y2, z2, block),

    placeLichen: (x, y, z, face) => {
      // 置き場所は密度から選ぶので、隣の構造物がそこにあっても分からない。
      // 空気のときだけ生やし、ジオードの殻や部屋の壁を上書きしない
      let block;
      try { block = dim.getBlock({ x, y, z }); } catch (e) { return; }
      if (!block || block.typeId !== BLOCK_AIR) return;
      try {
        const perm = BlockPermutation.resolve("minecraft:glow_lichen", {
          multi_face_direction_bits: faceBit(face),
        });
        block.setPermutation(perm);
      } catch (e) {
        setSafe(st, dim, x, y, z, "minecraft:glow_lichen");
      }
    },

    chest: (x, y, z) => {
      if (!setSafe(st, dim, x, y, z, "minecraft:chest")) return;
      try {
        const b = dim.getBlock({ x, y, z });
        if (b) fillChest(b, prng(mix(x, z, y * 31 + 17, SEED)));
      } catch (e) { /* noop */ }
    },

    captive: (x, y, z, rand) => spawnCaptive(dim, x, y, z, rand),

    /** バニラの feature を名前で置く。成功したら true */
    placeFeature: (id, x, y, z) => {
      try {
        dim.placeFeature(id, { x, y, z }, true);
        return true;
      } catch (e) {
        return false;   // 周囲に空洞が多いと中止されるので、失敗は想定内
      }
    },

    /** 構造物を置く。成功したら true */
    placeStructure: (id, x, y, z) => {
      try {
        world.structureManager.place(id, dim, { x, y, z });
        return true;
      } catch (e) {
        console.warn(`[CavernMiner] 構造物の配置に失敗 ${id}: ${e}`);
        return false;
      }
    },

    /** 既に置かれているチェストに中身を詰める */
    fillChestAt: (x, y, z) => {
      try {
        const b = dim.getBlock({ x, y, z });
        if (b && b.typeId === "minecraft:chest") {
          fillChest(b, prng(mix(x, z, y * 31 + 17, SEED)));
        }
      } catch (e) { /* noop */ }
    },
  };
}

/**
 * 囚われた者を湧かせる。
 *
 * 構造物に村人を含めると、保存したときの見た目のまま固定されて
 * どの部屋でも同じ村人になる。配置後にスクリプトで湧かせれば
 * 毎回変えられる。
 */
const VILLAGER_BIOMES = [
  "minecraft:spawn_plains_villager",
  "minecraft:spawn_desert_villager",
  "minecraft:spawn_jungle_villager",
  "minecraft:spawn_savanna_villager",
  "minecraft:spawn_snow_villager",
  "minecraft:spawn_swamp_villager",
  "minecraft:spawn_taiga_villager",
];

const CAPTIVE_NAMES = [
  "§7囚われた村人", "§7忘れられた坑夫", "§7迷い込んだ商人",
  "§7閉じ込められた者", "§7名も無き囚人",
];

function spawnCaptive(dim, x, y, z, rand) {
  const roll = rand();

  // たまに村人以外。変わり果てた姿という扱い
  let type = "minecraft:villager_v2";
  if (roll < 0.12) type = "minecraft:zombie_villager_v2";
  else if (roll < 0.20) type = "minecraft:wandering_trader";

  let e;
  try {
    e = dim.spawnEntity(type, { x, y, z });
  } catch (err) {
    console.warn(`[CavernMiner] 囚われた者の生成に失敗: ${err}`);
    return;
  }

  // 見た目の系統を散らす。対応していない環境では何も起きない
  if (type !== "minecraft:wandering_trader") {
    try {
      e.triggerEvent(VILLAGER_BIOMES[Math.floor(rand() * VILLAGER_BIOMES.length)]);
    } catch (err) { /* イベント名が違う環境では既定の見た目のまま */ }
  }

  try {
    e.nameTag = CAPTIVE_NAMES[Math.floor(rand() * CAPTIVE_NAMES.length)];
  } catch (err) { /* noop */ }

  // 閉じ込められていた設定なので弱っている
  try {
    e.addEffect("weakness", 20 * 60 * 5, { amplifier: 0, showParticles: false });
  } catch (err) { /* noop */ }
}

/**
 * 移動の凍結。
 *
 * ブロックの設置APIは重く、チャンクを直接書く手段も無い (Mojang も
 * setBlock が重いことを認めている)。生成を速くするより、
 * 生成が追いつくまでプレイヤーを止めるほうが確実。
 */
function setFrozen(player, frozen) {
  try {
    player.inputPermissions.setPermissionCategory(
      InputPermissionCategory.Movement, !frozen);
    return true;
  } catch (e) { /* 古い環境 */ }
  try {
    player.inputPermissions.movementEnabled = !frozen;
    return true;
  } catch (e) { /* noop */ }
  // どちらも無ければ鈍足で代用する
  if (frozen) {
    try { player.addEffect("slowness", 40, { amplifier: 5, showParticles: false }); }
    catch (e) { /* noop */ }
  }
  return false;
}

/** 凍結中のプレイヤー */
const frozenPlayers = new Set();

function freeze(player) {
  if (frozenPlayers.has(player.id)) return;
  frozenPlayers.add(player.id);
  setFrozen(player, true);
}

function unfreeze(player) {
  if (!frozenPlayers.has(player.id)) return;
  frozenPlayers.delete(player.id);
  setFrozen(player, false);
}

/**
 * 生成待ちの表示。
 * 途中の地形を見せないよう暗転させ、進み具合を出す。
 */
const LOADING_FRAMES = ["§8◐", "§8◓", "§8◑", "§8◒"];

function showLoading(st, player, tries) {
  try {
    const spin = LOADING_FRAMES[Math.floor(tries / 4) % LOADING_FRAMES.length];
    const left = gQueue.length;
    player.onScreenDisplay.setTitle(`§7${st.cfg.name}`, {
      subtitle: `${spin} §8地形を生成中... §7残り ${left}`,
      fadeInDuration: 0,
      stayDuration: 12,
      fadeOutDuration: 0,
    });
  } catch (e) { /* noop */ }
}

function endLoading(st, player, safe) {
  try {
    player.removeEffect("blindness");
  } catch (e) { /* noop */ }

  try {
    if (safe) {
      player.onScreenDisplay.setTitle("§f" + st.cfg.name, {
        subtitle: "§8足を踏み入れた",
        fadeInDuration: 4, stayDuration: 30, fadeOutDuration: 16,
      });
      player.playSound("beacon.activate", { volume: 0.4, pitch: 1.4 });
    } else {
      player.onScreenDisplay.setTitle("§c生成に失敗しました", {
        subtitle: "§7/scriptevent cavern:diag を確認してください",
        fadeInDuration: 4, stayDuration: 60, fadeOutDuration: 10,
      });
    }
  } catch (e) { /* noop */ }
}

/** ヒカリゴケが張り付く面のビット */
function faceBit(face) {
  switch (face) {
    case "down": return 1;
    case "up": return 2;
    case "south": return 4;
    case "west": return 8;
    case "north": return 16;
    case "east": return 32;
    default: return 2;
  }
}

// ===========================================================================
// ストリーミング
// ===========================================================================

const AREA_TAG_PREFIX = "gcarea_";

function ensureArea(st, dim, pcx, pcz, force) {
  if (st.areaChunk) {
    // 張り替えると生成中のチャンクがアンロードされて彫りが失敗する
    const d = Math.max(Math.abs(st.areaChunk.cx - pcx), Math.abs(st.areaChunk.cz - pcz));
    if (!force && d < 3) return;
  }

  // 先回りしているぶんも覆う。tickingarea は1枚に保つ
  // (複数枚重ねると強制ロードが一気に膨れてロードが破綻する)
  const ps = preState.get(st.cfg.id);
  const pre = ps ? Math.min(PRE_RADIUS_MAX, ps.r) : 0;
  const r = Math.max(radiusOf(st) + AREA_MARGIN, pre + 1);
  const tag = AREA_TAG_PREFIX + st.cfg.short;
  const x1 = (pcx - r) * 16, z1 = (pcz - r) * 16;
  const x2 = (pcx + r) * 16 + 15, z2 = (pcz + r) * 16 + 15;

  try { dim.runCommand(`tickingarea remove ${tag}`); } catch (e) { /* noop */ }
  try {
    dim.runCommand(`tickingarea add ${x1} ${st.yMin} ${z1} ${x2} ${st.yMax} ${z2} ${tag}`);
    st.areaChunk = { cx: pcx, cz: pcz };
  } catch (e) {
    console.warn(`[CavernMiner] tickingarea add failed: ${e}`);
    st.areaChunk = null;
  }
}

/**
 * 生成キューは全ディメンション共通で1本。
 *
 * 以前はディメンションごとにワーカーを持ち、さらに入場処理も別に
 * generateChunk を呼んでいた。これらが共有バッファを踏み合うので
 * ロックで排他したところ、待機側が runJob の実行時間を食い潰して
 * ロックを持つ側が進まなくなり、かえって悪化した。
 * 待つのではなく、最初から1本しか走らせない。
 */
const gQueue = [];
const gQueued = new Set();

/** いま走っているワーカーの本数 */
let running = 0;

/** いま彫っている最中のチャンク。ここに居るプレイヤーは止める */
const building = new Set();

function isBuilding(st, cx, cz) {
  return building.has(`${st.cfg.short}:${cx},${cz}`);
}

function qkey(st, cx, cz) { return `${st.cfg.short}:${cx},${cz}`; }



function enqueue(st, cx, cz, front) {
  const k = qkey(st, cx, cz);
  if (gQueued.has(k) || isGenerated(st, cx, cz)) return;
  if (gQueue.length >= QUEUE_LIMIT) return;
  gQueued.add(k);
  if (front) gQueue.unshift([st, cx, cz, k]);
  else gQueue.push([st, cx, cz, k]);
}

function* worker(buf) {
  try {
    while (gQueue.length > 0) {
      const [st, cx, cz, k, deco] = gQueue.shift();
      gQueued.delete(k);

      building.add(k);
      try {
        if (deco) yield* decorateChunk(st, buf, cx, cz);
        else yield* generateChunk(st, buf, cx, cz);
      } catch (e) {
        console.warn(`[CavernMiner] chunk ${k} failed: ${e}`);
      } finally {
        building.delete(k);
      }
    }
  } finally {
    buf.busy = false;
    running--;
  }
}

/**
 * 空いているバッファのぶんだけワーカーを起こす。
 * runJob は本数ぶん実行時間を配分するので、同時に走らせるほど進む。
 */
function pump() {
  while (gQueue.length > 0 && running < WORKERS) {
    const buf = takeBuffer();
    if (!buf) return;
    running++;
    system.runJob(worker(buf));
  }
}

/** ディメンションごとの先回り状態 */
const preState = new Map();

/**
 * キューが空いているときだけ、外側のリングを1周ぶん積む。
 * 通常の生成を邪魔せず、余った時間で周囲を埋めていく。
 */
function preGenerate(st, pcx, pcz) {
  // 目の前の生成が片付いてから。割り込ませると足元が後回しになる
  if (gQueue.length > 0) return;

  let ps = preState.get(st.cfg.id);
  const moved = !ps || Math.max(Math.abs(ps.cx - pcx), Math.abs(ps.cz - pcz)) > 2;
  if (moved) {
    ps = { cx: pcx, cz: pcz, r: radiusOf(st) + 1 };
    preState.set(st.cfg.id, ps);
    const dim = caveDim(st.cfg.id);
    if (dim) ensureArea(st, dim, pcx, pcz, true);
  }
  if (ps.r > PRE_RADIUS_MAX) return;

  const r = ps.r;
  let added = 0;
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;   // 外周だけ
      const cx = ps.cx + dx, cz = ps.cz + dz;
      if (isGenerated(st, cx, cz)) continue;
      enqueue(st, cx, cz, false);
      added++;
    }
  }
  ps.r++;
}

function scan() {
  for (const player of world.getAllPlayers()) {
    const st = stateOf(player.dimension.id);
    if (!st) continue;

    const pcx = Math.floor(player.location.x / 16);
    const pcz = Math.floor(player.location.z / 16);
    ensureArea(st, player.dimension, pcx, pcz, false);

    // 進んでいる方向を優先する。狭い範囲では、向いている先が
    // 間に合っているかどうかが体感をほぼ決める。
    let vx = 0, vz = 0;
    try {
      const v = player.getViewDirection();
      const len = Math.hypot(v.x, v.z);
      if (len > 0.01) { vx = v.x / len; vz = v.z / len; }
    } catch (e) { /* noop */ }

    // 進行方向は円の外側まで先読みする。止まってから作り始めると間に合わない
    const R = radiusOf(st);
    const LOOK = LOOK_AHEAD;
    const cand = [];
    for (let dx = -R - LOOK; dx <= R + LOOK; dx++) {
      for (let dz = -R - LOOK; dz <= R + LOOK; dz++) {
        const d2 = dx * dx + dz * dz;
        const d = Math.sqrt(d2) || 1;
        const ahead = (dx * vx + dz * vz) / d;      // -1(後ろ) 〜 1(前)
        // 前方は半径 + LOOK まで、後方は半径までを対象にする
        const reach = R + Math.max(0, ahead) * LOOK;
        if (d > reach) continue;
        cand.push([d2 - ahead * 4.0, pcx + dx, pcz + dz]);
      }
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cz] of cand) enqueue(st, cx, cz, false);

    // 構造物の積み残しを拾う。無人になって捨てられたり、ロード待ちで
    // 諦めたりしたものは、周りの生成が終わっているので二度と積まれない
    if (st.cfg.structures && gQueue.length < WORKERS) {
      for (const [, cx, cz] of cand) enqueueDecoration(st, cx, cz);
    }

    // 積んだあとに近い順へ並べ替える。移動すると古い遠方のチャンクが
    // 先頭に残り、足元が後回しになってしまう
    if (gQueue.length > 1) {
      gQueue.sort((a, b) => {
        const da = Math.max(Math.abs(a[1] - pcx), Math.abs(a[2] - pcz));
        const db = Math.max(Math.abs(b[1] - pcx), Math.abs(b[2] - pcz));
        return da - db;
      });
    }

    // 足元がまだ生成されていないなら、そこを最優先にして足止めする。
    // 生成より速く歩けると、未生成の空間に出てしまう。
    const here = isGenerated(st, pcx, pcz);
    const onBuilding = isBuilding(st, pcx, pcz);

    if (!here || onBuilding) {
      enqueue(st, pcx, pcz, true);
      holdBack(st, player);
    } else {
      unfreeze(player);
    }

    // 手が空いていれば外側を先回りして作る
    preGenerate(st, pcx, pcz);
  }
  pump();
}

/**
 * 足元がまだ生成されていない間は動けなくする。
 * 生成より速く歩けてしまうと、未生成の空間に出て落下したり埋まったりする。
 */
function holdBack(st, player) {
  freeze(player);
  try {
    player.onScreenDisplay.setActionBar(`§8${st.cfg.name} を生成中... §7残り ${gQueue.length}`);
  } catch (e) { /* noop */ }
}

// ===========================================================================
// 出現地点
// ===========================================================================

function* findSpawn(st, ox, oz) {
  let best = null;

  for (const radius of [0, 8, 16, 24, 32, 48]) {
    for (let dx = -radius; dx <= radius; dx += 8) {
      for (let dz = -radius; dz <= radius; dz += 8) {
        if (radius > 0 && Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;

        const x = ox + dx;
        const z = oz + dz;
        const localT = columnContext(st, x, z);

        // 水や溶岩に沈む場所は避ける
        const lava = lavaTop(st, x, z);
        const water = waterTop(st, x, z);
        const floor = Math.max(lava, water > -Infinity ? water : -Infinity);

        // 一番高い空洞を選ぶと帯の最上部に降り、水も溶岩も鉱石も
        // 90ブロック下になって出会えない。中ほどより少し上を狙う。
        const want = st.yMin + Math.round(st.h * 0.62);

        let run = 0, start = 0;
        const take = () => {
          if (run < 4) return;
          if (start <= floor + 1) return;
          const cand = { x, y: start, z, h: run };
          if (!best || Math.abs(cand.y - want) < Math.abs(best.y - want)) best = cand;
        };
        for (let y = st.yMin + 2; y <= st.yMax - 2; y++) {
          if (density(st, x, y, z, localT) > 0) {
            if (run === 0) start = y;
            run++;
          } else {
            take();
            run = 0;
          }
        }
        take();
      }
      yield;
    }
    if (best) return best;
  }
  return null;
}

/** 実際に置かれたブロックを読んで、立てる高さを決める */
function findStanding(st, dim, x, z, preferY) {
  const isAir = (y) => {
    try {
      const b = dim.getBlock({ x, y, z });
      return b ? b.typeId === BLOCK_AIR : null;
    } catch (e) {
      return null;
    }
  };

  for (let d = 0; d <= 48; d++) {
    for (const y of (d === 0 ? [preferY] : [preferY - d, preferY + d])) {
      if (y < st.yMin + 2 || y > st.yMax - 3) continue;
      const feet = isAir(y);
      const head = isAir(y + 1);
      const floor = isAir(y - 1);
      if (feet === null || head === null || floor === null) return null;
      if (feet && head && !floor) return y;
    }
  }
  return null;
}

/** 地面ができるまでプレイヤーを支える */
function ensureNotBuried(st, dim, player, x, y, z) {
  let buried = false;
  for (const dy of [0, 1]) {
    try {
      const b = dim.getBlock({ x, y: y + dy, z });
      if (b && b.typeId !== BLOCK_AIR) buried = true;
    } catch (e) {
      buried = true;
    }
  }
  if (!buried) return;
  fillSafe(st, dim, x - 2, y - 1, z - 2, x + 2, y - 1, z + 2, st.blocks.stone);
  fillSafe(st, dim, x - 2, y, z - 2, x + 2, y + 3, z + 2, BLOCK_AIR);
}

// ===========================================================================
// 入場
// ===========================================================================

function homeKey(st) { return `cavern:home_${st.cfg.short}`; }

function loadHome(st, player) {
  // 旧バージョンのキーから引き継ぐ (拠点とポータルが迷子になるのを防ぐ)
  if (st.cfg.id === DEFAULT_DIM
      && typeof player.getDynamicProperty(homeKey(st)) !== "string") {
    const old = player.getDynamicProperty("cavern:homeportal");
    if (typeof old === "string") player.setDynamicProperty(homeKey(st), old);
  }

  const raw = player.getDynamicProperty(homeKey(st));
  if (typeof raw !== "string") return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o.x === "number" && typeof o.y === "number" && typeof o.z === "number") {
      if (o.y < st.yMin + 2 || o.y > st.yMax - 3) return null;
      return o;
    }
  } catch (e) { /* noop */ }
  return null;
}

/**
 * クリエイティブかどうか。
 * getGameMode が無い/文字列が違う環境があるので、複数の手段で確かめる。
 */
export function isCreative(player) {
  try {
    const g = player.getGameMode?.();
    if (g === "creative" || g === 1) return true;
  } catch (e) { /* noop */ }
  try {
    const hit = player.dimension.getPlayers({ gameMode: "creative", name: player.name });
    if (hit.some((p) => p.id === player.id)) return true;
  } catch (e) { /* noop */ }
  try {
    // 最後の手段: クリエイティブ限定のコマンドが通るか
    player.runCommand("testfor @s[m=c]");
    return true;
  } catch (e) { /* noop */ }
  return false;
}

/** 入場条件。クリエイティブは対象外 */
export function canEnter(player, cfg) {
  if (!cfg.portal || !cfg.portal.minRank) return { ok: true };
  if (isCreative(player)) return { ok: true };
  if (getRank(player) >= cfg.portal.minRank) return { ok: true };
  return { ok: false, need: RANKS[cfg.portal.minRank].name };
}

export function enter(player, dimId) {
  const id = dimId ?? DEFAULT_DIM;
  const st = stateOf(id);
  if (!st) {
    player.sendMessage(`§c不明なディメンション: ${id}`);
    return;
  }

  const dim = caveDim(id);
  if (!dim) {
    player.sendMessage("§cディメンションが登録されていません。");
    player.sendMessage("§7ビヘイビアーパックが有効か、コンテンツログを確認してください。");
    return;
  }

  const gate = canEnter(player, st.cfg);
  if (!gate.ok) {
    player.sendMessage(`§c${st.cfg.name}へ入るには §f${gate.need}§c 以上が必要です`);
    return;
  }

  const ox = Math.floor(player.location.x);
  const oz = Math.floor(player.location.z);

  if (!isCaveDimension(player.dimension.id)) saveReturn(player);

  player.sendMessage(`§7${st.cfg.name}への道が開かれた...`);

  // 着地候補を探す。ブロックを読まないので軽い
  system.runJob((function* () {
    const home = loadHome(st, player);
    let spot = null;

    if (!home) {
      try {
        spot = yield* findSpawn(st, ox, oz);
      } catch (e) {
        console.warn(`[CavernMiner] findSpawn failed: ${e}`);
      }
    }

    const x = home ? home.x : (spot ? spot.x : ox);
    const z = home ? home.z : (spot ? spot.z : oz);
    const y = home ? home.y
      : (spot ? Math.max(st.yMin + 2, Math.min(st.yMax - 3, spot.y + 1))
              : Math.floor((st.yMin + st.yMax) / 2));

    system.run(() => arrive(st, dim, player, x, y, z));
  })());
}

/**
 * 転送して、周囲の生成を待つ。
 *
 * 生成そのものは共通ワーカーに任せる。ここで generateChunk を呼ぶと
 * ワーカーと同時に走ってバッファを踏み合う。
 */
/**
 * 転送して着地させる。
 *
 * 以前は先に転送していたが、そのあとチャンク生成が走って
 * チャンク全体を石で埋めるため、生き埋めになることがあった。
 * 地形を作ってから転送すれば、その事故は起こらない。
 */
/**
 * 転送して着地させる。
 *
 * 待機中はプレイヤーを「生成帯の上」に置く。
 *   - 洞窟ディメンションにいるのでチャンクがロードされる
 *     (誰もいないと tickingarea を張ってもロードされない)
 *   - fillSafe は yMin..yMax の外に書かないので、天井の岩盤より上は
 *     絶対に埋まらない。つまり窒息しようがない
 */
function arrive(st, dim, player, x, y, z) {
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);

  // 生成帯より上の退避地点
  const holdY = st.yMax + 3;

  freeze(player);
  ensureArea(st, dim, cx, cz, true);

  try {
    player.teleport({ x: x + 0.5, y: holdY, z: z + 0.5 }, { dimension: dim });
    if (SILENCE_MUSIC) silenceMusic(player);
  } catch (e) {
    console.warn(`[CavernMiner] 退避地点への転送に失敗: ${e}`);
    player.sendMessage(`§c転送に失敗しました: §7${e}`);
    unfreeze(player);
    return;
  }

  // 着地点の周囲を最優先で積む。
  // 狭いと降りた瞬間に行き止まりだらけになるので、5x5ぶん作ってから降ろす。
  const READY = 2;
  for (let d = 0; d <= READY; d++) {
    for (let dx = -d; dx <= d; dx++) {
      for (let dz = -d; dz <= d; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        enqueue(st, cx + dx, cz + dz, true);
      }
    }
  }
  pump();

  let tries = 0;
  const handle = system.runInterval(() => {
    tries++;

    // 待っている間にポータルやコマンドで別の場所へ移ったら打ち切る
    if (!player.isValid || player.dimension.id !== dim.id) {
      system.clearRun(handle);
      unfreeze(player);
      try { player.removeEffect("blindness"); } catch (e) { /* noop */ }
      return;
    }

    // 落ちないよう位置を保ち、生成中の地形を見せない
    try {
      player.teleport({ x: x + 0.5, y: holdY, z: z + 0.5 }, { dimension: dim });
      player.addEffect("blindness", 60, { showParticles: false });
      player.addEffect("slow_falling", 60, { showParticles: false });
    } catch (e) { /* noop */ }

    showLoading(st, player, tries);

    // 5x5 が揃うまで待つ。広く作ってから降ろすほうが洞窟らしい
    let done = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (isGenerated(st, cx + dx, cz + dz)) done++;
      }
    }
    const ready = done >= 25;
    if (!ready && tries < 900) return;    // 最大90秒
    system.clearRun(handle);

    finishArrival(st, dim, player, x, y, z, ready);
  }, 2);
}

function finishArrival(st, dim, player, x, y, z, ready) {
  try {
    const sy = findStanding(st, dim, x, z, y) ?? y;

    if (!ready) {
      // 生成が間に合わなかったときだけ、自前で足場を掘る
      fillSafe(st, dim, x - 3, sy - 1, z - 3, x + 3, sy - 1, z + 3, st.blocks.stone);
      fillSafe(st, dim, x - 3, sy, z - 3, x + 3, sy + 3, z + 3, BLOCK_AIR);
    }

    ensureNotBuried(st, dim, player, x, sy, z);
    player.teleport({ x: x + 0.5, y: sy, z: z + 0.5 }, { dimension: dim });

    buildReturnPortal(st.cfg.id, dim, x, sy, z,
      (d, a, b, c, e, f, g, blk) => fillSafe(st, d, a, b, c, e, f, g, blk));
    player.setDynamicProperty(homeKey(st), JSON.stringify({ x, y: sy, z }));



    note(player, `§7着地 §8(y=${sy})`);
  } catch (e) {
    console.warn(`[CavernMiner] arrive failed: ${e}`);
    player.sendMessage(`§c着地に失敗しました: §7${e}`);
  }

  endLoading(st, player, ready);
  unfreeze(player);
  try { player.removeEffect("blindness"); } catch (e) { /* noop */ }
}

/**
 * 誰もいなくなったディメンションの生成待ちを捨てる。
 * 残しておくと戻ったあとも裏で生成が走り続け、固まる原因になる。
 */
function purgeEmptyQueues() {
  const occupied = new Set(world.getAllPlayers().map((p) => p.dimension.id));
  let dropped = 0;
  for (let i = gQueue.length - 1; i >= 0; i--) {
    if (!occupied.has(gQueue[i][0].cfg.id)) {
      gQueued.delete(gQueue[i][3]);
      gQueue.splice(i, 1);
      dropped++;
    }
  }
  if (dropped > 0) console.warn(`[CavernMiner] 誰もいない洞窟の生成待ちを ${dropped} 件破棄`);
}

/** 地上へ戻す */
export function goHome(player) {
  // 生成待ちで凍結されたままでも、帰るときは必ず解く
  unfreeze(player);
  try { player.removeEffect("blindness"); } catch (e) { /* noop */ }
  const ret = loadReturn(player);
  const dim = world.getDimension("minecraft:overworld");

  let fallback = { x: 0, y: 80, z: 0 };
  try {
    const sp = player.getSpawnPoint?.() ?? world.getDefaultSpawnLocation?.();
    if (sp && typeof sp.x === "number") fallback = { x: sp.x, y: sp.y, z: sp.z };
  } catch (e) { /* noop */ }

  const target = ret ?? fallback;
  try {
    player.teleport({ x: target.x + 0.5, y: target.y, z: target.z + 0.5 }, { dimension: dim });
    player.sendMessage("§7地上へ戻った");
  } catch (e) {
    player.sendMessage(`§c帰還に失敗しました: §7${e}`);
  }
}

/**
 * 説明書を渡す。
 *
 * Bedrock は written_book の中身をスクリプトから直接書けないので、
 * loot table の set_book_contents で用意したものを配る。
 */
/**
 * 配布済みの記録。
 *
 * 壊れていた版では、コマンドが失敗しても例外が出ないまま
 * このフラグだけ true にしていた。古い記録が残っていると
 * 初回配布が永久にスキップされるので、キー名を変えて無効にする。
 */
const PROP_MANUAL = "cavern:manual_given2";

/**
 * 説明書を渡す。
 *
 * /loot のパスは loot_tables/ を基準にした相対パスで、拡張子は付けない。
 *   loot_tables/cavern/manual.json  →  loot give @s loot "cavern/manual"
 * ここを "loot_tables/manual.json" と書くと、例外も出ないまま何も渡らない。
 */
const MANUAL_CMD = 'loot give @s loot "cavern/manual"';

export function giveManual(player, force, report) {
  if (!force && player.getDynamicProperty(PROP_MANUAL) === true) return true;

  try {
    const r = player.runCommand(MANUAL_CMD);
    // 例外が出なくても、渡せたかどうかは successCount で判る
    if (r && typeof r.successCount === "number" && r.successCount === 0) {
      if (report) player.sendMessage("§8successCount 0 — 持ち物が満杯か、ルートテーブルが読めていません");
      return false;
    }
    player.setDynamicProperty(PROP_MANUAL, true);
    return true;
  } catch (e) {
    console.warn(`[CavernMiner] 説明書を渡せませんでした: ${e}`);
    if (report) player.sendMessage(`§8${e}`);
    return false;
  }
}

function silenceMusic(player) {
  try { player.runCommand("music stop 2"); } catch (e) { /* noop */ }
}

// ===========================================================================
// 診断
// ===========================================================================

function resolveDim(message, player) {
  const s = (message ?? "").trim().toLowerCase();
  if (!s) {
    // 引数なしなら今いる洞窟を調べる。以前は常に大空洞を見ていたため、
    // 誰もいない大空洞の fillBlocks テストが失敗して見えていた
    const here = player?.dimension?.id;
    return here && isCaveDimension(here) ? here : DEFAULT_DIM;
  }
  for (const c of DIMENSIONS) {
    if (s === c.short || s === c.id || c.id.endsWith(s)) return c.id;
  }
  return DEFAULT_DIM;
}

function diag(player, dimId) {
  const st = stateOf(dimId);
  player.sendMessage("§6=== CavernMiner 診断 ===");
  if (!st) { player.sendMessage("§c不明なディメンション"); return; }

  player.sendMessage(`§7対象: §f${st.cfg.name} §8(${st.cfg.id})`);
  const dim = caveDim(st.cfg.id);
  if (!dim) { player.sendMessage("§cgetDimension に失敗 → 未登録"); return; }
  player.sendMessage("§agetDimension: OK");
  player.sendMessage(`§7生成帯: §f${st.yMin} 〜 ${st.yMax} §7(${st.h}ブロック)`);
  // バイオームが読まれているか。実験機能が無効だと既定のバイオームのまま
  try {
    const b = player.dimension.getBiome(player.location);
    const id = b?.id ?? b?.typeId ?? String(b);
    const ok = id && id.startsWith("cavern:");
    player.sendMessage(`§7現在のバイオーム: §f${id} ${ok ? "§a(自作が効いている)" : "§c(自作が読まれていない)"}`);
  } catch (e) {
    player.sendMessage("§7現在のバイオーム: §8取得不可 — /locate biome cavern:great_cavern で確認");
  }
  player.sendMessage(`§7深層岩の境界: §f${st.deepslateY}`);
  if (st.cfg.fluids) {
    const l = lavaTop(st, Math.floor(player.location.x), Math.floor(player.location.z));
    const w = waterTop(st, Math.floor(player.location.x), Math.floor(player.location.z));
    player.sendMessage(`§7この地点の溶岩面: §f${l}§7 / 水面: §f${w === -Infinity ? "なし" : w}`);
  }

  const tx = Math.floor(player.location.x);
  const tz = Math.floor(player.location.z);
  const ty = Math.floor((st.yMin + st.yMax) / 2);
  lastFillError = null;
  const ok = fillSafe(st, dim, tx, ty, tz, tx, ty, tz, st.blocks.stone);
  player.sendMessage(ok ? "§afillBlocks テスト: OK"
                        : `§cfillBlocks テスト: 失敗 §7${lastFillError ?? "範囲外"}`);
  player.sendMessage(`§7生成キュー: §f${gQueue.length} §7/ 同時実行 §f${running}§7/${WORKERS}`);
  const ps = preState.get(st.cfg.id);
  player.sendMessage(`§7先回り: §f${ps ? `半径 ${Math.min(PRE_RADIUS_MAX, ps.r)}／${PRE_RADIUS_MAX}` : "未開始"}`);
  const R = radiusOf(st);
  const load = (2 * (R + AREA_MARGIN) + 1) ** 2;
  player.sendMessage(`§7生成半径: §f${R} §7/ 強制ロード §f${load}§7チャンク`);
  player.sendMessage(`§7tickingarea: §f${st.areaChunk ? `${st.areaChunk.cx},${st.areaChunk.cz} 中心` : "§c張れていません"}`);
}

function probe(player) {
  const st = stateOf(player.dimension.id) ?? stateOf(DEFAULT_DIM);
  const bx = Math.floor(player.location.x);
  const bz = Math.floor(player.location.z);
  let air = 0, total = 0;
  const hist = new Array(6).fill(0);

  for (let dx = -24; dx <= 24; dx += 3) {
    for (let dz = -24; dz <= 24; dz += 3) {
      const localT = columnContext(st, bx + dx, bz + dz);
      for (let y = st.yMin; y <= st.yMax; y += 2) {
        const open = density(st, bx + dx, y, bz + dz, localT) > 0;
        if (open) air++;
        total++;
        const band = Math.min(5, Math.floor((y - st.yMin) / (st.h / 6)));
        if (open) hist[band]++;
      }
    }
  }

  const pct = (air / total * 100).toFixed(1);
  const v = Number(pct);
  const tag = v < 7 ? " §c← この一帯は痩せています" : v > 20 ? " §b← 空洞の多い一帯です" : "";
  player.sendMessage(`§e空洞率: ${pct}%${tag}`);
  player.sendMessage("§7全体平均は約13%。地域差があるので6%〜41%まで振れます");
  const per = total / 6;
  player.sendMessage("§7層別: " + hist.map((x) => (x / per * 100).toFixed(0) + "%").join(" / "));
}

// ===========================================================================
// 登録
// ===========================================================================

/*
 * ディメンションは BP/dimensions/*.json で宣言している。
 * 以前はスクリプトでも registerCustomDimension していたが、JSON の定義に
 * 置き換えられた旨の警告が出る (= JSON が正しく読まれている) ので撤去した。
 */

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const p = ev.sourceEntity;
  if (!p || p.typeId !== "minecraft:player") return;

  switch (ev.id) {
    case "cavern:enter":  enter(p, resolveDim(ev.message)); break;
    case "cavern:home":   goHome(p); break;
    case "cavern:probe":  probe(p); break;
    case "cavern:rank":   showStatus(p); break;
    case "cavern:assist": showAssist(p); break;
    case "cavern:music":  skipTrack(p); break;
    case "cavern:manual": {
      if (giveManual(p, true, true)) {
        p.sendMessage("§a説明書を渡しました");
      } else {
        p.sendMessage("§c説明書を渡せませんでした");
        p.sendMessage("§7インベントリの空きと、上の行の理由を確認してください");
      }
      break;
    }
    case "cavern:diag":   diag(p, resolveDim(ev.message, p)); break;
    case "cavern:setrank": {
      const n = parseInt((ev.message ?? "").trim(), 10);
      if (isNaN(n) || n < 0 || n >= RANKS.length) {
        p.sendMessage(`§7使い方: /scriptevent cavern:setrank <0〜${RANKS.length - 1}>`);
        RANKS.forEach((r, i) => p.sendMessage(`§8  ${i}: ${r.name} (${r.point})`));
      } else {
        setRank(p, n);
        p.sendMessage(`§eランクを §f${RANKS[n].name}§e にしました`);
      }
      break;
    }
    case "cavern:resethome": {
      for (const st of STATES.values()) p.setDynamicProperty(homeKey(st), undefined);
      p.sendMessage("§e洞窟側の拠点をリセットしました");
      break;
    }
    case "cavern:regen": {
      let n = 0;
      const prefixes = DIMENSIONS.map((c) => `${c.short}:`);
      try {
        for (const id of world.getDynamicPropertyIds()) {
          if (id === PROP_SIGNATURE) continue;
          if (prefixes.some((x) => id.startsWith(x))) {
            world.setDynamicProperty(id, undefined); n++;
          }
        }
      } catch (e) { /* noop */ }
      for (const st of STATES.values()) st.regionCache.clear();
      p.sendMessage(`§e生成済みの記録を破棄しました (${n}件)`);
      p.sendMessage("§7既に置かれたブロックは消えません。新しい場所へ進んでください");
      break;
    }
  }
});

world.afterEvents.playerDimensionChange.subscribe((ev) => {
  if (SILENCE_MUSIC && isCaveDimension(ev.toDimension.id)) silenceMusic(ev.player);
  // 洞窟の外へ出たら凍結は必ず解き、無人になった洞窟の生成待ちを捨てる
  if (!isCaveDimension(ev.toDimension.id)) {
    unfreeze(ev.player);
    try { ev.player.removeEffect("blindness"); } catch (e) { /* noop */ }
  }
  system.run(purgeEmptyQueues);
});

// 取りこぼし対策。洞窟の外にいる凍結を毎秒掃除する
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    if (!frozenPlayers.has(p.id)) continue;
    if (!isCaveDimension(p.dimension.id)) unfreeze(p);
  }
}, 20);

world.afterEvents.playerLeave.subscribe((ev) => frozenPlayers.delete(ev.playerId));

/**
 * バイオームに合わせてモブを置き換える。
 *
 * ハスクやストレイは「空が見える場所」でしか湧かない。砂漠でも地下は
 * 普通のゾンビになる。洞窟は天井が岩盤なので、desert や frozen の
 * タグを付けても永久に湧かない。湧いた直後にこちらで差し替える。
 */
const MOB_SWAP = {
  "cavern:desert_cavern": { "minecraft:zombie": "minecraft:husk" },
  "cavern:ice_cavern": { "minecraft:skeleton": "minecraft:stray" },
};

world.afterEvents.entitySpawn.subscribe((ev) => {
  const e = ev.entity;
  let table;
  try { table = MOB_SWAP[e.dimension.id]; } catch (err) { return; }
  const to = table?.[e.typeId];
  if (!to) return;

  const dim = e.dimension;
  const at = e.location;
  system.run(() => {
    try {
      if (!e.isValid) return;
      e.remove();
      dim.spawnEntity(to, at);
    } catch (err) { /* noop */ }
  });
});

/**
 * 説明書はワールドに初めて参加したときに渡す。
 * 中身は鍵の作り方と洞窟への入り方なので、入ったあとに渡しても遅い。
 * 参加直後は持ち物の準備が整っていないことがあるので少し待つ。
 */
world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn) return;
  const player = ev.player;
  system.runTimeout(() => {
    try {
      if (player.getDynamicProperty(PROP_MANUAL) === true) return;
      if (giveManual(player, false)) {
        player.sendMessage("§7洞窟採掘記の説明書を受け取った");
        player.sendMessage("§8(なくしたら /scriptevent cavern:manual で再入手)");
      }
    } catch (e) {
      console.warn(`[CavernMiner] 説明書の配布に失敗: ${e}`);
    }
  }, 60);
});

// 死亡時は動けないままだと詰むので解除する
world.afterEvents.entityDie.subscribe((ev) => {
  const e = ev.deadEntity;
  if (e?.typeId === "minecraft:player") unfreeze(e);
});

// 旧バージョンが張った tickingarea が残っていると上限を圧迫する
system.run(() => {
  for (const cfg of DIMENSIONS) {
    try {
      world.getDimension(cfg.id).runCommand("tickingarea remove gc_area");
    } catch (e) { /* 無ければそれでいい */ }
  }
});

/**
 * ウォッチドッグの強制終了を防ぐ安全網。
 * 本来は重い処理を分割して避けるべきで、これは最後の砦。
 * 止められると以降の生成が全部止まり、洞窟に閉じ込められる。
 */
try {
  system.beforeEvents.watchdogTerminate.subscribe((ev) => {
    ev.cancel = true;
    console.warn(`[CavernMiner] 処理が重くなりました (${ev.terminateReason})。停止は回避しました`);
  });
} catch (e) {
  console.warn(`[CavernMiner] ウォッチドッグの回避を登録できません: ${e}`);
}

registerOreDrops();
registerMiner();
registerAssist();
registerPortal();
registerAquamarine();
setTravelHandlers((p, target) => enter(p, target), goHome);
if (MUSIC) registerMusic();
system.runInterval(scan, SCAN_INTERVAL);

console.warn("[CavernMiner] loaded");
