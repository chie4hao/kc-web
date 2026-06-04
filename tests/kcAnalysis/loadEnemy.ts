/* eslint-disable no-console */
/**
 * 敌方编成·敌舰属性的加载公共逻辑(数据源自 fleethub)。
 *
 * 两类来源不同的数据一起处理:
 *   1) 敌舰/装备属性  -> fleethub master_data.json
 *        - firepower / torpedo / armor / anti_air / hp 等源自官方 api_start2,可靠度高。
 *        - evasion(回避) 官方 API 不公开,是社区(KCNav/制空检证部等)的实测推定值。
 *   2) 各海域节点的敌编成·阵形  -> fleethub maps/{mapId}.json
 *        - 由 TsunDB/KCNav(tsunkit.net) 玩家集计,经 fleethub 转发到 GCS。
 *        - 常设海域(如 3-2 = mapId 32)编成长期固定,实用上没问题。
 *
 * 取得优先级(与 loadMaster.ts 一致的三段式):
 *   1) 环境变量指定的本地路径
 *   2) 本地缓存 tests/kcAnalysis/.cache/
 *   3) 与本家相同的公开 URL(GCS)下载并缓存
 *
 * GCS 上的 map JSON 以 brotli(content-encoding: br) 保存,
 * 故在 fetch 未自动解压时回退到手动 brotli 解压。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';

// 与本家 site/firebase.ts 相同的 GCS bucket
const GCS_BASE = 'https://storage.googleapis.com/kcfleethub.appspot.com';
const MASTER_DATA_URL = `${GCS_BASE}/data/master_data.json`;
const mapUrl = (mapId: number) => `${GCS_BASE}/data/maps/${mapId}.json`;

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(here, '.cache');

// ===== 类型定义 ===================================================

/** 敌舰/我舰属性。数组为 [初期, 最大],敌舰两值相同。缺失的属性视为 0。 */
export interface FhShip {
  ship_id: number;
  name: string;
  yomi: string;
  stype: number;
  ctype: number;
  slotnum: number;
  speed: number;
  range: number;
  max_hp: [number, number];
  firepower: [number, number];
  armor: [number, number];
  torpedo: [number, number];
  evasion: [number, number];
  anti_air: [number, number];
  asw: [number, number];
  los: [number, number];
  luck: [number, number];
  slots: number[];
  /** 初期搭载装备 */
  stock: { gear_id: number; stars?: number }[];
  torpedo_accuracy?: number;
  [k: string]: unknown;
}

/** 装备 master。注意只有非零属性才会有对应字段。 */
export interface FhGear {
  gear_id: number;
  name: string;
  types: number[];
  firepower?: number;
  torpedo?: number;
  armor?: number;
  anti_air?: number;
  evasion?: number;
  accuracy?: number;
  asw?: number;
  los?: number;
  range?: number;
  [k: string]: unknown;
}

export interface FhMasterData {
  created_at?: number;
  ships: FhShip[];
  gears: FhGear[];
  [k: string]: unknown;
}

/** 1 个编成 pattern。通常舰队只有 main,联合舰队还带 escort。 */
export interface FhEnemyComp {
  main: number[];
  escort?: number[];
  /** 可能出现的阵形 (1:单縦 2:複縦 3:輪形 4:梯形 5:単横 6:警戒) */
  formations: number[];
  fp?: number[];
  lbasFp?: number[];
}

export interface FhMapNode {
  point: string;
  x: number;
  y: number;
  type: number;
  enemies?: FhEnemyComp[];
}

export interface FhMap {
  id: number;
  nodes: FhMapNode[];
}

/** 装备计入后、折叠为单值的敌舰属性(便于计算)。 */
export interface ResolvedEnemy {
  shipId: number;
  name: string;
  stype: number;
  hp: number;
  /** 素火力 + 装备火力 */
  firepower: number;
  /** 素装甲 + 装备装甲 */
  armor: number;
  torpedo: number;
  /** 素回避 + 装备回避 (回避来自推定值) */
  evasion: number;
  antiAir: number;
  asw: number;
  luck: number;
  range: number;
  gears: string[];
  /** 明细: 装备带来的加算分 */
  bonus: { firepower: number; armor: number; torpedo: number; evasion: number; antiAir: number };
}

// ===== 加载逻辑 ===================================================

/** content 若不是 JSON 文本则视为 brotli 并解压。 */
function decodeMaybeBrotli(buf: Buffer): string {
  // 跳过开头空白,若为 '{' 或 '[' 则是明文 JSON
  let i = 0;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i += 1;
  if (buf[i] === 0x7b /* { */ || buf[i] === 0x5b /* [ */) return buf.toString('utf-8');
  return zlib.brotliDecompressSync(buf).toString('utf-8');
}

