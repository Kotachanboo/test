/**
 * ディメンションごとの設定。
 *
 * 生成器 (main.js) はここの値だけを見て動く。
 * 新しい洞窟を足すときは、このファイルに1項目書くのが基本になる。
 */

export const SEED = 20260918;

// ===========================================================================
// 1つ目: 大空洞
// ===========================================================================

const GREAT_CAVERN = {
  id: "cavern:great_cavern",
  name: "大空洞",
  short: "gc",              // 生成済み記録のキー接頭辞
  bandHeight: 128,
  deepslateAt: 0.55,        // 帯の下から何割の位置を深層岩の境界にするか

  field: {
    threshold: 0.11,
    scaleXZ: 42,
    scaleY: 26,
    varyScale: 190,
    varyAmount: 0.06,
    chamberScale: 78,
    chamberSquash: 0.55,
    chamberThreshold: 0.52,
    chamberWeight: 0.35,
    depthBias: 0.0005,
    ceilMargin: 10,
    ceilStrength: 0.02,
    floorMargin: 10,
    floorStrength: 0.03,
    sampleStep: 2,
    smooth: true,
    smoothNeighbors: 3,
  },

  blocks: {
    stone: "minecraft:stone",
    deepslate: "minecraft:deepslate",
    bedrock: "minecraft:bedrock",
  },

  oreMultiplier: 1.0,

  /** 1つ目は石と深層岩だけ。岩石は混ぜない */
  stoneVariants: false,

  /** 流体は出さない */
  fluids: null,

  /** 構造物は出さない */
  structures: null,

  portal: {
    frame: ["minecraft:mossy_cobblestone"],
    key: "cavern:cave_key",
    minRank: 0,             // 制限なし
  },

  music: "music.game.cavern.endless_dark_cave",

  /** 生成範囲。移動を止めて待たせるので、広く取ってよい */
  genRadius: 6,
};

// ===========================================================================
// 2つ目: 豊穣の洞窟
// ===========================================================================
// バニラの洞窟に近い構成。水と溶岩、ダンジョン、ジオード、ヒカリゴケ。

