/**
 * 採掘ポイントと炭鉱夫ランク
 *
 * 原作どおり、ポイントが入るのは洞窟ディメンションの中だけ。
 * オーバーワールドで整地してもランクは上がらない。
 *
 * 保存は player の dynamic property。ワールドをまたいでは持ち越さない。
 */

import { world, system } from "@minecraft/server";
import { isCaveDimension } from "./dimensions.js";

// ===========================================================================
// ポイント表
// ===========================================================================

/** ブロックごとの基礎ポイント。ここに無いブロックはポイントにならない */
const POINTS = {
  "minecraft:stone": 1,
  "minecraft:deepslate": 1,
  "minecraft:cobblestone": 1,
  "minecraft:cobbled_deepslate": 1,
  // 各ディメンションの母岩。ここに無いと掘っても点が入らない
  "minecraft:sandstone": 1,
  "minecraft:red_sandstone": 1,
  "minecraft:packed_ice": 1,
  "minecraft:blue_ice": 1,
  "cavern:frozen_stone": 1,
  "cavern:frozen_deepslate": 1,
  "minecraft:coal_ore": 3,
  "minecraft:deepslate_coal_ore": 3,
  "minecraft:copper_ore": 4,
  "minecraft:deepslate_copper_ore": 4,
  "cavern:magnite_ore": 5,
  "cavern:deepslate_magnite_ore": 5,
  "minecraft:iron_ore": 6,
  "minecraft:deepslate_iron_ore": 6,
  "minecraft:redstone_ore": 8,
  "minecraft:deepslate_redstone_ore": 8,
  "minecraft:lapis_ore": 9,
  "minecraft:deepslate_lapis_ore": 9,
  "cavern:aquamarine_ore": 10,
  "cavern:deepslate_aquamarine_ore": 10,
  "minecraft:gold_ore": 12,
  "minecraft:deepslate_gold_ore": 12,
  "cavern:randomite_ore": 15,
  "cavern:deepslate_randomite_ore": 15,
  "minecraft:diamond_ore": 25,
  "minecraft:deepslate_diamond_ore": 25,
  "minecraft:emerald_ore": 30,
  "minecraft:deepslate_emerald_ore": 30,
  "cavern:hexcite_ore": 50,
  "cavern:sunstone_ore": 30,
  "cavern:red_sunstone_ore": 36,
  "cavern:cryolite_ore": 30,
  "cavern:blue_cryolite_ore": 36,
};

// ===========================================================================
// ランク
// ===========================================================================

/**
 * 8段階。原作と同じ並び。
 *   point : 必要な累計ポイント
 *   haste : そのランクで常時かかる採掘速度上昇 (0 なし / 1 = 効果レベルI)
 */
export const RANKS = [
  { key: "beginner",  name: "初心者",           point: 0,     haste: 0 },
  { key: "stone",     name: "石掘り",           point: 700,   haste: 0 },
  { key: "iron",      name: "鉄掘り",           point: 2900,   haste: 0 },
  { key: "magnite",   name: "マグナイト掘り",   point: 8800,  haste: 1 },
  { key: "gold",      name: "金掘り",           point: 18000,  haste: 1 },
  { key: "aqua",      name: "アクアマリン掘り", point: 33000,  haste: 1 },
  { key: "hexcite",   name: "ヘキサイト掘り",   point: 55000, haste: 2 },
  { key: "diamond",   name: "ダイヤモンド掘り", point: 88000, haste: 2 },
];

// ===========================================================================
// コンボとクリティカル
// ===========================================================================

const COMBO = {
  window: 60,        // 前の採掘からこの tick 以内なら継続
  max: 20,           // コンボ数の上限
  bonusPerHit: 0.05, // 1コンボあたりの倍率上昇 (最大 +100%)
  minBase: 3,        // これ未満のブロックはコンボに乗らない
  // 石をコンボ対象にすると「石を掘り続けるのが最効率」になり、
  // 鉱石を探す動機が消える。石は1点固定のまま据え置く。
};