async function loadJson<T>(opts: { envPath?: string; cacheFile: string; url: string; label: string }): Promise<T> {
  // 1) 环境变量
  if (opts.envPath && fs.existsSync(opts.envPath)) {
    return JSON.parse(decodeMaybeBrotli(fs.readFileSync(opts.envPath))) as T;
  }
  // 2) 缓存
  if (fs.existsSync(opts.cacheFile)) {
    return JSON.parse(decodeMaybeBrotli(fs.readFileSync(opts.cacheFile))) as T;
  }
  // 3) 下载
  console.error(`正在下载 ${opts.label} ... (${opts.url})`);
  const res = await fetch(opts.url);
  if (!res.ok) throw new Error(`${opts.label} 取得失败: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = decodeMaybeBrotli(buf);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(opts.cacheFile, text);
  console.error(`已缓存 ${opts.label}: ${opts.cacheFile}`);
  return JSON.parse(text) as T;
}

/** 加载 fleethub master_data(敌舰/装备属性)。环境变量: KC_FH_MASTER_DATA */
export async function loadFhMasterData(): Promise<FhMasterData> {
  return loadJson<FhMasterData>({
    envPath: process.env.KC_FH_MASTER_DATA,
    cacheFile: path.join(CACHE_DIR, 'fh_master_data.json'),
    url: MASTER_DATA_URL,
    label: 'master_data.json',
  });
}

/**
 * 加载指定海域的编成数据。mapId = 世界*10 + 海域号 (3-2 = 32)。
 * 环境变量: KC_FH_MAP_DIR (放置 {mapId}.json 的目录)
 */
export async function loadFhMap(mapId: number): Promise<FhMap> {
  const envDir = process.env.KC_FH_MAP_DIR;
  return loadJson<FhMap>({
    envPath: envDir ? path.join(envDir, `${mapId}.json`) : undefined,
    cacheFile: path.join(CACHE_DIR, `fh_map_${mapId}.json`),
    url: mapUrl(mapId),
    label: `maps/${mapId}.json`,
  });
}

// ===== 索引·解析辅助 ==============================================

export function buildShipIndex(md: FhMasterData): Map<number, FhShip> {
  return new Map(md.ships.map((s) => [s.ship_id, s]));
}

export function buildGearIndex(md: FhMasterData): Map<number, FhGear> {
  return new Map(md.gears.map((g) => [g.gear_id, g]));
}

/** 返回指定节点的编成列表。 */
export function getEnemiesAt(map: FhMap, point: string): FhEnemyComp[] {
  const node = map.nodes.find((n) => n.point === point);
  return node?.enemies ?? [];
}

const first = (v: [number, number] | number | undefined): number => (Array.isArray(v) ? v[0] : v ?? 0);

/** 把 ship_id 解析为装备计入后的单值属性。索引中没有则返回 null。 */
export function resolveEnemy(
  shipId: number,
  ships: Map<number, FhShip>,
  gears: Map<number, FhGear>,
): ResolvedEnemy | null {
  const s = ships.get(shipId);
  if (!s) return null;

  const bonus = { firepower: 0, armor: 0, torpedo: 0, evasion: 0, antiAir: 0 };
  const names: string[] = [];
  for (const st of s.stock ?? []) {
    const g = gears.get(st.gear_id);
    if (!g) continue;
    bonus.firepower += g.firepower ?? 0;
    bonus.armor += g.armor ?? 0;
    bonus.torpedo += g.torpedo ?? 0;
    bonus.evasion += g.evasion ?? 0;
    bonus.antiAir += g.anti_air ?? 0;
    names.push(g.name);
  }

  return {
    shipId,
    name: s.name,
    stype: s.stype,
    hp: first(s.max_hp),
    firepower: first(s.firepower) + bonus.firepower,
    armor: first(s.armor) + bonus.armor,
    torpedo: first(s.torpedo) + bonus.torpedo,
    evasion: first(s.evasion) + bonus.evasion,
    antiAir: first(s.anti_air) + bonus.antiAir,
    asw: first(s.asw),
    luck: first(s.luck),
    range: s.range,
    gears: names,
    bonus,
  };
}

// ===== 自测(直接运行时显示 3-2 C/L) ==============================

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const FORM: Record<number, string> = { 1: '単縦', 2: '複縦', 3: '輪形', 4: '梯形', 5: '単横', 6: '警戒' };
  (async () => {
    const md = await loadFhMasterData();
    const map = await loadFhMap(32);
    const ships = buildShipIndex(md);
    const gears = buildGearIndex(md);
    console.log(`master_data: ships=${md.ships.length} gears=${md.gears.length} / map ${map.id} 节点=${map.nodes.map((n) => n.point).join(' ')}`);
    for (const point of ['C', 'L']) {
      console.log(`\n========== 点${point} ==========`);
      getEnemiesAt(map, point).forEach((comp, i) => {
        console.log(`-- 编成${i + 1}  阵形:${comp.formations.map((f) => FORM[f] ?? f).join('/')} --`);
        for (const id of comp.main) {
          const e = resolveEnemy(id, ships, gears);
          if (!e) { console.log(`  id${id} (未登录)`); continue; }
          console.log(`  ${e.name}\tHP${e.hp} 火${e.firepower} 装${e.armor} 雷${e.torpedo} 回避${e.evasion} 运${e.luck} | ${e.gears.join('/') || '无'}`);
        }
      });
    }
  })().catch((err) => { console.error(err); process.exit(1); });
}