const RICH_CAVERN = {
  id: "cavern:rich_cavern",
  name: "豊穣の洞窟",
  short: "rc",
  bandHeight: 128,
  deepslateAt: 0.5,

  field: {
    // 大空洞より少し広く、大空洞の頻度も上げる
    threshold: 0.125,
    scaleXZ: 46,
    scaleY: 28,
    varyScale: 170,
    varyAmount: 0.06,
    chamberScale: 72,
    chamberSquash: 0.5,
    chamberThreshold: 0.48,
    chamberWeight: 0.35,
    depthBias: 0.0004,
    ceilMargin: 10,
    ceilStrength: 0.02,
    floorMargin: 8,
    floorStrength: 0.03,
    sampleStep: 2,
    smooth: true,
    smoothNeighbors: 3,
  },

  blocks: {
    stone: "minecraft:stone",
    deepslate: "minecraft:deepslate",
    bedrock: "minecraft:bedrock",
  },

  /** 鉱石の量。1つ目より多い */
  oreMultiplier: 1.45,

  /** 閃緑岩・安山岩・花崗岩・凝灰岩・砂利を混ぜる */
  stoneVariants: true,

  fluids: {
    /** 岩盤からこの高さまでは溶岩で満たす (バニラの溶岩湖と同じ考え方) */
    lavaDepth: 12,
    lavaWave: 4,
    lavaScale: 90,

    /**
     * 溶岩だまり。最下層だけだと出会うまでに掘る距離が長すぎるので、
     * 中層にも溶岩の一帯を作る。
     */
    lavaPocketScale: 105,
    lavaPocketThreshold: 0.28,   // 一帯の割合。上げるほど希少
    lavaPocketLevel: 0.40,       // 帯の下から何割の高さに溜まるか
    lavaPocketWave: 6,

    /** 水の地帯。2Dノイズがこの値を超えた一帯が水没する */
    waterRegionScale: 130,
    waterRegionThreshold: 0.12,
    /** 水面の高さ (帯の下から何割)。出現地点が上寄りなので高めに置く */
    waterLevel: 0.56,
    waterWave: 7,
    /**
     * 洞窟の床にできる溶岩の溜まり場。
     * 高さで決める溶岩だけだと、そこまで掘り下げないと出会えない。
     */
    /**
     * 0.10 / 0.05 にしたら床の1割が溶岩になり、隣どうしが繋がって
     * 一面の溶岩湖になった。地帯を絞り、確率も1桁下げる。
     */
    puddleChance: 0.012,     // 基準の確率。深いほど上がる
    puddleScale: 70,         // 溜まり場が固まる地帯の広さ
    puddleRegion: 0.45,      // この値を超えた一帯にだけできる

    /** 溶岩面からこの高さ以内には水を置かない (接触で石ができるのを避ける) */
    lavaClearance: 3,
  },

  structures: {
    /** ヒカリゴケ: 洞窟の壁に生える。チャンクあたりの株数 */
    lichenPerChunk: 5.0,
    lichenPatch: 6,          // 1株から広がる最大ブロック数

    /** スポナールーム: 何チャンクに1つか */
    dungeonChance: 1 / 22,
    dungeonSpawners: ["minecraft:zombie", "minecraft:skeleton", "minecraft:spider"],

    /** アメジストジオード: バニラは1/24チャンク */
    geodeChance: 1 / 26,
    geodeRadius: [5, 7],     // 外殻の半径

    /** 石レンガの小部屋 (構造物)。中身はチェスト / スポナー3種 / 囚われた者 */
    vaultChance: 1 / 24,
  },

  portal: {
    frame: ["minecraft:mossy_stone_bricks"],
    key: "cavern:rich_key",
    minRank: 1,              // 石掘り以上。クリエイティブは対象外
  },

  music: "music.game.cavern.houjou_cave",

  /**
   * 生成範囲。
   * 豊穣の洞窟は鉱石・岩石・流体・構造物があり、1チャンクの設置回数が
   * 大空洞の1.5倍近い。少しだけ狭くする。
   */
  genRadius: 5,
};

// ===========================================================================
// 3つ目: 砂漠の洞窟
// ===========================================================================
// 砂岩と赤い砂岩の世界。広い空洞に砂が溜まる。
// バイオームの desert タグでゾンビがハスクに置き換わる。

const DESERT_CAVERN = {
  id: "cavern:desert_cavern",
  name: "砂漠の洞窟",
  short: "dc",
  bandHeight: 128,
  deepslateAt: 0.45,        // 赤い砂岩の境界

  field: {
    // 大空洞寄り。広い部屋が多く、砂丘のような床になる
    threshold: 0.12,
    scaleXZ: 50,
    scaleY: 24,
    varyScale: 180,
    varyAmount: 0.05,
    chamberScale: 64,
    chamberSquash: 0.45,
    chamberThreshold: 0.42,
    chamberWeight: 0.42,
    depthBias: 0.0003,
    ceilMargin: 10,
    ceilStrength: 0.02,
    floorMargin: 8,
    floorStrength: 0.03,
    sampleStep: 2,
    smooth: true,
    smoothNeighbors: 3,
  },

  blocks: {
    stone: "minecraft:sandstone",
    deepslate: "minecraft:red_sandstone",
    bedrock: "minecraft:bedrock",
  },

  oreMultiplier: 1.2,

  /** 砂・滑らかな砂岩・切り出した砂岩・テラコッタ・赤い砂 */
  stoneVariants: "desert",

  /**
   * ネザーのような明るさ。
   * 統合版では敵モブはブロックの明るさが0の場所でしか湧かない。
   * 5間隔で置いたらほぼ全域が明るくなり、ハスクが全く湧かなかった。
   * 間隔を広げ、光源の届かない暗がりを残す。
   */
  ambientLight: { level: 6, spacing: 11 },


  /** 水は無し。深い層にだけ溶岩が溜まる */
  fluids: {
    lavaDepth: 8,
    lavaWave: 3,
    lavaScale: 90,
    waterRegionScale: 130,
    waterRegionThreshold: 2.0,   // ノイズがこの値を超えることは無い = 水無し
    waterLevel: 0.5,
    waterWave: 0,
    puddleChance: 0.008,
    puddleScale: 70,
    puddleRegion: 0.5,
    lavaClearance: 3,
  },

  structures: null,


  portal: {
    frame: ["minecraft:chiseled_sandstone"],
    key: "cavern:desert_key",
    minRank: 3,              // マグナイト掘り以上。クリエイティブは対象外
  },

  music: "music.game.cavern.sahara",
  genRadius: 4,
};

