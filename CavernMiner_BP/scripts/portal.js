/**
 * 洞窟ポータル
 *
 * ディメンションごとに枠のブロックと鍵アイテムが違う。
 * 大空洞     : 苔むした丸石   + 洞窟の鍵
 * 豊穣の洞窟 : 苔むした石レンガ + 豊穣の鍵
 *
 * 判定は「枠の内側の空気を塗りつぶして、その形が長方形で、外周が枠ブロック」。
 * 内側は 2x2 から 21x21 まで。
 */

import { world, system, BlockPermutation } from "@minecraft/server";
import { DIMENSIONS, dimConfig, isCaveDimension } from "./dimensions.js";

const PORTAL_BLOCK = "cavern:cave_portal";

const MIN_INNER = 2;
const MAX_INNER = 21;
const MAX_AREA = 441;

const PROP_RETURN = "cavern:return";
const PROP_SITES = "gc:portal_sites";
const PROP_SIDE = "cavern:side";

/** playerId -> { armed } : ポータルから出るまで false のまま */
const state = new Map();

/** 枠ブロック -> 行き先ディメンション */
const FRAME_TO_DIM = new Map();
/** 鍵アイテム -> 行き先ディメンション */
const KEY_TO_DIM = new Map();

for (const cfg of DIMENSIONS) {
  if (!cfg.portal) continue;
  for (const f of cfg.portal.frame) FRAME_TO_DIM.set(f, cfg.id);
  KEY_TO_DIM.set(cfg.portal.key, cfg.id);
}

const ALL_FRAMES = new Set(FRAME_TO_DIM.keys());

// ===========================================================================
// どちら側にいるか
// ===========================================================================

function markSide(player, side) {
  try { player.setDynamicProperty(PROP_SIDE, side); } catch (e) { /* noop */ }
}

/**
 * ワールド再入場の直後は player.dimension.id が確定しておらず、
 * 洞窟にいるのに「外」と判定されて再度洞窟へ送られることがある。
 * 転送のたびに記録しておき、そちらを優先する。
 */
function inCave(player) {
  const saved = player.getDynamicProperty(PROP_SIDE);
  if (saved === "cave" || saved === "home") return saved === "cave";
  return isCaveDimension(player.dimension.id);
}

// ===========================================================================
// 枠の判定
// ===========================================================================

function isAir(dim, p) {
  try {
    const b = dim.getBlock(p);
    return b ? b.typeId === "minecraft:air" : false;
  } catch (e) {
    return false;
  }
}

function frameIdAt(dim, p) {
  try {
    const b = dim.getBlock(p);
    return b && ALL_FRAMES.has(b.typeId) ? b.typeId : null;
  } catch (e) {
    return null;
  }
}

function buildPos(axis, fixed, u, y) {
  return axis === "x" ? { x: fixed, y, z: u } : { x: u, y, z: fixed };
}

function scanPlane(dim, start, axis) {
  const fixed = start[axis];
  const other = axis === "x" ? "z" : "x";

  const seen = new Set();
  const cells = [];
  const stack = [start];

  while (stack.length > 0) {
    if (cells.length > MAX_AREA) return null;
    const p = stack.pop();
    const k = `${p[other]},${p.y}`;
    if (seen.has(k)) continue;
    seen.add(k);

    if (!isAir(dim, p)) continue;
    cells.push(p);

    for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = { x: p.x, y: p.y + dv, z: p.z };
      q[other] = p[other] + du;
      q[axis] = fixed;
      stack.push(q);
    }
  }
  if (cells.length === 0) return null;

  let uMin = Infinity, uMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const p of cells) {
    if (p[other] < uMin) uMin = p[other];
    if (p[other] > uMax) uMax = p[other];
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }

  const w = uMax - uMin + 1;
  const h = yMax - yMin + 1;
  if (w < MIN_INNER || h < MIN_INNER || w > MAX_INNER || h > MAX_INNER) return null;
  if (cells.length !== w * h) return null;

  // 外周がすべて同じ種類の枠ブロックか
  let kind = null;
  const check = (p) => {
    const id = frameIdAt(dim, p);
    if (!id) return false;
    if (kind === null) kind = id;
    return FRAME_TO_DIM.get(id) === FRAME_TO_DIM.get(kind);
  };

  for (let u = uMin; u <= uMax; u++) {
    if (!check(buildPos(axis, fixed, u, yMin - 1))) return null;
    if (!check(buildPos(axis, fixed, u, yMax + 1))) return null;
  }
  for (let y = yMin; y <= yMax; y++) {
    if (!check(buildPos(axis, fixed, uMin - 1, y))) return null;
    if (!check(buildPos(axis, fixed, uMax + 1, y))) return null;
  }

  return { cells, axis, w, h, target: FRAME_TO_DIM.get(kind) };
}

// ===========================================================================
// 起動
// ===========================================================================

/** ディメンションごとに渦の色を変える */
function kindOf(dimId) {
  return dimConfig(dimId)?.short ?? "gc";
}

