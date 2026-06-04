/* eslint-disable no-console */
/**
 * DD → 3-2 C/L 点 各敌舰的 命中率 & 期望伤害
 *
 * 计算公式一律不自己实现,直接调用本家 fleethub-core(wasm) 的 analyze_ship_attack:
 *   命中率 / 命中项·回避项 / 攻击力(cap·暴击) / 装甲乱数 / 期望伤害分布 全部本家逻辑。
 *
 * 自军配置沿用 ddFire32.ts(高速+統一)。每舰算带电探型[探]与多炮型[炮]两套对比。
 * 舰娘 Lv170、不喂运(用初始运,由 fleethub 按 ship_id 取)。
 * 阵型固定单縦(高等级下命中已顶到上限96,複縦的命中×1.2无效、只白损火力)。
 *
 * 敌方数据经 loadEnemy.ts(fleethub master_data + maps/32.json)。
 *
 * 运行: npx tsx tests/kcAnalysis/ddHitDamage32.ts
 */
import { createRequire } from 'module';
import {
  loadFhMasterData,
  loadFhMap,
  getEnemiesAt,
  buildShipIndex,
  buildGearIndex,
  resolveEnemy,
} from './loadEnemy';
import { computeBest32, BOILER_ID, TURBINE_ID, type Dd32Config } from './ddFire32';
import { loadCanRemodelMap } from './loadMaster';

const require = createRequire(import.meta.url);
// node 版(同步加载 wasm)需显式从 main 入口 require
const { FhCore } = require('fleethub-core');

// ===== 配置 =======================================================
const LEVEL = 170;
const OWN_FORMATION = 'LineAhead'; // 固定单縦(3-2 最优,见之前分析)
const ENEMY_FORMATION = 'LineAhead';
const DD_TOP = 15; // 评估火力榜前几名 DD
const HARD_ARMOR = 20; // 装甲>=此值的敌人作为「硬目标」单独列表

// 交战形态。不影响命中率,只影响伤害(攻击力 precap 的 engagement_mod):
//   T有利×1.2 / 同航×1.0 / 反航×0.8 / T不利×0.6
// rate 为无索敌补正(无彩云)时的基础发生率。3-2 带不了彩云,固定用此值。
const ENGAGEMENTS = [
  { key: 'GreenT', label: 'T有利', rate: 0.15 },
  { key: 'Parallel', label: '同航', rate: 0.45 },
  { key: 'HeadOn', label: '反航', rate: 0.30 },
  { key: 'RedT', label: 'T不利', rate: 0.10 },
] as const;

// ===== 配置 -> fleethub ShipState =================================
// 可改修=★10, 不可改修=★0 (按 kc-web canRemodel)
// mode: 'radar'=带电探型(缶+电探+炮) / 'gun'=多炮型(缶+多1炮, 不带电探)
function buildShipState(c: Dd32Config, canRemodel: Map<number, boolean>, mode: 'radar' | 'gun') {
  const star = (id: number) => (canRemodel.get(id) ? 10 : 0);
  const state: Record<string, unknown> = { ship_id: c.shipId, level: LEVEL };
  let slot = 1;
  state.gx = { gear_id: BOILER_ID, stars: star(BOILER_ID) }; // 缶恒塞补强增设(孔)
  const guns = mode === 'radar' ? c.gunIdsRadar : c.gunIdsGun;
  for (const id of guns) state[`g${slot++}`] = { gear_id: id, stars: star(id) };
  if (mode === 'radar') state[`g${slot++}`] = { gear_id: c.radarId, stars: star(c.radarId) };
  if (!c.special) state[`g${slot++}`] = { gear_id: TURBINE_ID, stars: star(TURBINE_ID) }; // 非特例占1装备位タービン
  for (const id of (mode === 'radar' ? c.extraIdsRadar : c.extraIdsGun)) state[`g${slot++}`] = { gear_id: id, stars: star(id) };
  return state;
}

const shipConditions = (orgType: string, len: number, index: number, formation: string) => ({
  org_type: orgType,
  fleet_type: 'Main',
  fleet_len: len,
  index,
  formation,
});

const makeConfig = (engagement: string) => ({
  engagement,
  left: shipConditions('Single', 6, 0, OWN_FORMATION),
  right: shipConditions('EnemySingle', 1, 0, ENEMY_FORMATION),
});

// 按交战形态发生率加权的综合期望伤害
function weightedDamage(dmgByEng: Record<string, number>): number {
  return ENGAGEMENTS.reduce((s, e) => s + e.rate * (dmgByEng[e.key] ?? 0), 0);
}

// damage_density 是含 miss(=0) 的「单次炮击被弹伤害分布」,直接加权平均即为单次期望伤害
function expectedDamage(density: Record<string, number>): number {
  let e = 0;
  for (const [k, p] of Object.entries(density)) e += Number(k) * p;
  return e;
}

