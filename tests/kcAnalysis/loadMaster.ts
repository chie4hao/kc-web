/* eslint-disable no-console */
/**
 * 加工済みマスタ(master.json)のロード共通処理。
 *
 * 取得優先順:
 *   1) 環境変数 KC_MASTER_JSON で指定したローカルパス
 *   2) ローカルキャッシュ tests/kcAnalysis/.cache/master.json
 *   3) 本家と同じ公開URL(Firebase Storage)からダウンロードしてキャッシュ
 *
 * master.json は START2.json(api_start2 生データ)ではなく、
 * 制空権シミュレータが各値を算出済みの形式(ships[].fire = 近代化改修満の火力 等)。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// 本家 store/index.ts と同一URL
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

export async function loadMaster(): Promise<MasterData> {
  // 1) 環境変数
  const envPath = process.env.KC_MASTER_JSON;
  if (envPath && fs.existsSync(envPath)) {
    return JSON.parse(fs.readFileSync(envPath, 'utf-8')) as MasterData;
  }
  // 2) キャッシュ
  if (fs.existsSync(CACHE_FILE)) {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as MasterData;
  }
  // 3) ダウンロード
  console.error('master.json をダウンロード中...');
  const res = await fetch(MASTER_JSON_URL);
  if (!res.ok) throw new Error(`master.json の取得に失敗: ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, text);
  console.error(`master.json をキャッシュしました: ${CACHE_FILE}`);
  return JSON.parse(text) as MasterData;
}
