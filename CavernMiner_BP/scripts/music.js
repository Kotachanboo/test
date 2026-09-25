/**
 * 洞窟BGM
 *
 * /music play ... loop で再生し、/music stop で止める。
 * playSound だと曲の長さを手で持って再生し直す必要があり、
 * 秒数がずれると重なるか無音が伸びる。/music ならループもフェードも任せられる。
 *
 * ただし /music が受け付けるのは music.game. か record. 配下のIDだけなので、
 * sound_definitions.json 側もその形で登録してある。
 */

import { world, system } from "@minecraft/server";
import { isCaveDimension, dimConfig } from "./dimensions.js";

// ===========================================================================
// 設定
// ===========================================================================

/**
 * 再生候補。上から順に試し、通ったものを以後使い続ける。
 * 環境によって省略形しか通らないことがあるため候補を並べている。
 */
function trackFor(player) {
  const cfg = dimConfig(player.dimension.id);
  return cfg?.music ?? "music.game.cavern.endless_dark_cave";
}

const VOLUME = 0.8;
const FADE_IN = 2;     // 秒
const FADE_OUT = 2;    // 秒

/** ディメンションに入ってから鳴り始めるまでの間 (tick) */
const START_DELAY = 60;

// ===========================================================================
// 状態
// ===========================================================================

/** playerId -> { playing: boolean, startAt: number } */
const state = new Map();



function startMusic(player) {
  const id = trackFor(player);
  try {
    player.runCommand(`music play ${id} ${VOLUME} ${FADE_IN} loop`);
    return true;
  } catch (e) {
    console.warn(`[CavernMiner] BGMを再生できませんでした (${id}): ${e}`);
    return false;
  }
}

function stopMusic(player) {
  try {
    player.runCommand(`music stop ${FADE_OUT}`);
  } catch (e) { /* noop */ }
}

/** 別の洞窟へ移ったら曲も切り替える */
function currentTrackOf(player) {
  return dimConfig(player.dimension.id)?.music ?? null;
}

/** 退出・死亡・帰還など、洞窟から離れたときの後始末 */
function leave(player) {
  const st = state.get(player.id);
  if (st?.playing) stopMusic(player);
  state.delete(player.id);
}

function tick() {
  const now = system.currentTick;

  for (const player of world.getAllPlayers()) {
    const inCave = isCaveDimension(player.dimension.id);
    const st = state.get(player.id);

    if (!inCave) {
      if (st) leave(player);
      continue;
    }

    if (!st) {
      state.set(player.id, { playing: false, startAt: now + START_DELAY });
      continue;
    }

    // 別の洞窟へ移ったら曲を掛け直す
    const track = currentTrackOf(player);
    if (st.playing && st.track !== track) {
      stopMusic(player);
      st.playing = false;
      st.startAt = now + 20;
    }

    if (!st.playing && now >= st.startAt) {
      st.playing = startMusic(player);
      st.track = track;
      if (!st.playing) st.startAt = now + 200;   // 失敗したら10秒後に再挑戦
    }
  }
}

// ===========================================================================
// 登録
// ===========================================================================

export function registerMusic() {
  system.runInterval(tick, 20);

  // --- 洞窟から離れる経路をすべて塞ぐ ---

  // ポータルやコマンドでの移動
  world.afterEvents.playerDimensionChange.subscribe((ev) => {
    if (isCaveDimension(ev.fromDimension.id)) leave(ev.player);
  });

  // 死亡。ここで止めないとゲームオーバー画面の裏で鳴り続ける
  try {
    world.afterEvents.entityDie.subscribe((ev) => {
      const e = ev.deadEntity;
      if (e?.typeId === "minecraft:player") leave(e);
    }, { entityTypes: ["minecraft:player"] });
  } catch (e) {
    world.afterEvents.entityDie.subscribe((ev) => {
      const d = ev.deadEntity;
      if (d?.typeId === "minecraft:player") leave(d);
    });
  }

  // リスポーン。洞窟の外に戻ったなら確実に止める
  world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.player) return;
    if (!isCaveDimension(ev.player.dimension.id)) leave(ev.player);
    else state.delete(ev.player.id);   // 洞窟内で復帰したら鳴らし直す
  });

  world.afterEvents.playerLeave.subscribe((ev) => state.delete(ev.playerId));
}

/** デバッグ用: 鳴らし直す */
export function skipTrack(player) {
  stopMusic(player);
  state.set(player.id, { playing: false, startAt: system.currentTick + 20 });
  player.sendMessage("§7BGMを鳴らし直します");
}
