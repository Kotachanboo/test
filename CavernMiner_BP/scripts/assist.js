/**
 * 採掘アシスト
 *
 * 原作の4モードを移植:
 *   一括破壊 (quick)  同種ブロックを連結分まとめて壊す
 *   範囲破壊 (ranged) 視線方向に対して N x N の面を壊す
 *   坑道掘り (adit)   視線方向に 1x2 のトンネルを掘り進む
 *   自動切替 (auto)   鉱石なら一括破壊、それ以外は坑道掘り
 *
 * 切り替えは「炭鉱夫のオーブ」を持って使用 (スニーク不要)。
 * Bedrock にはキーバインドAPIが無いのでアイテム方式にしている。
 */

import { world, system, ItemStack } from "@minecraft/server";
import { isCaveDimension } from "./dimensions.js";
import { getRank, RANKS, awardBulk, onPromote } from "./miner.js";

// ===========================================================================
// 設定
// ===========================================================================

/** 洞窟ディメンションの外でもアシストを効かせるか */
const OUTSIDE_DIMENSION = false;

/** 1回のアシストで壊せるブロック数の上限。上げるとラグの原因になる */
const HARD_LIMIT = 64;

/** 1tickあたりに処理するブロック数 */
const PER_TICK = 8;

export const MODES = [
  { key: "disabled", name: "無効",     rank: 0 },
  { key: "quick",    name: "一括破壊", rank: 2 },  // 鉄掘り
  { key: "ranged",   name: "範囲破壊", rank: 3 },  // マグナイト掘り
  { key: "adit",     name: "坑道掘り", rank: 4 },  // 金掘り
  { key: "auto",     name: "自動切替", rank: 5 },  // アクアマリン掘り
];

/** 範囲破壊のサイズ (辺の長さ。3 なら 3x3) */
const RANGED_SIZE = 3;

/** 坑道掘りの長さ */
const ADIT_LENGTH = 8;

/** 一括破壊の起点からの最大距離 */
const QUICK_RANGE = 12;

/**
 * 一括破壊の対象。ここに無いブロックは1個しか壊れない。
 * 石を一括破壊の対象にすると、1回で洞窟の壁が丸ごと消えて危険。
 */
const QUICK_TARGETS = new Set([
  "cavern:aquamarine_ore", "cavern:deepslate_aquamarine_ore",
  "cavern:magnite_ore", "cavern:deepslate_magnite_ore",
  "cavern:randomite_ore", "cavern:deepslate_randomite_ore",
  "cavern:hexcite_ore",
  "minecraft:coal_ore", "minecraft:deepslate_coal_ore",
  "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
  "minecraft:iron_ore", "minecraft:deepslate_iron_ore",
  "minecraft:gold_ore", "minecraft:deepslate_gold_ore",
  "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore",
  "minecraft:lit_redstone_ore", "minecraft:lit_deepslate_redstone_ore",
  "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore",
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
  "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore",
]);

/** 絶対に壊さないブロック */
const PROTECTED = new Set([
  "minecraft:bedrock", "minecraft:air", "minecraft:water", "minecraft:flowing_water",
  "minecraft:lava", "minecraft:flowing_lava", "minecraft:chest", "minecraft:barrel",
  "minecraft:trapped_chest", "minecraft:ender_chest", "minecraft:shulker_box",
]);

/**
 * 幸運が効くブロック。
 * setblock destroy はツールの付呪を見てくれないので、幸運のぶんだけ自分で足す。
 */
const FORTUNE_DROPS = {
  "minecraft:coal_ore": "minecraft:coal",
  "minecraft:deepslate_coal_ore": "minecraft:coal",
  "minecraft:diamond_ore": "minecraft:diamond",
  "minecraft:deepslate_diamond_ore": "minecraft:diamond",
  "minecraft:emerald_ore": "minecraft:emerald",
  "minecraft:deepslate_emerald_ore": "minecraft:emerald",
  "minecraft:lapis_ore": "minecraft:lapis_lazuli",
  "minecraft:deepslate_lapis_ore": "minecraft:lapis_lazuli",
  "minecraft:redstone_ore": "minecraft:redstone",
  "minecraft:deepslate_redstone_ore": "minecraft:redstone",
  "minecraft:lit_redstone_ore": "minecraft:redstone",
  "minecraft:lit_deepslate_redstone_ore": "minecraft:redstone",
};

const PROP_MODE = "cavern:assist";

/** オーブを支給済みか */
const PROP_ORB_GIVEN = "cavern:orb_given";