const CRITICAL = {
  baseChance: 0.04,      // 初心者の発生率
  chancePerRank: 0.005,  // ランク1つごとの上乗せ
  multiplier: 3,
};

// ===========================================================================
// プレイヤー状態
// ===========================================================================

const PROP_POINT = "cavern:point";
const PROP_RANK = "cavern:rank";

/** tick 単位の一時状態。保存しない */
const combo = new Map();   // playerId -> { count, lastTick }

export function getPoint(player) {
  const v = player.getDynamicProperty(PROP_POINT);
  return typeof v === "number" ? v : 0;
}

/** 現在のランク番号 (0〜7) */
export function getRank(player) {
  const v = player.getDynamicProperty(PROP_RANK);
  return typeof v === "number" ? v : 0;
}

/** ランクを直接設定する。動作確認用 */
export function setRank(player, rank) {
  const r = Math.max(0, Math.min(RANKS.length - 1, rank | 0));
  player.setDynamicProperty(PROP_RANK, r);
  player.setDynamicProperty(PROP_POINT, RANKS[r].point);
  return r;
}

/** 到達しているべきランクを累計ポイントから求める */
function rankFor(point) {
  let r = 0;
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (point >= RANKS[i].point) { r = i; break; }
  }
  return r;
}

/**
 * 昇格時に呼ばれる処理の登録口。
 * assist.js から解放通知を差し込むために使う (循環importを避ける)。
 */
const promoteHooks = [];

export function onPromote(fn) {
  promoteHooks.push(fn);
}

function promote(player, newRank) {
  const oldRank = getRank(player);
  player.setDynamicProperty(PROP_RANK, newRank);
  const r = RANKS[newRank];

  try {
    player.onScreenDisplay.setTitle("§6ランクアップ！", {
      subtitle: `§f${r.name}`,
      fadeInDuration: 8,
      stayDuration: 50,
      fadeOutDuration: 16,
    });
    player.playSound("random.levelup", { volume: 0.8 });
  } catch (e) { /* noop */ }

  player.sendMessage(`§eおめでとうございます！ 炭鉱夫ランクが §6${r.name}§e になりました。`);

  // 定期処理を待たずにその場で掛ける。
  // 100tickごとの掛け直しに任せると、昇格してから最大5秒間なにも起きない
  if (r.haste > 0) {
    try {
      player.addEffect("haste", 200, { amplifier: r.haste - 1, showParticles: false });
    } catch (e) { /* noop */ }
    player.sendMessage(`§7採掘速度が上がった (採掘速度上昇 ${"I".repeat(r.haste)})`);
  }

  for (const fn of promoteHooks) {
    try { fn(player, newRank, oldRank); } catch (e) { console.warn(`[CavernMiner] ${e}`); }
  }
}

// ===========================================================================
// 採掘処理
// ===========================================================================

function onBreak(ev) {
  // --- ここがディメンション制限。原作の isInCaveDimensions 相当 ---
  if (!isCaveDimension(ev.dimension.id)) return;

  const base = POINTS[ev.brokenBlockPermutation.type.id];
  if (!base) return;

  const player = ev.player;
  if (player.getGameMode?.() === "creative") return;

  const now = system.currentTick;
  const id = player.id;

  // --- コンボ。鉱石だけが対象 ---
  const eligible = base >= COMBO.minBase;
  let count = 0;
  if (eligible) {
    const c = combo.get(id);
    if (c && now - c.lastTick <= COMBO.window) {
      count = Math.min(COMBO.max, c.count + 1);
    }
    combo.set(id, { count, lastTick: now });
  }

  let gain = base * (1 + count * COMBO.bonusPerHit);

  // --- クリティカル採掘 ---
  const rank = getRank(player);
  const chance = CRITICAL.baseChance + rank * CRITICAL.chancePerRank;
  let critical = false;
  if (Math.random() < chance) {
    gain *= CRITICAL.multiplier;
    critical = true;
  }

  gain = Math.max(1, Math.round(gain));

  const point = getPoint(player) + gain;
  player.setDynamicProperty(PROP_POINT, point);

  // --- 昇格判定 ---
  const should = rankFor(point);
  if (should > rank) {
    promote(player, should);
    return;   // 昇格の表示を潰さない
  }

  // --- アクションバー表示 ---
  const r = RANKS[rank];
  const next = RANKS[rank + 1];
  const progress = next ? `§8${point}§7/§8${next.point}` : `§8${point}`;
  const comboText = count > 0 ? ` §b${count}combo` : "";
  const gainText = critical ? `§6+${gain} 大成功！` : `§a+${gain}`;

  try {
    player.onScreenDisplay.setActionBar(`${gainText}${comboText}  §7${r.name} ${progress}`);
    if (critical) player.playSound("random.orb", { volume: 0.6, pitch: 1.4 });
  } catch (e) { /* noop */ }
}

