/* eslint-disable no-console */
/**
 * 我方 DD 在 3-2 C/L 的「生存」评估(敌方 → 我方)
 *
 * 评估敌方对我方的攻击:
 *   - 昼战炮击(day / SingleAttack)
 *   - 闭幕雷击(closing_torpedo)
 * 我方不考虑反击(昼战基本已清场,闭幕雷只是清理残敌)。
 *
 * 全部命中率/伤害/损伤状态由 fleethub-core 的 analyze_ship_attack 计算,
 * 让敌方当攻击方(left=敌, right=我, attacker_is_left=true)。
 *
 * 交战形态对双方攻击力同向修正(T有利双方×1.2 ...),按发生率加权。
 * 我方 Lv170、不喂运、阵型单縦。
 *
 * 运行: npx tsx tests/kcAnalysis/ddSurvival32.ts
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
const { FhCore } = require('fleethub-core');

// ===== 配置 =======================================================
const LEVEL = 170;
const OWN_FORMATION = 'LineAhead';
const ENEMY_FORMATION = 'LineAhead';
const DD_TOP = 15;

const ENGAGEMENTS = [
  { key: 'GreenT', rate: 0.15 },
  { key: 'Parallel', rate: 0.45 },
  { key: 'HeadOn', rate: 0.30 },
  { key: 'RedT', rate: 0.10 },
] as const;

// 可改修=★10, 不可改修=★0 (按 kc-web canRemodel)
// mode: 'radar'=带电探型(缶+电探+炮) / 'gun'=多炮型(缶+多1炮, 不带电探)
// 注: 电探带回避(avoid2: SG系+6/逆探+22号+5/SCレーダー改+4/GFCS+2), 故两模式生存不同。
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
  org_type: orgType, fleet_type: 'Main', fleet_len: len, index, formation,
});

// 敌=攻击方(left), 我=被攻击(right)
const makeConfig = (engagement: string) => ({
  engagement,
  left: shipConditions('EnemySingle', 1, 0, ENEMY_FORMATION),
  right: shipConditions('Single', 6, 0, OWN_FORMATION),
});

function expectedDamage(density: Record<string, number>): number {
  let e = 0;
  for (const [k, p] of Object.entries(density)) e += Number(k) * p;
  return e;
}
const wmean = (byEng: Record<string, number>) => ENGAGEMENTS.reduce((s, e) => s + e.rate * (byEng[e.key] ?? 0), 0);

(async () => {
  const md = await loadFhMasterData();
  const core = new FhCore(md);
  const analyzer = core.create_analyzer();
  const ships = buildShipIndex(md);
  const gears = buildGearIndex(md);

  // --- 敌方: C/L 去重,选炮击/雷击最强的攻击源 ---
  const map = await loadFhMap(32);
  const enemyIds = new Set<number>();
  for (const point of ['C', 'L']) {
    for (const comp of getEnemiesAt(map, point)) for (const id of comp.main) enemyIds.add(id);
  }
  const enemies = [...enemyIds].map((id) => resolveEnemy(id, ships, gears)!).filter(Boolean);
  const gunBoss = [...enemies].sort((a, b) => b.firepower - a.firepower)[0]; // 炮击最强
  const torpBoss = [...enemies].sort((a, b) => b.torpedo - a.torpedo)[0]; // 雷击最强

  const enemyShipCache = new Map<number, any>();
  const getEnemyShip = (id: number) => {
    if (!enemyShipCache.has(id)) {
      const comp = core.create_comp_by_map_enemy(Uint16Array.from([id]));
      enemyShipCache.set(id, comp.main.get_ship('s1'));
    }
    return enemyShipCache.get(id);
  };

  // --- 我方 DD (每舰算带电探型+多炮型两套) ---
  const canRemodel = await loadCanRemodelMap();
  const configs = (await computeBest32()).slice(0, DD_TOP);
  const myShips = configs.map((c) => ({
    c,
    radarShip: core.create_ship(buildShipState(c, canRemodel, 'radar')),
    gunShip: core.create_ship(buildShipState(c, canRemodel, 'gun')),
  }));

  // 敌(enemyId)对我(myShip)的攻击。phase: 'day'(炮击) | 'closing_torpedo'(闭幕雷击)
  const analyze = (enemyId: number, myShip: any, phase: 'day' | 'closing_torpedo') => {
    const dmgByEng: Record<string, number> = {};
    const taihaByEng: Record<string, number> = {};
    let hit = 0;
    for (const { key } of ENGAGEMENTS) {
      const a = analyzer.analyze_ship_attack(makeConfig(key), getEnemyShip(enemyId), myShip, true);
      const report: any = a[phase];
      const rep: any = Object.values(report.data)[0];
      if (!rep) { hit = 0; dmgByEng[key] = 0; taihaByEng[key] = 0; continue; }
      hit = (rep.hit_rate?.total ?? 0) * 100; // 命中率与形态无关
      dmgByEng[key] = rep.damage ? expectedDamage(rep.damage.damage_density) : 0;
      const ds = rep.damage?.damage_state_density ?? {};
      taihaByEng[key] = (ds.Taiha ?? 0) + (ds.Sunk ?? 0); // 大破+击沉
    }
    return { hit, eDmg: wmean(dmgByEng), taiha: wmean(taihaByEng) * 100 };
  };

  // ===== 输出 =====
  console.log('============================================================');
  console.log(` 我方 DD 生存评估 (敌方→我方, Lv${LEVEL} 不喂运 / 单縦)`);
  console.log(` 炮击源=${gunBoss.name}(火${gunBoss.firepower}) / 雷击源=${torpBoss.name}(雷${torpBoss.torpedo})`);
  console.log(' 命中%=敌方命中我方的概率(与形态无关)。伤害/大破%按交战形态发生率加权。');
  console.log(' 大破%=满血受该单发后处于大破或击沉的概率。全部 fleethub-core 计算。');
  console.log('============================================================');
  console.log('舰娘/型\tHP\t裸回避\t被炮命中%\t被炮伤害\t炮大破%\t被雷命中%\t被雷伤害\t雷大破%');

  const row = (name: string, ship: any) => {
    const hp = ship.get_naked_stat?.('max_hp') ?? '?';
    const eva = ship.get_naked_stat?.('evasion') ?? '?';
    const g = analyze(gunBoss.shipId, ship, 'day');
    const t = analyze(torpBoss.shipId, ship, 'closing_torpedo');
    console.log(
      `${name}\t${hp}\t${eva}`
      + `\t${g.hit.toFixed(0)}%\t${g.eDmg.toFixed(1)}\t${g.taiha.toFixed(1)}%`
      + `\t${t.hit.toFixed(0)}%\t${t.eDmg.toFixed(1)}\t${t.taiha.toFixed(1)}%`,
    );
  };
  for (const { c, radarShip, gunShip } of myShips) {
    row(`${c.name}[探]`, radarShip);
    row(`${c.name}[炮]`, gunShip);
  }

  console.log('\n注: [探]=带电探型, [炮]=多炮型。电探带回避(SG系+6/逆探+22号+5/SCレーダー改+4/GFCS+2),');
  console.log('    故多炮型回避更低、被弹率更高 → 探/炮生存有别(此前误以为相同已更正)。');
  console.log('    单发评估(满血受 1 次攻击)。实战道中会被多个敌连续攻击,累积大破率更高。');
  console.log('    裸回避为无装备值(两模式相同); 实际回避含装备(缶+13、电探+4~6)与速度档, 已由 fleethub 计入被命中%。');
  console.log('    敌方回避值为社区推定,影响我方命中;我方装甲/回避由 fleethub 按 Lv170 计算。');
  for (const { radarShip, gunShip } of myShips) { radarShip.free?.(); gunShip.free?.(); }
})().catch((e) => { console.error(e); process.exit(1); });
