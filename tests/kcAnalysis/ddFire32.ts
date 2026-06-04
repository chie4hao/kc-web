/* eslint-disable no-console */
/**
 * DD 昼战火力排名(3-2 用 / 高速+統一·随机沟 版)
 *
 * 3-2 路线策略(已与实战取舍定稿):
 *   - 全队 高速+統一,不追最速(缶太多不划算)。速度件配置:
 *       · 特例 4 舰: 缶塞补强增设(孔)即可高速+, 装备位全留炮/电探。
 *       · 其余舰    : 缶塞孔 + 装备位再放 1 个タービン(缶+タービン协同)才高速+。
 *       (即非特例舰要额外占 1 个装备位放タービン)
 *   - 不强求绕渦潮的 CEFL(高速+統一要绕渦潮需电探5艘 / 最速統一才是4艘)。
 *     接受「随机沟」: C→E(跳过) 或 C→G(渦潮),并可能从 G 随机去 H 多打一场。
 *   - 渦潮(G·燃料)减免按「带电探的舰数」计,无上限、但边际收益急剧衰减:
 *       电探数 0/1/2/3/4/5/6 → 实际喪失率 28/21/16.8/14/12.6/11.76/11.2 %
 *     0→3 把损耗腰斩(28%→14%),3 以后每艘只省不到 1.4pp,故 3 艘是火力/省油甜区。
 *
 * 速度件对火力无影响: 缶(87)与タービン(33)火力均为 0,故火力排名不受其占位影响
 * (占位数已在 gunSlots 里扣掉)。タービン 回避+6,但 Lv170 高回避区被上限吸收、生存几乎不变;
 *  低等级时タービン回避才会真正起作用。
 *
 * 每艘 DD 有两种 3-2 配置,本脚本都算:
 *   ① 带电探型: 炮 + 电探1 (+非特例タービン) + 缶(孔)
 *   ② 多炮型  : 炮 (比①多 1 门) (+非特例タービン) + 缶(孔),不带电探
 * 组队时:选定 6 艘后,把电探发给「换炮收益最小(Δ最小)」的若干艘,其余用多炮型。
 *
 * 特例舰(仅缶孔即高速+, 装备位全留炮/电探):
 *   - 吹雪改三護(六式) 1040 / 天津風改二 951 / 島風改 229 / Ташкент改 395
 *
 * 装备改修: 可改修(kc-web canRemodel)=★MAX, 不可改修=★0(缶可改修=★10; タービン不可=★0)。
 *
 * 运行: npx tsx tests/kcAnalysis/ddFire32.ts
 */
import ShipMaster from '../../src/classes/fleet/shipMaster';
import ItemMaster from '../../src/classes/item/itemMaster';
import Item from '../../src/classes/item/item';
import Ship from '../../src/classes/fleet/ship';
import Const, { FLEET_TYPE, SHIP_TYPE } from '../../src/classes/const';
import { loadMaster } from './loadMaster';

const REMODEL = 10;
const MIX_TOP = 18;
/** 新型高温高圧缶(火力0, 回避+13, 可改修)。全员塞补强增设(孔)。 */
export const BOILER_ID = 87;
/** 改良型艦本式タービン(火力0, 回避+6, 不可改修)。非特例舰占 1 装备位以达高速+。 */
export const TURBINE_ID = 33;
// 特例舰: 仅缶塞孔即高速+, 装备位全留炮/电探(不需タービン)。
// 吹雪改三護(六式)1040 / 天津風改二 951 / 島風改 229 / Ташкент改 395
const SPECIAL_IDS = new Set([1040, 951, 229, 395]);

/** 3-2 G うずしお(燃料) 各「带电探舰数」的实际喪失率%(index=电探艦数, 0~6) */
export const UZUSHIO_LOSS = [28, 21, 16.8, 14, 12.6, 11.76, 11.2];