(async () => {
  const md = await loadFhMasterData();
  const core = new FhCore(md);
  const analyzer = core.create_analyzer();
  const ships = buildShipIndex(md);
  const gears = buildGearIndex(md);

  // --- 敌方: C/L 出现舰去重并解析属性 ---
  const map = await loadFhMap(32);
  const enemyIds = new Set<number>();
  for (const point of ['C', 'L']) {
    for (const comp of getEnemiesAt(map, point)) for (const id of comp.main) enemyIds.add(id);
  }
  const enemies = [...enemyIds]
    .map((id) => resolveEnemy(id, ships, gears)!)
    .filter(Boolean)
    .sort((a, b) => b.armor - a.armor);

  // 硬目标(装甲>=HARD_ARMOR)按舰名只保留最硬的一个变体
  const hardByName = new Map<string, ReturnType<typeof resolveEnemy>>();
  for (const e of enemies) {
    if (e.armor < HARD_ARMOR) continue;
    const cur = hardByName.get(e.name);
    if (!cur || e.armor > cur.armor) hardByName.set(e.name, e);
  }
  const hardTargets = [...hardByName.values()].sort((a, b) => b!.armor - a!.armor);
  const softTargets = enemies.filter((e) => e.armor < HARD_ARMOR);

  // 敌舰 Ship(用单舰 comp,属性纯净)
  const enemyShipCache = new Map<number, any>();
  const getEnemyShip = (id: number) => {
    if (!enemyShipCache.has(id)) {
      const comp = core.create_comp_by_map_enemy(Uint16Array.from([id]));
      enemyShipCache.set(id, comp.main.get_ship('s1'));
    }
    return enemyShipCache.get(id);
  };

  // --- 自军 DD 配置(每舰算带电探型+多炮型两套, 缓存 Ship 对象) ---
  const canRemodel = await loadCanRemodelMap();
  const configs = (await computeBest32()).slice(0, DD_TOP);
  const myShips = configs.map((c) => ({
    c,
    radar: core.create_ship(buildShipState(c, canRemodel, 'radar')),
    gun: core.create_ship(buildShipState(c, canRemodel, 'gun')),
  }));

  // --- 计算: 各交战形态的 命中率 & 期望伤害 ---
  const analyze = (myShip: any, enemyId: number) => {
    const dmg: Record<string, number> = {};
    let hit = 0;
    let crit = 0;
    for (const { key } of ENGAGEMENTS) {
      const a = analyzer.analyze_ship_attack(makeConfig(key), myShip, getEnemyShip(enemyId), true);
      const rep: any = Object.values(a.day.data)[0]; // SingleAttack
      hit = (rep.hit_rate?.total ?? 0) * 100; // 命中率与交战形态无关
      crit = (rep.hit_rate?.critical ?? 0) * 100;
      dmg[key] = rep.damage ? expectedDamage(rep.damage.damage_density) : 0;
    }
    return { hit, crit, dmg, weighted: weightedDamage(dmg) };
  };

  // ===== 输出 =====
  console.log('============================================================');
  console.log(` DD → 3-2 C/L 命中率 & 期望伤害  (Lv${LEVEL} 不喂运 / 单縦)`);
  console.log(' 命中率与交战形态无关。伤害随形态变化: T有利×1.2/同航×1.0/反航×0.8/T不利×0.6(precap)。');
  console.log(' 加权=按发生率(同航45/反航30/T有利15/T不利10%)加权的综合期望伤害。');
  console.log(' 期望伤害=单次炮击(含miss)。全部由 fleethub-core 计算。');
  console.log('============================================================');

  const fmt = (name: string, r: ReturnType<typeof analyze>) => `${name}\t${r.hit.toFixed(0)}%(${r.crit.toFixed(0)})`
    + `\t${r.dmg.GreenT.toFixed(0)}\t${r.dmg.Parallel.toFixed(0)}\t${r.dmg.HeadOn.toFixed(0)}\t${r.dmg.RedT.toFixed(0)}`
    + `\t${r.weighted.toFixed(0)}`;

  for (const t of hardTargets) {
    console.log(`\n=== 目标: ${t!.name} (装甲${t!.armor} / 回避${t!.evasion} / HP${t!.hp}) ===`);
    console.log('舰娘/型\t命中%(暴)\tT有利\t同航\t反航\tT不利\t加权');
    for (const { c, radar, gun } of myShips) {
      console.log(fmt(`${c.name}[探]`, analyze(radar, t!.shipId)));
      console.log(fmt(`${c.name}[炮]`, analyze(gun, t!.shipId)));
    }
  }

  console.log('\n■ 软目标(装甲<' + HARD_ARMOR + ', 命中几乎必中、大多一击)');
  console.log('  ' + softTargets.map((t) => `${t.name}(装甲${t.armor}/回避${t.evasion}/HP${t.hp})`).join('  '));

  console.log('\n注: [探]=带电探型, [炮]=多炮型(少电探+1炮)。多炮火力高→伤害↑, 但少了电探命中加成→命中略↓。');
  console.log('    命中项/回避项/攻击力/装甲乱数/期望伤害均由 fleethub-core(本家wasm)计算。');
  console.log('    回避值为社区推定值(官方API不公开,详见 loadEnemy.ts)。');
  for (const { radar, gun } of myShips) { radar.free?.(); gun.free?.(); }
})().catch((e) => { console.error(e); process.exit(1); });