// ===========================================================================
// モード管理
// ===========================================================================

export function getMode(player) {
  const v = player.getDynamicProperty(PROP_MODE);
  const i = typeof v === "number" ? v : 0;
  // ランクが足りなくなった場合 (仕様変更など) は無効に落とす
  return MODES[i] && getRank(player) >= MODES[i].rank ? i : 0;
}

function cycleMode(player) {
  const rank = getRank(player);
  const avail = MODES.map((m, i) => i).filter((i) => rank >= MODES[i].rank);

  if (avail.length <= 1) {
    const need = MODES[1].rank;
    player.sendMessage(`§7採掘アシストは §f${RANKS[need].name}§7 になるまで使用できません`);
    try { player.playSound("note.bass", { volume: 0.6, pitch: 0.7 }); } catch (e) {}
    return;
  }

  const cur = avail.indexOf(getMode(player));
  const next = avail[(cur + 1) % avail.length];
  player.setDynamicProperty(PROP_MODE, next);

  const m = MODES[next];
  player.sendMessage(`§e採掘アシストが §f${m.name}§e に変更されました`);
  try {
    player.onScreenDisplay.setActionBar(`§6採掘アシスト: §f${m.name}`);
    player.playSound("random.click", { volume: 0.8, pitch: next === 0 ? 0.8 : 1.2 });
  } catch (e) {}
}

// ===========================================================================
// 対象ブロックの決定
// ===========================================================================

function key(p) { return `${p.x},${p.y},${p.z}`; }

/** 連結した同種ブロックを幅優先で集める */
function collectQuick(dim, origin, typeId, limit) {
  const out = [];
  const seen = new Set([key(origin)]);
  const queue = [origin];

  while (queue.length > 0 && out.length < limit) {
    const cur = queue.shift();

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const p = { x: cur.x + dx, y: cur.y + dy, z: cur.z + dz };
          const k = key(p);
          if (seen.has(k)) continue;
          if (Math.abs(p.x - origin.x) > QUICK_RANGE ||
              Math.abs(p.y - origin.y) > QUICK_RANGE ||
              Math.abs(p.z - origin.z) > QUICK_RANGE) continue;
          seen.add(k);

          let b;
          try { b = dim.getBlock(p); } catch (e) { continue; }
          if (!b) continue;
          // レッドストーン鉱石は光っている状態と別IDになる
          if (b.typeId !== typeId && !sameOre(b.typeId, typeId)) continue;

          out.push(p);
          queue.push(p);
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

function sameOre(a, b) {
  const n = (s) => s.replace("minecraft:lit_", "minecraft:");
  return n(a) === n(b);
}

/** プレイヤーの視線から主軸を求める */
function facing(player) {
  const v = player.getViewDirection();
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ay >= ax && ay >= az) return { x: 0, y: v.y > 0 ? 1 : -1, z: 0 };
  if (ax >= az) return { x: v.x > 0 ? 1 : -1, y: 0, z: 0 };
  return { x: 0, y: 0, z: v.z > 0 ? 1 : -1 };
}

function collectRanged(origin, player, size) {
  const f = facing(player);
  const r = Math.floor(size / 2);
  const out = [];

  for (let a = -r; a <= r; a++) {
    for (let b = -r; b <= r; b++) {
      if (a === 0 && b === 0) continue;
      let p;
      if (f.y !== 0)      p = { x: origin.x + a, y: origin.y, z: origin.z + b };
      else if (f.x !== 0) p = { x: origin.x, y: origin.y + a, z: origin.z + b };
      else                p = { x: origin.x + a, y: origin.y + b, z: origin.z };
      out.push(p);
    }
  }
  return out;
}

function collectAdit(origin, player, length) {
  const f = facing(player);
  const out = [];
  // 1x2 のトンネル。縦向きに掘るときは 1x1
  for (let i = 1; i <= length; i++) {
    const p = { x: origin.x + f.x * i, y: origin.y + f.y * i, z: origin.z + f.z * i };
    out.push(p);
    if (f.y === 0) out.push({ x: p.x, y: p.y + 1, z: p.z });
  }
  return out;
}

// ===========================================================================
// 破壊の実行
// ===========================================================================

function toolOf(player) {
  try {
    const eq = player.getComponent("minecraft:equippable");
    return { eq, stack: eq?.getEquipment("Mainhand") };
  } catch (e) {
    return { eq: null, stack: undefined };
  }
}

function enchantLevel(stack, id) {
  try {
    const e = stack?.getComponent("minecraft:enchantable");
    if (!e) return 0;
    for (const ench of e.getEnchantments()) if (ench.type.id === id) return ench.level;
  } catch (e) { /* noop */ }
  return 0;
}

/** 幸運の追加ドロップ量 (バニラ準拠: 1/(lv+2) で等倍、それ以外は 2〜lv+1 倍) */
function fortuneBonus(level) {
  if (level <= 0) return 0;
  const r = Math.floor(Math.random() * (level + 2));
  return r <= 1 ? 0 : r - 1;
}

/**
 * ツールの耐久を減らす。
 * 壊れたら false を返し、アシストを打ち切る。
 */
function damageTool(player, amount) {
  const { eq, stack } = toolOf(player);
  if (!stack || !eq) return true;

  try {
    const dur = stack.getComponent("minecraft:durability");
    if (!dur) return true;

    // 耐久力エンチャントぶんを確率で無視する
    const unbreaking = enchantLevel(stack, "unbreaking");
    let real = 0;
    for (let i = 0; i < amount; i++) {
      if (unbreaking > 0 && Math.random() < unbreaking / (unbreaking + 1)) continue;
      real++;
    }
    if (real === 0) return true;

    dur.damage = Math.min(dur.maxDurability, dur.damage + real);
    if (dur.damage >= dur.maxDurability) {
      eq.setEquipment("Mainhand", undefined);
      try { player.playSound("random.break", { volume: 0.9 }); } catch (e) {}
      return false;
    }
    eq.setEquipment("Mainhand", stack);
    return true;
  } catch (e) {
    return true;
  }
}

function* breakAll(player, dim, targets, silk, fortune, collectAt) {
  let n = 0;
  const broken = [];   // 採掘ポイント用

  for (const p of targets) {
    let b;
    try { b = dim.getBlock(p); } catch (e) { continue; }
    if (!b) continue;

    const id = b.typeId;
    if (PROTECTED.has(id)) continue;
    if (id === "minecraft:air") continue;

    if (silk) {
      // シルクタッチ: ブロックそのものを落として静かに消す
      try {
        dim.spawnItem(new ItemStack(id, 1), collectAt);
        b.setType("minecraft:air");
      } catch (e) { /* 一部ブロックは ItemStack にできない */
        try { dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} air destroy`); } catch (e2) {}
      }
    } else {
      // destroy を使うとバニラのルートテーブルがそのまま効く
      try { dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} air destroy`); } catch (e) { continue; }

      // 幸運は setblock では効かないので自分で足す
      const bonusItem = FORTUNE_DROPS[id];
      if (bonusItem && fortune > 0) {
        const extra = fortuneBonus(fortune);
        if (extra > 0) {
          try { dim.spawnItem(new ItemStack(bonusItem, extra), collectAt); } catch (e) {}
        }
      }
    }

    n++;
    broken.push(id);
    if (!damageTool(player, 1)) break;
    if (n % PER_TICK === 0) yield;
  }

  // 起点のブロックは miner.js 側で既に加算済みなので、追加分だけ渡す
  if (broken.length > 0) awardBulk(player, broken);
}