/**
 * 採掘アシストで壊したぶんのポイントをまとめて加算する。
 * コンボは「1回の採掘」として1段だけ進める。
 * これをしないとアシストのモードを上げるほどコンボが暴走する。
 */
export function awardBulk(player, blockIds) {
  if (!isCaveDimension(player.dimension.id)) return;
  if (player.getGameMode?.() === "creative") return;

  let base = 0;
  let oreCount = 0;
  for (const id of blockIds) {
    const p = POINTS[id];
    if (!p) continue;
    base += p;
    if (p >= COMBO.minBase) oreCount++;
  }
  if (base <= 0) return;

  const c = combo.get(player.id);
  const count = c ? c.count : 0;
  const gain = Math.max(1, Math.round(base * (1 + count * COMBO.bonusPerHit)));

  const point = getPoint(player) + gain;
  player.setDynamicProperty(PROP_POINT, point);

  const rank = getRank(player);
  const should = rankFor(point);
  if (should > rank) { promote(player, should); return; }

  const r = RANKS[rank];
  const next = RANKS[rank + 1];
  const progress = next ? `§8${point}§7/§8${next.point}` : `§8${point}`;
  try {
    player.onScreenDisplay.setActionBar(
      `§a+${gain} §7(${blockIds.length}ブロック${oreCount > 0 ? ` 鉱石${oreCount}` : ""})  §7${r.name} ${progress}`);
  } catch (e) { /* noop */ }
}

// ===========================================================================
// ランク特典 (採掘速度上昇)
// ===========================================================================

function applyRankBuff() {
  for (const player of world.getAllPlayers()) {
    if (!isCaveDimension(player.dimension.id)) continue;
    const haste = RANKS[getRank(player)].haste;
    if (haste <= 0) continue;
    try {
      player.addEffect("haste", 120, { amplifier: haste - 1, showParticles: false });
    } catch (e) { /* noop */ }
  }
}

// ===========================================================================
// 状態表示
// ===========================================================================

export function showStatus(player) {
  const point = getPoint(player);
  const rank = getRank(player);
  const r = RANKS[rank];
  const next = RANKS[rank + 1];

  player.sendMessage("§6=== 炭鉱夫ステータス ===");
  player.sendMessage(`§7ランク: §f${r.name}`);
  player.sendMessage(`§7採掘ポイント: §f${point}`);
  if (next) {
    player.sendMessage(`§7次のランクまで: §f${next.point - point} §7(${next.name})`);
  } else {
    player.sendMessage("§e最高ランクに到達しています");
  }
  if (r.haste > 0) player.sendMessage(`§7特典: 採掘速度上昇 ${"I".repeat(r.haste)}`);
}

// ===========================================================================
// 登録
// ===========================================================================

export function registerMiner() {
  world.afterEvents.playerBreakBlock.subscribe(onBreak);
  system.runInterval(applyRankBuff, 100);

  // 退出時にコンボ状態を捨てる
  world.afterEvents.playerLeave.subscribe((ev) => combo.delete(ev.playerId));
}
