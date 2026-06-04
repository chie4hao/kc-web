/* eslint-disable no-console */
/**
 * DD 昼战火力排名(全槽主炮版)
 *   - 算出全部槽位都装小口径主炮(★MAX)时的昼战炮击「基础火力」
 *   - 直接复用制空权模拟器本体的计算逻辑(Ship/Item/ItemBonus)
 *   - 装备补正(可视加成) + 改修补正(√★等) 全部计入
 *
 * 运行: npx tsx tests/kcAnalysis/ddFireFull.ts
 *
 * 昼战基础火力(通常舰队/单舰/对通常敌, ship.ts getDayBattleFirePower):
 *   = 素火力(近代化改修满) + 装备火力Σ + 可视装备补正 + 改修隐藏补正Σ + 5
 */
import ShipMaster from '../../src/classes/fleet/shipMaster';
import ItemMaster from '../../src/classes/item/itemMaster';
import Item from '../../src/classes/item/item';
import Ship from '../../src/classes/fleet/ship';
import { FLEET_TYPE, SHIP_TYPE } from '../../src/classes/const';
import { loadMaster } from './loadMaster';

const REMODEL = 10; // ★MAX 前提
const MIX_TOP = 18; // 2 种混载搜索使用的高火力主炮候选数

async function main() {
  const master = await loadMaster();

  const itemMasters = new Map<number, ItemMaster>();
  for (const raw of master.items) itemMasters.set(raw.id, new ItemMaster(raw as never));

  // 小口径主炮(apiType1)、排除深海(敌)装备(id<1500)
  const isPlayer = (i: { name: string; id: number }) => !/深海/.test(i.name) && i.id < 1500;
  const gunCands: Item[] = master.items
    .filter((i) => i.type === 1 && isPlayer(i))
    .map((i) => new Item({ master: itemMasters.get(i.id)!, remodel: REMODEL, slot: 0 }));

  const soloValue = (it: Item) => it.data.fire + it.bonusFire;
  const gunMix = [...gunCands].sort((a, b) => soloValue(b) - soloValue(a)).slice(0, MIX_TOP);
  const emptyItem = new Item();

  function evalLoadout(sm: ShipMaster, ids: number[]): number {
    const items = ids.map((id) => new Item({ master: itemMasters.get(id)!, remodel: REMODEL, slot: 0 }));
    const ship = new Ship({ master: sm, level: 99, items, exItem: emptyItem });
    return Ship.getDayBattleFirePower(ship, FLEET_TYPE.SINGLE, false);
  }

  type Best = { fp: number; ids: number[]; sm: ShipMaster };
  const results: Best[] = [];

  for (const raw of master.ships.filter((s) => s.type === SHIP_TYPE.DD)) {
    const sm = new ShipMaster(raw as never);
    const slots = sm.slotCount;
    if (slots <= 0) continue;

    let best: Best = { fp: -1, ids: [], sm };
    // 全槽同一炮
    for (const g of gunCands) {
      const ids = Array(slots).fill(g.data.id);
      const fp = evalLoadout(sm, ids);
      if (fp > best.fp) best = { fp, ids, sm };
    }
    // 2 种混载(拾取组合补正)
    for (let a = 0; a < gunMix.length; a += 1) {
      for (let b = a + 1; b < gunMix.length; b += 1) {
        for (let k = 1; k < slots; k += 1) {
          const ids = [...Array(k).fill(gunMix[a].data.id), ...Array(slots - k).fill(gunMix[b].data.id)];
          const fp = evalLoadout(sm, ids);
          if (fp > best.fp) best = { fp, ids, sm };
        }
      }
    }
    results.push(best);
  }

  // 同一舰只保留最强改造
  const byOrig = new Map<number, Best>();
  for (const r of results) {
    const orig = r.sm.originalId || r.sm.id;
    const cur = byOrig.get(orig);
    if (!cur || r.fp > cur.fp) byOrig.set(orig, r);
  }
  const uniq = [...byOrig.values()].sort((a, b) => b.fp - a.fp);

  const gunSummary = (ids: number[]) => {
    const c: Record<string, number> = {};
    for (const id of ids) { const n = itemMasters.get(id)!.name; c[n] = (c[n] || 0) + 1; }
    return Object.entries(c).map(([n, k]) => `${n}×${k}`).join(' + ');
  };

  console.log('==== DD 昼战基础火力 (全槽主炮★MAX / 同一舰最强改造) TOP40 ====');
  console.log('排名\t火力\t舰娘\t槽位\t最优主炮配置');
  uniq.slice(0, 40).forEach((r, i) => {
    console.log(`${i + 1}\t${r.fp.toFixed(2)}\t${r.sm.name}\t${r.sm.slotCount}\t${gunSummary(r.ids)}`);
  });

  console.log('\n==== 火力明细 TOP20 (素 / 装备 / 可视补正 / 改修补正 / 显示火力 / 基础火力) ====');
  console.log('舰娘\t素\t装备\t可视\t改修\t显示\t基础');
  uniq.slice(0, 20).forEach((r) => {
    const items = r.ids.map((id) => new Item({ master: itemMasters.get(id)!, remodel: REMODEL, slot: 0 }));
    const ship = new Ship({ master: r.sm, level: 99, items, exItem: emptyItem });
    const eqFire = items.reduce((s, it) => s + it.data.fire, 0);
    const vis = ship.itemBonusStatus.firePower ?? 0;
    const rem = items.reduce((s, it) => s + it.bonusFire, 0);
    console.log(`${r.sm.name}\t${r.sm.fire}\t${eqFire}\t${vis}\t${rem.toFixed(2)}\t${ship.displayStatus.firePower}\t${r.fp.toFixed(2)}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
