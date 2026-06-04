/* eslint-disable no-console */
/**
 * DD @ 3-2 综合一览(火力 + 进攻命中/伤害 + 生存遭受伤害)+ 装备明细
 *
 * 每艘 DD 出两行:
 *   [探]=带电探型(炮+电探1 (+非特例タービン) + 缶孔)
 *   [炮]=多炮型  (炮(多1门) (+非特例タービン) + 缶孔, 不带电探)
 *
 * 表(对齐, CJK 宽度感知; 敌名用 T1~T6 简写见图例):
 *   火力 / HP / 避(裸回避) / 命中min%(暴, 对硬目标最低命中) / 伤@T1..T6(加权期望伤害)
 *   / 被炮% / 炮破%(炮大破) / 被雷% / 雷伤 / 雷破%(雷大破)
 * 表下: 各 DD 的 [探]/[炮] 装备明细(含改修★)。
 *
 * 命中/伤害/大破=fleethub-core; 火力=kc-web。固定 Lv170 / 不喂运 / 单縦 / 高速+統一。
 * 交战形态加权: 同航45/反航30/T有利15/T不利10%。
 *
 * 运行: npx tsx tests/kcAnalysis/ddSummary32.ts
 */
import * as fs from 'fs';
import { createRequire } from 'module';
import {
  loadFhMasterData, loadFhMap, getEnemiesAt, buildShipIndex, buildGearIndex, resolveEnemy,
} from './loadEnemy';
import { computeBest32, BOILER_ID, TURBINE_ID, type Dd32Config } from './ddFire32';
import { loadMaster, loadCanRemodelMap } from './loadMaster';

const require = createRequire(import.meta.url);
const { FhCore } = require('fleethub-core');

// 收集所有输出, 末尾可直接写入 UTF-8 文件(规避 PowerShell `>` 的 UTF-16/控制台编码乱码)。
// 用法: npx tsx tests/kcAnalysis/ddSummary32.ts [输出文件]  例: ... ddSummary32.ts result.txt
const OUT: string[] = [];
const origLog = console.log.bind(console);
console.log = (...a: unknown[]) => { OUT.push(a.map(String).join(' ')); origLog(...a); };

// ===== 配置 =====
const LEVEL = 170;
const OWN_FORMATION = 'LineAhead';
const ENEMY_FORMATION = 'LineAhead';
const RANK_TOP = 20; // 从全体 DD 中展示综合分前 N 艘
const HARD_ARMOR = 20;
// 评分权重(可调)。fleethub 无内置舰娘评分, 此为本项目自定义。
const W_OFF = 0.55; // 进攻(对硬目标平均一击必沉率)
const W_SURV = 0.45; // 生存(单次C/L不被大破率)
const TAIHA_ZERO = 0.30; // 生存绝对刻度: 被大破率达此值=0分, 0%=100分

const ENGAGEMENTS = [
  { key: 'GreenT', rate: 0.15 },
  { key: 'Parallel', rate: 0.45 },
  { key: 'HeadOn', rate: 0.30 },
  { key: 'RedT', rate: 0.10 },
] as const;
const wmean = (by: Record<string, number>) => ENGAGEMENTS.reduce((s, e) => s + e.rate * (by[e.key] ?? 0), 0);

// ---- CJK 宽度感知的对齐工具(仅 CJK/全角算双宽; 西里尔/希腊等仍单宽)----
const isWide = (cp: number) => (cp >= 0x1100 && cp <= 0x115F)
  || (cp >= 0x2e80 && cp <= 0xa4cf) // CJK部首~平假名片假名~CJK统合等
  || (cp >= 0xac00 && cp <= 0xd7a3) // 韩文
  || (cp >= 0xf900 && cp <= 0xfaff) // CJK兼容
  || (cp >= 0xfe30 && cp <= 0xfe4f) // CJK竖排标点
  || (cp >= 0xff00 && cp <= 0xff60) // 全角ASCII
  || (cp >= 0xffe0 && cp <= 0xffe6) // 全角符号
  || (cp >= 0x20000 && cp <= 0x3fffd); // CJK扩展