export function portalPermutation(axis, dimId) {
  try {
    return BlockPermutation.resolve(PORTAL_BLOCK, {
      "cavern:axis": axis,
      "cavern:kind": kindOf(dimId),
    });
  } catch (e) {
    try {
      return BlockPermutation.resolve(PORTAL_BLOCK, { "cavern:axis": axis });
    } catch (e2) {
      return BlockPermutation.resolve(PORTAL_BLOCK);
    }
  }
}

function consumeKey(player, keyId) {
  try {
    const eq = player.getComponent("minecraft:equippable");
    const stack = eq?.getEquipment("Mainhand");
    if (!stack || stack.typeId !== keyId) return;
    if (player.getGameMode?.() === "creative") return;

    if (stack.amount > 1) {
      stack.amount -= 1;
      eq.setEquipment("Mainhand", stack);
    } else {
      eq.setEquipment("Mainhand", undefined);
    }
  } catch (e) { /* noop */ }
}

function tryIgnite(player, block, itemStack) {
  if (!itemStack) return;
  const keyDim = KEY_TO_DIM.get(itemStack.typeId);
  if (!keyDim) return;

  const dim = player.dimension;
  const l = block.location;
  const origins = [
    { x: l.x, y: l.y + 1, z: l.z },
    { x: l.x + 1, y: l.y, z: l.z },
    { x: l.x - 1, y: l.y, z: l.z },
    { x: l.x, y: l.y, z: l.z + 1 },
    { x: l.x, y: l.y, z: l.z - 1 },
  ];

  for (const origin of origins) {
    if (!isAir(dim, origin)) continue;

    for (const axis of ["x", "z"]) {
      const found = scanPlane(dim, origin, axis);
      if (!found) continue;

      // 鍵と枠が噛み合っているか
      if (found.target !== keyDim) {
        const want = dimConfig(found.target);
        player.sendMessage(`§7この枠には別の鍵が要ります §8(${want?.name ?? found.target})`);
        return;
      }

      const perm = portalPermutation(found.axis, found.target);
      for (const p of found.cells) {
        try { dim.getBlock(p)?.setPermutation(perm); } catch (e) { /* noop */ }
      }

      consumeKey(player, itemStack.typeId);
      try {
        dim.playSound("block.end_portal.spawn", found.cells[0], { volume: 0.8 });
      } catch (e) {
        try { player.playSound("block.end_portal.spawn", { volume: 0.8 }); } catch (e2) {}
      }
      player.sendMessage(`§a${dimConfig(found.target)?.name ?? "洞窟"}への道が開いた`);
      return;
    }
  }
}

/** 枠を壊したら繋がっているポータル面も消す (ネザーゲートと同じ挙動) */
function onFrameBroken(ev) {
  const id = ev.brokenBlockPermutation?.type?.id;
  if (!id || !ALL_FRAMES.has(id)) return;

  const dim = ev.dimension;
  const o = ev.block.location;
  const seen = new Set();
  const stack = [];
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of dirs) stack.push({ x: o.x + dx, y: o.y + dy, z: o.z + dz });

  let removed = 0;
  while (stack.length > 0 && removed < 512) {
    const p = stack.pop();
    const k = `${p.x},${p.y},${p.z}`;
    if (seen.has(k)) continue;
    seen.add(k);

    let b;
    try { b = dim.getBlock(p); } catch (e) { continue; }
    if (!b || b.typeId !== PORTAL_BLOCK) continue;

    try { b.setType("minecraft:air"); removed++; } catch (e) { continue; }
    for (const [dx, dy, dz] of dirs) stack.push({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
  }

  if (removed > 0) {
    try { dim.playSound("random.fizz", o, { volume: 0.6 }); } catch (e) { /* noop */ }
  }
}

// ===========================================================================
// 転送
// ===========================================================================

let travelToCave = null;
let travelHome = null;

export function setTravelHandlers(toCave, toHome) {
  travelToCave = toCave;
  travelHome = toHome;
}

export function saveReturn(player) {
  const l = player.location;
  player.setDynamicProperty(PROP_RETURN,
    JSON.stringify({ x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) }));
}

export function loadReturn(player) {
  const raw = player.getDynamicProperty(PROP_RETURN);
  if (typeof raw !== "string") return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o.x === "number" && typeof o.y === "number" && typeof o.z === "number") return o;
  } catch (e) { /* noop */ }
  return null;
}

function portalAt(player) {
  try {
    const l = player.location;
    const p = { x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) };
    const b = player.dimension.getBlock(p);
    return b && b.typeId === PORTAL_BLOCK ? p : null;
  } catch (e) {
    return null;
  }
}

/** ポータルが繋がっている先。枠のブロックから判断する */
function targetOf(dim, p) {
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (let step = 1; step <= 24; step++) {
    for (const [dx, dy, dz] of dirs) {
      const q = { x: p.x + dx * step, y: p.y + dy * step, z: p.z + dz * step };
      const id = frameIdAt(dim, q);
      if (id) return FRAME_TO_DIM.get(id);
    }
  }
  return null;
}

/**
 * ネザーゲートと同じく「一度ポータルから出るまで再発動しない」。
 * 時間だけのクールダウンにすると、転送先でポータルの中に立っている間に
 * 時間が切れて往復し続ける。
 */