// ===========================================================================
// イベント
// ===========================================================================

function onBreak(ev) {
  if (!OUTSIDE_DIMENSION && !isCaveDimension(ev.dimension.id)) return;

  const player = ev.player;
  if (player.getGameMode?.() === "creative") return;

  const modeIndex = getMode(player);
  if (modeIndex === 0) return;

  const brokenId = ev.brokenBlockPermutation.type.id;
  const origin = ev.block.location;
  const dim = ev.dimension;

  const { stack } = toolOf(player);
  if (!stack || !stack.typeId.endsWith("_pickaxe")) return;

  const silk = enchantLevel(stack, "silk_touch") > 0;
  const fortune = enchantLevel(stack, "fortune");

  // --- モードに応じて対象を集める ---
  let mode = MODES[modeIndex].key;
  if (mode === "auto") mode = QUICK_TARGETS.has(brokenId) ? "quick" : "adit";

  let targets;
  if (mode === "quick") {
    if (!QUICK_TARGETS.has(brokenId)) return;
    targets = collectQuick(dim, origin, brokenId, HARD_LIMIT);
  } else if (mode === "ranged") {
    targets = collectRanged(origin, player, RANGED_SIZE);
  } else if (mode === "adit") {
    targets = collectAdit(origin, player, ADIT_LENGTH);
  } else {
    return;
  }

  if (targets.length === 0) return;
  if (targets.length > HARD_LIMIT) targets = targets.slice(0, HARD_LIMIT);

  // ドロップを一箇所に集める
  const collectAt = { x: origin.x + 0.5, y: origin.y + 0.5, z: origin.z + 0.5 };

  system.runJob(breakAll(player, dim, targets, silk, fortune, collectAt));
}

