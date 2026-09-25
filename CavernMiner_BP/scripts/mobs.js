/**
 * 洞窟ごとのモブ
 *
 * ハスクやストレイ、パーチド、ラクダハスクは「空が見える場所」でしか湧かない。
 * 洞窟は天井が岩盤なので、desert や frozen のタグを付けても永久に湧かない。
 * 普通のモブが湧いた直後に、その洞窟の種類へ差し替える。
 *
 * 独自のモブ (氷ゾンビ・ブルースパイダー・砂漠グモ) も同じ仕組みで出す。
 * 湧き条件を一から書くより、バニラの湧き具合をそのまま引き継げる。
 */

import { world, system } from "@minecraft/server";

/**
 * 差し替え表。ディメンション → 元のモブ → 差し替え先。
 *   to     : 差し替え先
 *   chance : 差し替える確率 (省略時は必ず)
 *   event  : 湧かせたあとに起こすイベント
 *   room   : 必要な空間 [半径, 高さ]。足りなければ差し替えない
 *
 * 差し替えた先にも表の行があれば続けて引く (ゾンビ → ハスク → ラクダハスク)。
 */
const MOB_SWAP = {
  "cavern:desert_cavern": {
    "minecraft:zombie": { to: "minecraft:husk" },
    "minecraft:husk": {
      to: "minecraft:camel_husk", chance: 0.12,
      // ハスクとパーチドを乗せて湧く。バニラの湧き方と同じ
      event: "minecraft:spawn_with_rider",
      room: [1, 3],   // 幅1.7・高さ2.4。狭い坑道に出すと挟まる
    },
    "minecraft:skeleton": { to: "minecraft:parched" },
    "minecraft:spider": { to: "cavern:desert_spider" },
    "minecraft:cave_spider": { to: "cavern:desert_spider" },
  },
  "cavern:ice_cavern": {
    "minecraft:zombie": { to: "cavern:ice_zombie" },
    "minecraft:skeleton": { to: "minecraft:stray" },
    "minecraft:spider": { to: "cavern:blue_spider" },
    "minecraft:cave_spider": { to: "cavern:blue_spider" },
  },
};

/** こちらで湧かせたモブ。その湧きイベントでもう一度差し替えないために覚える */
const ours = new Set();

/** 通り抜けられるブロック */
function passable(block) {
  if (!block) return false;
  const id = block.typeId;
  return id === "minecraft:air" || id.startsWith("minecraft:light_block")
      || id === "minecraft:snow_layer" || id === "minecraft:glow_lichen";
}

function hasRoom(dim, at, [r, h]) {
  const x0 = Math.floor(at.x), y0 = Math.floor(at.y), z0 = Math.floor(at.z);
  try {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = 0; dy < h; dy++) {
          if (!passable(dim.getBlock({ x: x0 + dx, y: y0 + dy, z: z0 + dz }))) return false;
        }
      }
    }
  } catch (e) {
    return false;
  }
  return true;
}

/** 表を引いて最終的な差し替え先を決める。差し替えないなら null */
function resolve(table, typeId, dim, at, natural) {
  let type = typeId, event = null, changed = false;
  for (let i = 0; i < 3; i++) {
    const rule = table[type];
    if (!rule) break;
    // 確率で決まるものは自然に湧いたときだけ。ロードのたびに引き直すと
    // いずれ全部がそちらになってしまう
    if (rule.chance !== undefined && (!natural || Math.random() >= rule.chance)) break;
    if (rule.room && !hasRoom(dim, at, rule.room)) break;
    type = rule.to;
    event = rule.event ?? null;
    changed = true;
  }
  return changed ? { type, event } : null;
}

function onSpawn(ev) {
  const e = ev.entity;
  if (ours.delete(e.id)) return;

  // イベントで生まれたもの (ラクダハスクの乗り手など) や、変身・繁殖で
  // 生まれたものは差し替えない。乗り手を差し替えると降ろされてしまう
  const cause = ev.cause;
  if (cause === "Event" || cause === "Born" || cause === "Transformed") return;

  let table;
  try { table = MOB_SWAP[e.dimension.id]; } catch (err) { return; }
  if (!table?.[e.typeId]) return;

  const dim = e.dimension;
  const typeId = e.typeId;
  const natural = cause === undefined || cause === "Spawned";

  system.run(() => {
    try {
      if (!e.isValid) return;
      // 何かに乗っている (または乗せている) ものはそのまま
      if (e.getComponent("minecraft:riding")?.entityRidingOn) return;
      const at = e.location;
      const pick = resolve(table, typeId, dim, at, natural);
      if (!pick) return;
      e.remove();
      const spawned = dim.spawnEntity(pick.type, at);
      ours.add(spawned.id);
      if (pick.event) {
        try { spawned.triggerEvent(pick.event); } catch (err) { /* 古い環境では乗り手なし */ }
      }
    } catch (err) { /* noop */ }
  });
}

export function registerMobs() {
  world.afterEvents.entitySpawn.subscribe(onSpawn);
}