// ===========================================================================
// 4つ目: 氷の洞窟
// ===========================================================================
// 霜の降りた石と深層岩の世界。氷の湖と雪が点在する。
// バイオームの frozen タグでスケルトンがストレイに置き換わる。

const ICE_CAVERN = {
  id: "cavern:ice_cavern",
  name: "氷の洞窟",
  short: "ic",
  bandHeight: 128,
  deepslateAt: 0.45,        // 青氷の境界

  field: {
    threshold: 0.115,
    scaleXZ: 46,
    scaleY: 26,
    varyScale: 170,
    varyAmount: 0.05,
    chamberScale: 70,
    chamberSquash: 0.5,
    chamberThreshold: 0.46,
    chamberWeight: 0.38,
    depthBias: 0.0004,
    ceilMargin: 10,
    ceilStrength: 0.02,
    floorMargin: 8,
    floorStrength: 0.03,
    sampleStep: 2,
    smooth: true,
    smoothNeighbors: 3,
  },

  /**
   * 母岩は氷ではなく、霜の降りた石と深層岩。
   * 氷塊と青氷だと床が全部滑り、見た目も単調だった。
   */
  blocks: {
    stone: "cavern:frozen_stone",
    deepslate: "cavern:frozen_deepslate",
    bedrock: "minecraft:bedrock",
  },

  oreMultiplier: 1.2,

  /** 雪・氷・粉雪・方解石 */
  stoneVariants: "ice",

  /**
   * 氷が光を拾って、薄暗いがほのかに見える程度。
   * 敵は明るさ0の場所でしか湧かないので、弱く・まばらにして暗がりを多く残す。
   */
  ambientLight: { level: 3, spacing: 13 },


  /** 水の代わりに氷で満たす (凍った湖)。溶岩は無し */
  fluids: {
    lavaDepth: 0,
    lavaWave: 0,
    lavaScale: 90,
    waterRegionScale: 120,
    waterRegionThreshold: 0.2,
    waterLevel: 0.45,
    waterWave: 5,
    waterBlock: "minecraft:ice",
    puddleChance: 0,
    lavaClearance: 0,
  },

  /**
   * 床に雪を積もらせる。
   * 母岩が全部滑る氷なので、歩ける場所を混ぜないと戦闘が成り立たない。
   */
  floorCover: { block: "minecraft:snow_layer", chance: 0.45 },

  structures: null,


  portal: {
    frame: ["minecraft:blue_ice"],
    key: "cavern:ice_key",
    minRank: 3,              // マグナイト掘り以上。クリエイティブは対象外
  },

  music: "music.game.cavern.frozen_temple",
  genRadius: 4,
};

// ===========================================================================

export const DIMENSIONS = [GREAT_CAVERN, RICH_CAVERN, DESERT_CAVERN, ICE_CAVERN];

const BY_ID = new Map(DIMENSIONS.map((d) => [d.id, d]));

export function dimConfig(id) {
  return BY_ID.get(id) ?? null;
}

export function isCaveDimension(id) {
  return BY_ID.has(id);
}

/** 最初のディメンション。コマンドの既定値に使う */
export const DEFAULT_DIM = GREAT_CAVERN.id;