/** 火力最优配置(1 艘)。装备 id 为 api_id(kc-web/fleethub 通用)。 */
export interface Dd32Config {
  shipId: number;
  name: string;
  /** 原型舰 id(同一舰各改造共享), 供消费方按舰去重 */
  origId: number;
  slotCount: number;
  /** true=特例舰(仅缶孔即高速+, 装备位全留炮/电探); false=非特例(装备位另占1位タービン) */
  special: boolean;
  // —— 带电探型(炮 + 电探1 (+タービン) + 缶孔)——
  /** 带电探时基础昼战火力 */
  fpRadar: number;
  /** 带电探时主炮 id 列表 */
  gunIdsRadar: number[];
  /** 电探 id */
  radarId: number;
  /** 带电探型: 死格(改二補第4格)填充的機銃 id, 无则空数组 */
  extraIdsRadar: number[];
  // —— 多炮型(炮 (+タービン) + 缶孔, 不带电探, 比带电探多 1 门主炮)——
  /** 不带电探(多 1 炮)时基础昼战火力 */
  fpGun: number;
  /** 不带电探时主炮 id 列表 */
  gunIdsGun: number[];
  /** 多炮型: 死格(改二補第4格)填充的機銃 id, 无则空数组 */
  extraIdsGun: number[];
}

/**
 * 返回各 DD 在 3-2 的两种配置(带电探型/多炮型)。
 * dedup=true(默认): 同一舰只留最强改造; false: 返回所有改造形态(供消费方按 origId 自行去重)。
 */