function checkPortals() {
  for (const player of world.getAllPlayers()) {
    const id = player.id;
    const at = portalAt(player);
    let st = state.get(id);

    if (!st) {
      state.set(id, { armed: at === null });
      continue;
    }
    if (at === null) { st.armed = true; continue; }
    if (!st.armed) continue;
    st.armed = false;

    if (inCave(player)) {
      markSide(player, "home");
      if (travelHome) travelHome(player);
    } else {
      saveReturn(player);
      markSide(player, "cave");
      const target = targetOf(player.dimension, at);
      if (travelToCave) travelToCave(player, target);
    }
  }
}

// ===========================================================================
// 建てたポータルの記録
// ===========================================================================

function loadSites() {
  const raw = world.getDynamicProperty(PROP_SITES);
  if (typeof raw !== "string") return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

function saveSite(site) {
  const sites = loadSites();
  if (sites.some((s) => s.x === site.x && s.y === site.y && s.z === site.z && s.d === site.d)) return;
  sites.push(site);
  while (sites.length > 48) sites.shift();
  try {
    world.setDynamicProperty(PROP_SITES, JSON.stringify(sites));
  } catch (e) {
    console.warn(`[CavernMiner] ポータル位置の保存に失敗: ${e}`);
  }
}

function buildFrame(dim, px, py, pz, frameBlock, fillSafe, dimId) {
  fillSafe(dim, px - 1, py - 1, pz, px + 2, py + 3, pz, frameBlock);
  fillSafe(dim, px, py, pz, px + 1, py + 2, pz, portalPermutation("z", dimId));
  fillSafe(dim, px - 1, py, pz - 2, px + 2, py + 2, pz - 1, "minecraft:air");
  fillSafe(dim, px - 1, py - 1, pz - 2, px + 2, py - 1, pz - 1, "minecraft:stone");
}

/**
 * 洞窟側に帰りのポータルを建てる。
 * まだ生成されていないチャンクに建つことがあるので、位置を覚えておいて
 * そのチャンクが生成されたときに建て直す。
 */
export function buildReturnPortal(dimId, dim, x, y, z, fillSafe) {
  const cfg = dimConfig(dimId);
  const frame = cfg?.portal?.frame?.[0] ?? "minecraft:mossy_cobblestone";
  const px = x + 2, py = y, pz = z;
  buildFrame(dim, px, py, pz, frame, fillSafe, dimId);
  saveSite({ d: dimId, x: px, y: py, z: pz });
}

export function restorePortals(dimId, cx, cz, dim, fillSafe) {
  const cfg = dimConfig(dimId);
  const frame = cfg?.portal?.frame?.[0] ?? "minecraft:mossy_cobblestone";
  for (const s of loadSites()) {
    // 旧バージョンの記録には d が無い。最初のディメンション扱いにする
    const sd = s.d ?? DIMENSIONS[0].id;
    if (sd !== dimId) continue;
    if (Math.floor(s.x / 16) !== cx || Math.floor(s.z / 16) !== cz) continue;
    buildFrame(dim, s.x, s.y, s.z, frame, fillSafe, dimId);
  }
}

// ===========================================================================
// 登録
// ===========================================================================

export function registerPortal() {
  world.afterEvents.playerBreakBlock.subscribe(onFrameBroken);

  let lastTick = -1;
  const once = (player, block, itemStack) => {
    const t = system.currentTick;
    if (t === lastTick) return;
    lastTick = t;
    tryIgnite(player, block, itemStack);
  };

  let bound = 0;
  try {
    world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
      once(ev.player, ev.block, ev.itemStack);
    });
    bound++;
  } catch (e) { /* noop */ }

  try {
    world.afterEvents.itemUseOn.subscribe((ev) => {
      const p = ev.source ?? ev.player;
      if (p?.typeId === "minecraft:player") once(p, ev.block, ev.itemStack);
    });
    bound++;
  } catch (e) { /* noop */ }

  try {
    world.afterEvents.itemUse.subscribe((ev) => {
      const p = ev.source;
      if (p?.typeId !== "minecraft:player") return;
      if (!KEY_TO_DIM.has(ev.itemStack?.typeId)) return;
      try {
        const hit = p.getBlockFromViewDirection({ maxDistance: 8 });
        if (hit?.block) once(p, hit.block, ev.itemStack);
      } catch (e) { /* noop */ }
    });
    bound++;
  } catch (e) { /* noop */ }

  console.warn(`[CavernMiner] ポータル起動イベント: ${bound}経路を購読`);

  world.afterEvents.playerDimensionChange.subscribe((ev) => {
    markSide(ev.player, isCaveDimension(ev.toDimension.id) ? "cave" : "home");
    const st = state.get(ev.player.id);
    if (st) st.armed = false;
  });

  world.afterEvents.playerSpawn.subscribe((ev) => {
    if (ev.player) state.set(ev.player.id, { armed: false });
  });

  system.runInterval(checkPortals, 8);
  world.afterEvents.playerLeave.subscribe((ev) => state.delete(ev.playerId));
}
