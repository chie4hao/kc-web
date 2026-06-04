/* eslint-disable no-console */
/**
 * 加工后 master(master.json) 的加载公共逻辑。
 *
 * 取得优先级:
 *   1) 环境变量 KC_MASTER_JSON 指定的本地路径
 *   2) 本地缓存 tests/kcAnalysis/.cache/master.json
 *   3) 与本家相同的公开 URL(Firebase Storage)下载并缓存
 *
 * master.json 不是 START2.json(api_start2 原始数据),而是
 * 制空权模拟器已算好各值的形式(ships[].fire = 近代化改修满的火力 等)。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// 与本家 store/index.ts 相同的 URL
const MASTER_JSON_URL = 'https://firebasestorage.googleapis.com/v0/b/development-74af0.appspot.com/o/master.json?alt=media';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(here, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'master.json');

export interface RawShip {
  id: number; orig: number; final: number; type: number; type2: number;
  name: string; s_count: number; fire: number; torpedo: number; armor: number;
  [k: string]: unknown;
}
export interface RawItem {
  id: number; type: number; itype: number; name: string;
  fire?: number; antiAir?: number; scout?: number; accuracy?: number;
  [k: string]: unknown;
}
export interface MasterData {
  ships: RawShip[];
  items: RawItem[];
  [k: string]: unknown;
}

/**
 * 装备 id -> 是否可改修 的映射(取自 kc-web master 的 canRemodel)。
 * 评估时按此决定改修档: 可改修=★MAX, 不可改修=★0。
 * (注: fleethub 的 Gear.improvable 语义不同且数据不全,不可用于此判断)
 */
export async function loadCanRemodelMap(): Promise<Map<number, boolean>> {
  const m = await loadMaster();
  return new Map(m.items.map((i) => [i.id, !!(i as { canRemodel?: unknown }).canRemodel]));
}

export async function loadMaster(): Promise<MasterData> {
  // 1) 环境变量
  const envPath = process.env.KC_MASTER_JSON;
  if (envPath && fs.existsSync(envPath)) {
    return JSON.parse(fs.readFileSync(envPath, 'utf-8')) as MasterData;
  }
  // 2) 缓存
  if (fs.existsSync(CACHE_FILE)) {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as MasterData;
  }
  // 3) 下载
  console.error('正在下载 master.json ...');
  const res = await fetch(MASTER_JSON_URL);
  if (!res.ok) throw new Error(`master.json 取得失败: ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, text);
  console.error(`已缓存 master.json: ${CACHE_FILE}`);
  return JSON.parse(text) as MasterData;
}