const dispWidth = (s: string) => Array.from(s).reduce((w, ch) => w + (isWide(ch.codePointAt(0) ?? 0) ? 2 : 1), 0);
const pad = (s: string, w: number, right = false) => {
  const gap = Math.max(0, w - dispWidth(s));
  return right ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
};
function printTable(headers: string[], rows: string[][], rightFrom: number) {
  const widths = headers.map((h, i) => Math.max(dispWidth(h), ...rows.map((r) => dispWidth(r[i] ?? ''))));
  const line = (cells: string[]) => cells.map((c, i) => pad(c ?? '', widths[i], i >= rightFrom)).join('  ');
  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}

// 缶恒塞孔; 非特例占1装备位タービン
function buildShipState(c: Dd32Config, canRemodel: Map<number, boolean>, mode: 'radar' | 'gun') {
  const star = (id: number) => (canRemodel.get(id) ? 10 : 0);
  const state: Record<string, unknown> = { ship_id: c.shipId, level: LEVEL };
  let slot = 1;
  state.gx = { gear_id: BOILER_ID, stars: star(BOILER_ID) };
  const guns = mode === 'radar' ? c.gunIdsRadar : c.gunIdsGun;
  for (const id of guns) state[`g${slot++}`] = { gear_id: id, stars: star(id) };
  if (mode === 'radar') state[`g${slot++}`] = { gear_id: c.radarId, stars: star(c.radarId) };
  if (!c.special) state[`g${slot++}`] = { gear_id: TURBINE_ID, stars: star(TURBINE_ID) };
  for (const id of (mode === 'radar' ? c.extraIdsRadar : c.extraIdsGun)) state[`g${slot++}`] = { gear_id: id, stars: star(id) };
  return state;
}

const cond = (orgType: string, len: number, formation: string) => ({
  org_type: orgType, fleet_type: 'Main', fleet_len: len, index: 0, formation,
});
const offCfg = (eng: string) => ({ engagement: eng, left: cond('Single', 6, OWN_FORMATION), right: cond('EnemySingle', 1, ENEMY_FORMATION) });
const defCfg = (eng: string) => ({ engagement: eng, left: cond('EnemySingle', 1, ENEMY_FORMATION), right: cond('Single', 6, OWN_FORMATION) });

const expDmg = (density: Record<string, number>): number => {
  let e = 0;
  for (const [k, p] of Object.entries(density)) e += Number(k) * p;
  return e;
};