export async function computeBest32(dedup = true): Promise<Dd32Config[]> {
  const master = await loadMaster();

  const itemMasters = new Map<number, ItemMaster>();
  for (const raw of master.items) itemMasters.set(raw.id, new ItemMaster(raw as never));

  // 可改修=★MAX, 不可改修=★0 (按 kc-web canRemodel)
  const remodelOf = (id: number) => (itemMasters.get(id)!.canRemodel ? REMODEL : 0);
  const mkItem = (id: number) => new Item({ master: itemMasters.get(id)!, remodel: remodelOf(id), slot: 0 });

  const isPlayer = (i: { name: string; id: number }) => !/深海/.test(i.name) && i.id < 1500;
  const gunCands: Item[] = master.items
    .filter((i) => i.type === 1 && isPlayer(i))
    .map((i) => mkItem(i.id));
  const radarCands: Item[] = master.items
    .filter((i) => i.type === 12 && isPlayer(i))
    .map((i) => mkItem(i.id));

  const soloValue = (it: Item) => it.data.fire + it.bonusFire;
  const gunMix = [...gunCands].sort((a, b) => soloValue(b) - soloValue(a)).slice(0, MIX_TOP);
  // 死格(改二補第4格)可放的對空機銃(type21)。其火力/補正(含 requiresSR 等)由引擎算。
  const kijuCands: Item[] = master.items
    .filter((i) => i.type === 21 && isPlayer(i))
    .map((i) => mkItem(i.id));

  // 普通槽: 主炮 + (电探) + (非特例: タービン) + (死格機銃 extraIds); 缶恒塞补强增设(孔)
  function build(sm: ShipMaster, gunIds: number[], radarId: number, special: boolean, extraIds: number[]) {
    const normal: Item[] = gunIds.map((id) => mkItem(id));
    if (radarId) normal.push(mkItem(radarId));
    if (!special) normal.push(mkItem(TURBINE_ID));
    for (const id of extraIds) normal.push(mkItem(id));
    const ship = new Ship({ master: sm, level: 99, items: normal, exItem: mkItem(BOILER_ID) });
    return { fp: Ship.getDayBattleFirePower(ship, FLEET_TYPE.SINGLE, false) };
  }

  function buildGunSets(gunSlots: number): number[][] {
    const gunSets: number[][] = [];
    if (gunSlots === 0) { gunSets.push([]); return gunSets; }
    for (const g of gunCands) gunSets.push(Array(gunSlots).fill(g.data.id));
    if (gunSlots >= 2) {
      for (let a = 0; a < gunMix.length; a += 1) {
        for (let b = a + 1; b < gunMix.length; b += 1) {
          for (let k = 1; k < gunSlots; k += 1) {
            gunSets.push([...Array(k).fill(gunMix[a].data.id), ...Array(gunSlots - k).fill(gunMix[b].data.id)]);
          }
        }
      }
    }
    return gunSets;
  }

  // 可放 主炮/电探/速度件 的槽位数。扣掉"死格": 某槽位同时禁 主炮(1)+小型電探(12)+機関部強化(17),
  // 即改二補的第4格(只能機銃/おにぎり),对火力/电探/タービン全无用 → 不计入。
  // (時雨改三/初月改二等第4格只禁主炮/魚雷, 仍可放電探/タービン, 不算死格)
  const usableSlots = (sm: ShipMaster) => {
    let dead = 0;
    for (let i = 1; i <= sm.slotCount; i += 1) {
      const f = Const.FORBIDDEN_LINK_SHIP_ITEM.find((v) => v.shipId === sm.id && v.index.includes(i));
      if (f && [1, 12, 17].every((t) => f.itemType.includes(t))) dead += 1;
    }
    return sm.slotCount - dead;
  };

  // withRadar=true: 普通槽=主炮+电探1(+タービン);false: 普通槽=主炮(+タービン),不带电探多 1 门炮
  // deadCount>0(改二補): 死格穷举機銃(电探会触发機銃補正, 故探/炮各自挑最优機銃)
  function evalMode(sm: ShipMaster, usable: number, deadCount: number, special: boolean, withRadar: boolean) {
    const gunSlots = usable - (withRadar ? 1 : 0) - (special ? 0 : 1);
    if (gunSlots < 0) return null;
    const kijuOpts: number[][] = deadCount > 0 ? kijuCands.map((k) => Array(deadCount).fill(k.data.id)) : [[]];
    const radarIds = withRadar ? radarCands.map((r) => r.data.id) : [0];
    let best = { fp: -1, gunIds: [] as number[], radarId: 0, extraIds: [] as number[] };
    for (const gunIds of buildGunSets(gunSlots)) {
      for (const radarId of radarIds) {
        for (const extraIds of kijuOpts) {
          const { fp } = build(sm, gunIds, radarId, special, extraIds);
          if (fp > best.fp) best = { fp, gunIds, radarId, extraIds };
        }
      }
    }
    return best;
  }

  type Best = {
    fpRadar: number; gunIdsRadar: number[]; radarId: number; extraIdsRadar: number[];
    fpGun: number; gunIdsGun: number[]; extraIdsGun: number[]; sm: ShipMaster; special: boolean;
  };
  const results: Best[] = [];

  for (const raw of master.ships.filter((s) => s.type === SHIP_TYPE.DD)) {
    const sm = new ShipMaster(raw as never);
    const special = SPECIAL_IDS.has(sm.id);
    const usable = usableSlots(sm);
    const deadCount = sm.slotCount - usable;
    const r = evalMode(sm, usable, deadCount, special, true);
    const g = evalMode(sm, usable, deadCount, special, false);
    if (!r || !g) continue;
    results.push({
      fpRadar: r.fp, gunIdsRadar: r.gunIds, radarId: r.radarId, extraIdsRadar: r.extraIds,
      fpGun: g.fp, gunIdsGun: g.gunIds, extraIdsGun: g.extraIds, sm, special,
    });
  }

  const toConfig = (r: Best): Dd32Config => ({
    shipId: r.sm.id,
    name: r.sm.name,
    origId: r.sm.originalId || r.sm.id,
    slotCount: r.sm.slotCount,
    special: r.special,
    fpRadar: r.fpRadar,
    gunIdsRadar: r.gunIdsRadar,
    radarId: r.radarId,
    extraIdsRadar: r.extraIdsRadar,
    fpGun: r.fpGun,
    gunIdsGun: r.gunIdsGun,
    extraIdsGun: r.extraIdsGun,
  });

  // dedup=false: 返回全部改造形态(按多炮火力降序)
  if (!dedup) return results.map(toConfig).sort((a, b) => b.fpGun - a.fpGun);

  // 同一舰(originalId)只保留最强改造(以多炮型火力为准)
  const byOrig = new Map<number, Best>();
  for (const r of results) {
    const orig = r.sm.originalId || r.sm.id;
    const cur = byOrig.get(orig);
    if (!cur || r.fpGun > cur.fpGun) byOrig.set(orig, r);
  }
  return [...byOrig.values()].sort((a, b) => b.fpGun - a.fpGun).map(toConfig);
}