function onUseOrb(ev) {
  if (ev.itemStack?.typeId !== "cavern:miner_orb") return;
  cycleMode(ev.source);
}

/** 自作ツール。採掘では耐久が減らないので自前で削る */
const CUSTOM_TOOLS = new Set([
  "cavern:magnite_pickaxe", "cavern:magnite_axe", "cavern:magnite_shovel",
  "cavern:magnite_hoe", "cavern:magnite_sword",
  "cavern:aquamarine_pickaxe", "cavern:aquamarine_axe", "cavern:aquamarine_shovel",
  "cavern:aquamarine_hoe", "cavern:aquamarine_sword",
  "cavern:sunstone_pickaxe", "cavern:sunstone_axe", "cavern:sunstone_shovel",
  "cavern:sunstone_hoe", "cavern:sunstone_sword",
  "cavern:cryolite_pickaxe", "cavern:cryolite_axe", "cavern:cryolite_shovel",
  "cavern:cryolite_hoe", "cavern:cryolite_sword",
]);

/**
 * カスタムツールの採掘耐久。
 * 公式ドキュメントに「digger であってもブロック採掘では耐久が減らない」と
 * 明記されている。エンティティを殴ったときは自動で減るので、
 * ここでは採掘ぶんだけを補う。
 */
function onBreakDurability(ev) {
  const player = ev.player;
  if (player.getGameMode?.() === "creative") return;

  const { stack } = toolOf(player);
  if (!stack || !CUSTOM_TOOLS.has(stack.typeId)) return;

  damageTool(player, 1);
}

export function registerAssist() {
  world.afterEvents.playerBreakBlock.subscribe(onBreakDurability);
  world.afterEvents.playerBreakBlock.subscribe(onBreak);
  world.afterEvents.itemUse.subscribe(onUseOrb);

  // 昇格でアシストが解放されても黙っていると気づかれないので通知する
  onPromote((player, newRank, oldRank) => {
    const unlocked = MODES.filter((m) => m.rank > oldRank && m.rank <= newRank);
    if (unlocked.length === 0) return;

    for (const m of unlocked) {
      player.sendMessage(`§b採掘アシスト「${m.name}」が使えるようになった`);
    }

    // 初めてアシストが解放されたらオーブを支給する。
    // レシピには金インゴットが要るが、金は深層にしか湧かないので、
    // 解放された時点ではまだ作れないことが多い。
    if (giveOrb(player)) {
      player.sendMessage("§e炭鉱夫のオーブ§7を受け取った");
      player.sendMessage("§7手に持って使うとモードが切り替わります");
    } else {
      player.sendMessage("§7炭鉱夫のオーブを使うと切り替えられます");
    }
  });
}

/**
 * オーブを1回だけ支給する。
 * 支給済みなら false を返す。
 */
function giveOrb(player) {
  if (typeof player.getDynamicProperty(PROP_ORB_GIVEN) === "number") return false;

  const stack = new ItemStack("cavern:miner_orb", 1);
  let delivered = false;
  try {
    const inv = player.getComponent("minecraft:inventory");
    if (inv?.container && inv.container.emptySlotsCount > 0) {
      inv.container.addItem(stack);
      delivered = true;
    }
  } catch (e) { /* noop */ }

  if (!delivered) {
    // 手持ちが一杯なら足元に落とす
    try {
      player.dimension.spawnItem(stack, player.location);
      delivered = true;
    } catch (e) {
      console.warn(`[CavernMiner] オーブの支給に失敗: ${e}`);
    }
  }

  if (delivered) {
    player.setDynamicProperty(PROP_ORB_GIVEN, 1);
    try { player.playSound("random.pop", { volume: 0.8, pitch: 1.2 }); } catch (e) {}
  }
  return delivered;
}

export function showAssist(player) {
  const rank = getRank(player);
  const m = MODES[getMode(player)];
  player.sendMessage("§6=== 採掘アシスト ===");
  player.sendMessage(`§7現在のモード: §f${m.name}`);
  for (const mode of MODES) {
    if (mode.rank === 0) continue;
    const ok = rank >= mode.rank;
    player.sendMessage(
      ok ? `§a✔ ${mode.name}` : `§8✘ ${mode.name} §7(${RANKS[mode.rank].name}で解放)`);
  }
  player.sendMessage("§7炭鉱夫のオーブを使うとモードが切り替わります");
}