(async () => {
  const md = await loadFhMasterData();
  const core = new FhCore(md);
  const analyzer = core.create_analyzer();
  const ships = buildShipIndex(md);
  const gears = buildGearIndex(md);

  // 装备名/改修档(用于装备明细)
  const master = await loadMaster();
  const itemInfo = new Map(master.items.map((i) => [i.id, { name: i.name, star: (i as { canRemodel?: unknown }).canRemodel ? 10 : 0 }]));
  const label = (id: number) => { const it = itemInfo.get(id)!; return `${it.name}★${it.star}`; };
  const gunSummary = (gunIds: number[]) => {
    const counts: Record<number, number> = {};
    for (const id of gunIds) counts[id] = (counts[id] || 0) + 1;
    return Object.entries(counts).map(([id, k]) => `${label(Number(id))}×${k}`).join(' + ') || '(无主炮)';
  };

  // --- 敌方 C/L ---
  const map = await loadFhMap(32);
  const enemyIds = new Set<number>();
  for (const point of ['C', 'L']) {
    for (const comp of getEnemiesAt(map, point)) for (const id of comp.main) enemyIds.add(id);
  }
  const enemies = [...enemyIds].map((id) => resolveEnemy(id, ships, gears)!).filter(Boolean).sort((a, b) => b.armor - a.armor);

  const hardByName = new Map<string, ReturnType<typeof resolveEnemy>>();
  for (const e of enemies) {
    if (e.armor < HARD_ARMOR) continue;
    const cur = hardByName.get(e.name);
    if (!cur || e.armor > cur.armor) hardByName.set(e.name, e);
  }
  const hardTargets = [...hardByName.values()].sort((a, b) => b!.armor - a!.armor);
  const hardNames = new Set(hardTargets.map((t) => t!.name));
  const softSeen = new Set<string>();
  const softTargets = enemies.filter((e) => {
    if (e.armor >= HARD_ARMOR || hardNames.has(e.name) || softSeen.has(e.name)) return false;
    softSeen.add(e.name);
    return true;
  });
  const gunBoss = [...enemies].sort((a, b) => b.firepower - a.firepower)[0];
  const torpBoss = [...enemies].sort((a, b) => b.torpedo - a.torpedo)[0];

  // 实际敌方人口: 跨 C+L 所有 pattern 按 ship_id 计数(权重=出现频率)。进攻分据此加权。
  const popCount = new Map<number, number>();
  for (const point of ['C', 'L']) {
    for (const comp of getEnemiesAt(map, point)) for (const id of comp.main) popCount.set(id, (popCount.get(id) || 0) + 1);
  }
  const popList = [...popCount.entries()]
    .map(([id, count]) => ({ e: resolveEnemy(id, ships, gears)!, count }))
    .filter((x) => x.e)
    .sort((a, b) => b.count - a.count);
  const totalPop = popList.reduce((s, x) => s + x.count, 0);

  const enemyShipCache = new Map<number, any>();
  const enemyShip = (id: number) => {
    if (!enemyShipCache.has(id)) enemyShipCache.set(id, core.create_comp_by_map_enemy(Uint16Array.from([id])).main.get_ship('s1'));
    return enemyShipCache.get(id);
  };

  // --- 我方 DD: 取全部改造形态, 按 origId 分组(每组按火力降序)---
  const canRemodel = await loadCanRemodelMap();
  const allForms = await computeBest32(false);
  const byOrig = new Map<number, Dd32Config[]>();
  for (const c of allForms) {
    if (!byOrig.has(c.origId)) byOrig.set(c.origId, []);
    byOrig.get(c.origId)!.push(c);
  }

  const offense = (myShip: any, enemyId: number) => {
    const dmg: Record<string, number> = {}; const sunk: Record<string, number> = {};
    let hit = 0;
    for (const { key } of ENGAGEMENTS) {
      const a = analyzer.analyze_ship_attack(offCfg(key), myShip, enemyShip(enemyId), true);
      const rep: any = Object.values(a.day.data)[0];
      hit = (rep.hit_rate?.total ?? 0) * 100;
      dmg[key] = rep.damage ? expDmg(rep.damage.damage_density) : 0;
      sunk[key] = (rep.damage?.damage_state_density ?? {}).Sunk ?? 0; // 一击必沉概率
    }
    return { hit, wdmg: wmean(dmg), kill: wmean(sunk) };
  };
  const defense = (enemyId: number, myShip: any, phase: 'day' | 'closing_torpedo') => {
    const dmg: Record<string, number> = {}; const taiha: Record<string, number> = {};
    let hit = 0;
    for (const { key } of ENGAGEMENTS) {
      const a = analyzer.analyze_ship_attack(defCfg(key), enemyShip(enemyId), myShip, true);
      const rep: any = Object.values(a[phase].data)[0];
      if (!rep) { dmg[key] = 0; taiha[key] = 0; continue; }
      hit = (rep.hit_rate?.total ?? 0) * 100;
      dmg[key] = rep.damage ? expDmg(rep.damage.damage_density) : 0;
      const ds = rep.damage?.damage_state_density ?? {};
      taiha[key] = (ds.Taiha ?? 0) + (ds.Sunk ?? 0);
    }
    return { hit, wdmg: wmean(dmg), taiha: wmean(taiha) * 100 };
  };

  // ===== 头部说明 + 图例 =====
  console.log('============================================================================');
  console.log(` DD @ 3-2 综合一览 (Lv${LEVEL} 不喂运 / 单縦 / 高速+統一)`);
  console.log(' [探]带电探型  [炮]多炮型。火力=kc-web; 命中/伤害/大破=fleethub。交战形态 同45/反30/T有15/T不10% 加权。');
  console.log(' 进攻: 杀%=按实际敌方出现频率加权的一击必沉率; 伤@Tn=对该硬目标加权期望伤害; 命中min=对各硬目标最低命中。 生存=敌→我(满血受单发)。');
  console.log(` 生存攻击源: 炮=${gunBoss.name}(火${gunBoss.firepower}) 雷=${torpBoss.name}(雷${torpBoss.torpedo})`);
  console.log(` 实际敌方人口(C+L跨pattern计数, 杀%按此加权): ${popList.map((x) => `${x.e.name}(装${x.e.armor}/HP${x.e.hp})×${x.count}`).join(', ')}`);
  console.log('  硬目标图例(伤@列):');
  hardTargets.forEach((t, i) => console.log(`   T${i + 1} = ${t!.name} (装甲${t!.armor} / 回避${t!.evasion} / HP${t!.hp})`));
  console.log('============================================================================');

  // ===== 收集每行数据 + 评分 =====
  interface Row {
    name: string; shipName: string; mode: string; special: boolean;
    fp: number; hp: string; eva: string; minHit: number; crit: number;
    offDmg: number[]; gunHit: number; gunTaiha: number; torpHit: number; torpDmg: number; torpTaiha: number;
    offKill: number; survRate: number; // 0~1
    evaUnknown: boolean; // 回避社区未推定(新船), 无法算生存
  }
  const mkRow = (shipName: string, mode: string, special: boolean, ship: any, fp: number): Row => {
    const evaUnknown = (ship.has_unknown_stat?.('evasion') ?? false) || ship.get_naked_stat?.('evasion') == null;
    const hp = String(ship.get_naked_stat?.('max_hp') ?? '?');
    const eva = String(ship.get_naked_stat?.('evasion') ?? '?');
    // 对人口里每个敌舰算一次进攻(缓存); 硬目标列与频率加权必沉率都复用它
    const offByEnemy = new Map<number, { hit: number; wdmg: number; kill: number }>();
    for (const { e } of popList) offByEnemy.set(e.shipId, offense(ship, e.shipId));
    const offs = hardTargets.map((t) => offByEnemy.get(t!.shipId)!);
    const minHit = Math.min(...offs.map((o) => o.hit));
    const a0 = analyzer.analyze_ship_attack(offCfg('Parallel'), ship, enemyShip(hardTargets[offs.findIndex((o) => o.hit === minHit)]!.shipId), true);
    const crit = ((Object.values(a0.day.data)[0] as any)?.hit_rate?.critical ?? 0) * 100;
    const gun = defense(gunBoss.shipId, ship, 'day');
    const torp = defense(torpBoss.shipId, ship, 'closing_torpedo');
    const offKill = popList.reduce((s, { e, count }) => s + offByEnemy.get(e.shipId)!.kill * count, 0) / totalPop;
    const combinedTaiha = 1 - (1 - gun.taiha / 100) * (1 - torp.taiha / 100);
    return {
      name: `${shipName}[${mode}]`, shipName, mode, special, fp, hp, eva, minHit, crit,
      offDmg: offs.map((o) => o.wdmg), gunHit: gun.hit, gunTaiha: gun.taiha, torpHit: torp.hit, torpDmg: torp.wdmg, torpTaiha: torp.taiha,
      offKill, survRate: 1 - combinedTaiha, evaUnknown,
    };
  };
  // 给一个配置算探/炮两行(算完即释放 wasm ship)
  const scoreForm = (c: Dd32Config): Row[] => {
    const radar = core.create_ship(buildShipState(c, canRemodel, 'radar'));
    const gun = core.create_ship(buildShipState(c, canRemodel, 'gun'));
    const rows = [mkRow(c.name, '探', c.special, radar, c.fpRadar), mkRow(c.name, '炮', c.special, gun, c.fpGun)];
    radar.free?.(); gun.free?.();
    return rows;
  };

  // 每条船(origId): 进排名的是"最强且回避已知"的形态; 若最强形态回避未知, 另列入 pending。
  const data: Row[] = [];
  const chosenCfg = new Map<string, Dd32Config>();
  for (const forms of byOrig.values()) {
    let rep: Row[] | null = null;
    let repCfg: Dd32Config = forms[0];
    for (const c of forms) { // fpGun 降序: 取"最强且回避已知"的形态进排名
      const rows = scoreForm(c);
      if (!rows[0].evaUnknown) { rep = rows; repCfg = c; break; }
    }
    if (rep) { data.push(rep[0], rep[1]); chosenCfg.set(repCfg.name, repCfg); }
  }

  // 评分(绝对刻度): 进攻=频率加权一击必沉%; 生存=按 30%大破=0 线性; 综合=加权
  const offScore = (d: Row) => d.offKill * 100;
  const survScore = (d: Row) => Math.max(0, Math.min(100, (1 - (1 - d.survRate) / TAIHA_ZERO) * 100));
  const total = (d: Row) => W_OFF * offScore(d) + W_SURV * survScore(d);

  // data 已是"每船最强可评形态"(回避已知)。直接据此排名, 取前 RANK_TOP。
  const bestByShip = new Map<string, number>();
  for (const d of data) bestByShip.set(d.shipName, Math.max(bestByShip.get(d.shipName) ?? -1, total(d)));
  const rankedShips = [...bestByShip.keys()].sort((a, b) => bestByShip.get(b)! - bestByShip.get(a)!);
  const topShips = rankedShips.slice(0, RANK_TOP);
  const topSet = new Set(topShips);

  // ===== 评分排行 TOP-N(主输出)=====
  const bestRow = new Map<string, Row>();
  for (const d of data) { const cur = bestRow.get(d.shipName); if (!cur || total(d) > total(cur)) bestRow.set(d.shipName, d); }
  console.log(`\n==== 评分排行 TOP${RANK_TOP} (全 ${rankedShips.length} 艘 DD; 每舰最佳模式; 进攻${Math.round(W_OFF * 100)}% + 生存${Math.round(W_SURV * 100)}%)====`);
  console.log(`  进攻分=按实际敌方频率加权一击必沉%; 生存分=单次C/L不被大破(${Math.round(TAIHA_ZERO * 100)}%大破=0分); fleethub 无内置评分, 此为自定义。`);
  const rkRows = topShips.map((name, i) => {
    const d = bestRow.get(name)!;
    return [`${i + 1}`, name, d.mode, `${offScore(d).toFixed(0)}`, `${survScore(d).toFixed(0)}`, total(d).toFixed(1)];
  });
  printTable(['#', '舰娘', '模式', '进攻分', '生存分', '综合分'], rkRows, 3);

  // ===== 回避社区未推定的新形态: 列出装备+进攻, 暂不进排名 =====
  // 用 fleethub master_data 的 evasion 直接判定(新船为 [null,null]), 免去逐个 create_ship
  const unknownEvaIds = new Set<number>(((md as any).ships ?? [])
    .filter((s: any) => s.evasion?.[0] == null).map((s: any) => s.ship_id));
  const newForms = allForms.filter((c) => unknownEvaIds.has(c.shipId)).sort((a, b) => b.fpGun - a.fpGun);
  if (newForms.length) {
    console.log(`\n⚠ 回避社区尚未推定的新形态(${newForms.length}个): fleethub 算不了生存→暂不进排名(只给进攻+装备)。`);
    console.log('  注: 改二補第4格只能機銃(主炮/電探/缶タービン全禁), 但機銃自带火力+夕雲型補正(引擎按舰穷举最优機銃) → 比对应改二高约5~6火力; 待社区测出回避后重跑即纳入排名。');
    const kijuStr = (ids: number[]) => (ids.length ? ` | 第4格:${ids.map((id) => label(id)).join('+')}` : '');
    for (const c of newForms) {
      const rows = scoreForm(c);
      const kit = c.special ? `缶:${label(BOILER_ID)}[孔]` : `${label(TURBINE_ID)} | 缶:${label(BOILER_ID)}[孔]`;
      console.log(`  ${c.name} (${c.slotCount}格): 火力炮${c.fpGun.toFixed(0)}/探${c.fpRadar.toFixed(0)} / 进攻杀%${(rows[1].offKill * 100).toFixed(0)} / 生存待回避`);
      console.log(`    [炮] ${gunSummary(c.gunIdsGun)} | ${kit}${kijuStr(c.extraIdsGun)}`);
      console.log(`    [探] ${gunSummary(c.gunIdsRadar)} | 电探:${label(c.radarId)} | ${kit}${kijuStr(c.extraIdsRadar)}`);
    }
  }

  // ===== 详表(前 RANK_TOP 艘, 按综合分降序; 每舰探/炮两行)=====
  console.log(`\n==== 详表(综合分前 ${RANK_TOP} 艘)====`);
  const headers = ['舰娘/型', '火力', 'HP', '避', '命中min%(暴)',
    ...hardTargets.map((_, i) => `伤@T${i + 1}`),
    '杀%', '被炮%', '炮破%', '被雷%', '雷伤', '雷破%', '综合'];
  const mainData = data.filter((d) => topSet.has(d.shipName))
    .sort((a, b) => (bestByShip.get(b.shipName)! - bestByShip.get(a.shipName)!) || (total(b) - total(a)));
  const rows = mainData.map((d) => [
    d.name, d.fp.toFixed(0), d.hp, d.eva, `${d.minHit.toFixed(0)}%(${d.crit.toFixed(0)})`,
    ...d.offDmg.map((x) => x.toFixed(0)),
    `${(d.offKill * 100).toFixed(0)}%`,
    `${d.gunHit.toFixed(0)}%`, `${d.gunTaiha.toFixed(1)}%`,
    `${d.torpHit.toFixed(0)}%`, d.torpDmg.toFixed(1), `${d.torpTaiha.toFixed(1)}%`,
    total(d).toFixed(0),
  ]);
  printTable(headers, rows, 1);

  console.log('\n■ 软目标(装甲<' + HARD_ARMOR + ', 命中几乎必中、大多一击): '
    + softTargets.map((t) => `${t.name}(装${t.armor}/HP${t.hp})`).join('  '));

  // ===== 装备明细(仅前 RANK_TOP 艘, 按排名)=====
  console.log(`\n==== 装备明细(前 ${RANK_TOP} 艘; ★=改修档; 缶孔=缶塞补强增设; 非特例舰另带 タービン)====`);
  topShips.forEach((name, i) => {
    const c = chosenCfg.get(name)!;
    const kit = c.special ? `缶:${label(BOILER_ID)}[孔]` : `${label(TURBINE_ID)} | 缶:${label(BOILER_ID)}[孔]`;
    console.log(`${i + 1}. ${c.name}${c.special ? ' (特例·缶孔)' : ''}`);
    console.log(`  [探] 火力${c.fpRadar.toFixed(0)}: ${gunSummary(c.gunIdsRadar)} | 电探:${label(c.radarId)} | ${kit}`);
    console.log(`  [炮] 火力${c.fpGun.toFixed(0)}: ${gunSummary(c.gunIdsGun)} | ${kit}`);
  });

  console.log('\n注: 进攻伤害/生存均为单发; 实战道中累积大破率更高。回避值含社区推定(敌方)。');
  console.log('    [探]电探带回避(+4~6)/命中加成; [炮]火力高伤害大但少这部分。详见 README。');

  // 传了文件名就直接写 UTF-8(node 默认 UTF-8 无 BOM, VSCode 可正常识别)
  const outPath = process.argv[2] || process.env.KC_OUT;
  if (outPath) {
    fs.writeFileSync(outPath, `${OUT.join('\n')}\n`, { encoding: 'utf8' });
    origLog(`\n[已写入 UTF-8 文件: ${outPath}]`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