async function printRanking() {
  const master = await loadMaster();
  // 装备 id -> {名称, 改修档(可改修★10/不可改修★0)}
  const info = new Map(master.items.map((i) => [i.id, { name: i.name, star: (i as { canRemodel?: unknown }).canRemodel ? 10 : 0 }]));
  const label = (id: number) => { const it = info.get(id)!; return `${it.name}★${it.star}`; };
  const gunSummary = (gunIds: number[]) => {
    const counts: Record<number, number> = {};
    for (const id of gunIds) counts[id] = (counts[id] || 0) + 1;
    return Object.entries(counts).map(([id, k]) => `${label(Number(id))}×${k}`).join(' + ') || '(无主炮)';
  };
  // 速度件后缀: 特例=缶孔; 非特例=タービン + 缶孔
  const speedKit = (special: boolean) => (special ? `缶:${label(BOILER_ID)}[孔]` : `${label(TURBINE_ID)} | 缶:${label(BOILER_ID)}[孔]`);
  const kijuStr = (ids: number[]) => (ids.length ? ` | 機銃:${ids.map((id) => label(id)).join('+')}` : '');

  const configs = await computeBest32();

  console.log('==== 3-2 DD昼战基础火力(高速+統一·随机沟) 同一舰最强改造 TOP35 ====');
  console.log('  速度件: 特例舰=缶塞孔; 非特例舰=缶塞孔 + 装备位1个タービン(均不计火力)。');
  console.log('  每舰两种配置: ①带电探型(炮+电探) ②多炮型(多1炮,不带电探)');
  console.log('  Δ = 多炮火力 − 电探火力 = 用电探换 1 门炮的火力收益。组队时电探发给 Δ 最小者最划算。');
  console.log('  ★ = 特例舰(缶孔, 装备位全留炮/电探, 比同槽位多 1 门炮)');
  console.log('排名\t电探火力\t多炮火力\tΔ\t舰娘\t槽');
  configs.slice(0, 35).forEach((c, i) => {
    const d = (c.fpGun - c.fpRadar).toFixed(2);
    console.log(`${i + 1}${c.special ? '★' : ' '}\t${c.fpRadar.toFixed(2)}\t${c.fpGun.toFixed(2)}\t+${d}\t${c.name}\t${c.slotCount}`);
  });

  // ---- 装备明细(前15)----
  console.log('\n---- 装备明细(前15)----');
  configs.slice(0, 15).forEach((c, i) => {
    console.log(`${i + 1}. ${c.name}${c.special ? ' (特例·缶孔)' : ''}`);
    console.log(`   带电探型(${c.fpRadar.toFixed(1)}): ${gunSummary(c.gunIdsRadar)} | 电探:${label(c.radarId)} | ${speedKit(c.special)}${kijuStr(c.extraIdsRadar)}`);
    console.log(`   多炮型  (${c.fpGun.toFixed(1)}): ${gunSummary(c.gunIdsGun)} | ${speedKit(c.special)}${kijuStr(c.extraIdsGun)}`);
  });

  // ---- 组队建议: 火力最高的 6 艘 DD, 看「带几艘电探」的火力/渦潮损耗权衡 ----
  const top6 = [...configs].sort((a, b) => b.fpGun - a.fpGun).slice(0, 6);
  const delta = (c: Dd32Config) => c.fpGun - c.fpRadar;
  const byDelta = [...top6].sort((a, b) => delta(a) - delta(b)); // Δ升序: 越靠前越适合带电探
  console.log('\n---- 组队权衡(纯 DD·火力最高6艘; 电探优先发给 Δ 最小者)----');
  console.log('  ※仅按火力示意; 实际编队需 軽巡1+駆逐4以上 才进 C, CL 槽会替换其中一艘。');
  console.log('  电探数\t渦潮燃料损耗%\t该队总火力\t较0电探');
  const base = byDelta.reduce((s, c) => s + c.fpGun, 0);
  for (let k = 0; k <= 6; k += 1) {
    const total = byDelta.reduce((s, c, idx) => s + (idx < k ? c.fpRadar : c.fpGun), 0);
    const mark = k === 3 ? '  ← 甜区' : '';
    console.log(`  ${k}\t${UZUSHIO_LOSS[k]}%\t${total.toFixed(1)}\t-${(base - total).toFixed(1)}${mark}`);
  }
  console.log('\n  [按 3 电探分队] 带电探:');
  byDelta.slice(0, 3).forEach((c) => console.log(`    ${c.name}  火力${c.fpRadar.toFixed(1)} (Δ${delta(c).toFixed(1)})  ${gunSummary(c.gunIdsRadar)} + 电探:${label(c.radarId)}`));
  console.log('  [按 3 电探分队] 多炮:');
  byDelta.slice(3).forEach((c) => console.log(`    ${c.name}  火力${c.fpGun.toFixed(1)} (Δ${delta(c).toFixed(1)})  ${gunSummary(c.gunIdsGun)}`));
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('ddFire32.ts');
if (isMain) {
  printRanking().catch((e) => { console.error(e); process.exit(1); });
}
