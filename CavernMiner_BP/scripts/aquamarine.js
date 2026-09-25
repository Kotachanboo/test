/**
 * アクアマリン装備の能力
 *
 * マグナイトが「速く強いが脆い」なら、アクアマリンは「粘り強く水に強い」。
 * 性能差だけでなく、水まわりの挙動で性格を分ける。
 *
 * 共通  : 水中で採掘速度の低下を打ち消し、水中呼吸を与える
 * 剣    : 水に濡れた相手へ追加ダメージ
 * 斧    : 水中での移動が速くなる
 * スコップ: 砂・砂利・粘土から確率で追加ドロップ
 * クワ  : 草・葉・海草の回収量が増える
 */

import { world, system, ItemStack } from "@minecraft/server";

const TOOLS = new Set([
  "cavern:aquamarine_pickaxe", "cavern:aquamarine_axe",
  "cavern:aquamarine_shovel", "cavern:aquamarine_hoe",
  "cavern:aquamarine_sword",
]);

/** 水に入っている間の効果。採掘速度の低下を打ち消す狙い */
const WATER_HASTE = 2;      // 採掘速度上昇III相当
const CHECK_INTERVAL = 20;

/** スコップの追加ドロップ */
const SHOVEL_BONUS = {
  "minecraft:sand": "minecraft:sand",
  "minecraft:red_sand": "minecraft:red_sand",
  "minecraft:gravel": "minecraft:gravel",
  "minecraft:clay": "minecraft:clay_ball",
  "minecraft:dirt": null,
};
const SHOVEL_CHANCE = 0.35;

/** クワの追加ドロップ */
const HOE_BONUS = new Set([
  "minecraft:kelp", "minecraft:seagrass", "minecraft:tall_seagrass",
  "minecraft:short_grass", "minecraft:tall_grass", "minecraft:fern",
]);
const HOE_CHANCE = 0.5;

/** 剣が水に濡れた相手へ与える追加ダメージ */
const SWORD_WET_BONUS = 4;

// ===========================================================================

function heldTool(player) {
  try {
    const eq = player.getComponent("minecraft:equippable");
    const stack = eq?.getEquipment("Mainhand");
    return stack && TOOLS.has(stack.typeId) ? stack.typeId : null;
  } catch (e) {
    return null;
  }
}

function inWater(entity) {
  try {
    const l = entity.location;
    const b = entity.dimension.getBlock({
      x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z),
    });
    return !!b && (b.typeId === "minecraft:water" || b.typeId === "minecraft:flowing_water");
  } catch (e) {
    return false;
  }
}

/** 水中にいる間の共通効果 */
function tick() {
  for (const player of world.getAllPlayers()) {
    const tool = heldTool(player);
    if (!tool) continue;
    if (!inWater(player)) continue;

    try {
      // 水中の採掘は通常5倍遅い。採掘速度上昇で打ち消す
      player.addEffect("haste", 60, { amplifier: WATER_HASTE, showParticles: false });
      player.addEffect("water_breathing", 60, { showParticles: false });

      // 斧だけは水中での移動も速くする
      if (tool === "cavern:aquamarine_axe") {
        player.addEffect("speed", 60, { amplifier: 1, showParticles: false });
      }
    } catch (e) { /* noop */ }
  }
}

// ===========================================================================
// 採掘時の追加ドロップ
// ===========================================================================

function onBreak(ev) {
  const player = ev.player;
  if (player.getGameMode?.() === "creative") return;

  const tool = heldTool(player);
  if (!tool) return;

  const id = ev.brokenBlockPermutation?.type?.id;
  if (!id) return;

  const dim = ev.dimension;
  const at = {
    x: ev.block.location.x + 0.5,
    y: ev.block.location.y + 0.5,
    z: ev.block.location.z + 0.5,
  };

  let drop = null;
  if (tool === "cavern:aquamarine_shovel" && id in SHOVEL_BONUS) {
    if (Math.random() < SHOVEL_CHANCE) drop = SHOVEL_BONUS[id] ?? id;
  } else if (tool === "cavern:aquamarine_hoe" && HOE_BONUS.has(id)) {
    if (Math.random() < HOE_CHANCE) drop = id;
  }

  if (!drop) return;
  try {
    dim.spawnItem(new ItemStack(drop, 1), at);
  } catch (e) { /* 一部ブロックはアイテム化できない */ }
}

// ===========================================================================
// 剣の追加ダメージ
// ===========================================================================

function onHit(ev) {
  const src = ev.damageSource?.damagingEntity;
  if (!src || src.typeId !== "minecraft:player") return;
  if (heldTool(src) !== "cavern:aquamarine_sword") return;

  const target = ev.hurtEntity;
  if (!target || !inWater(target)) return;

  try {
    target.applyDamage(SWORD_WET_BONUS, {
      cause: "entityAttack", damagingEntity: src,
    });
    src.dimension.playSound("random.splash", target.location, { volume: 0.5 });
  } catch (e) { /* noop */ }
}

// ===========================================================================

// ===========================================================================
// 陽石装備: 手に持っている間は火炎耐性
// ===========================================================================

const SUN_TOOLS = new Set([
  "cavern:sunstone_pickaxe", "cavern:sunstone_axe", "cavern:sunstone_shovel",
  "cavern:sunstone_hoe", "cavern:sunstone_sword",
]);

function sunTick() {
  for (const player of world.getAllPlayers()) {
    try {
      const eq = player.getComponent("minecraft:equippable");
      const stack = eq?.getEquipment("Mainhand");
      if (!stack || !SUN_TOOLS.has(stack.typeId)) continue;
      player.addEffect("fire_resistance", 60, { showParticles: false });
    } catch (e) { /* noop */ }
  }
}

// ===========================================================================
// 氷晶石装備: 当てた相手に鈍化
// ===========================================================================

const CRYO_TOOLS = new Set([
  "cavern:cryolite_pickaxe", "cavern:cryolite_axe", "cavern:cryolite_shovel",
  "cavern:cryolite_hoe", "cavern:cryolite_sword",
]);

function onCryoHit(ev) {
  const src = ev.damageSource?.damagingEntity;
  if (!src || src.typeId !== "minecraft:player") return;
  try {
    const eq = src.getComponent("minecraft:equippable");
    const stack = eq?.getEquipment("Mainhand");
    if (!stack || !CRYO_TOOLS.has(stack.typeId)) return;
    // 剣は強く長く、他のツールは軽く
    const sword = stack.typeId === "cavern:cryolite_sword";
    ev.hurtEntity.addEffect("slowness", sword ? 80 : 40, { amplifier: sword ? 1 : 0 });
  } catch (e) { /* noop */ }
}

export function registerAquamarine() {
  world.afterEvents.entityHurt.subscribe(onCryoHit);
  system.runInterval(tick, CHECK_INTERVAL);
  system.runInterval(sunTick, CHECK_INTERVAL);
  world.afterEvents.playerBreakBlock.subscribe(onBreak);
  world.afterEvents.entityHurt.subscribe(onHit);
}
