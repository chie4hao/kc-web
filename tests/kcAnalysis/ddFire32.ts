/* eslint-disable no-console */
/**
 * DD 昼戦火力ランキング(3-2用 / 電探+缶 強制版)
 *
 * 3-2 では「電探1 + 缶1」を必須装備とする前提:
 *   - 通常艦: 4スロ=主砲2 / 3スロ=主砲1 (電探と缶を通常スロに積む)
 *   - 特例艦: 缶を補強増設(打孔)に積んで最速到達できるため、通常スロは
 *             主砲(slot-1) + 電探1 となり主砲が1本増える
 *
 * 特例艦(高速+の素質があり、+7缶=新型高温高圧缶 単体を打孔に積むだけで最速):
 *   - 吹雪改三護(六式)  id 1040 (4スロ -> 主砲3)
 *   - 天津風改二        id  951 (3スロ -> 主砲2)
 *   - 島風改            id  229 (3スロ -> 主砲2)
 *   ※ Ташкент改 は対象外(この特例は上記3形態のみ)
 *
 * 電探枠は全プレイヤー小型電探(★MAX)を総当たりし、ItemBonus エンジンが
 * 「主砲+水上電探」等の組合せ補正・電探自身の火力を自動で拾う。
 *
 * 実行: npx tsx tests/kcAnalysis/ddFire32.ts
 */
import ShipMaster from '../../src/classes/fleet/shipMaster';
import ItemMaster from '../../src/classes/item/itemMaster';
import Item from '../../src/classes/item/item';
import Ship from '../../src/classes/fleet/ship';
import { FLEET_TYPE, SHIP_TYPE } from '../../src/classes/const';
import { loadMaster } from './loadMaster';

const REMODEL = 10;
const MIX_TOP = 18;
const BOILER_ID = 87; // 新型高温高圧缶(火力0)
// 缶を補強増設に積み、通常スロを1本主砲に回せる特例艦(最強形態のid)
const EXSLOT_BOILER_IDS = new Set([1040, 951, 229]);

async function main() {
  const master = await loadMaster();

  const itemMasters = new Map<number, ItemMaster>();
  for (const raw of master.items) itemMasters.set(raw.id, new ItemMaster(raw as never));

  const isPlayer = (i: { name: string; id: number }) => !/深海/.test(i.name) && i.id < 1500;
  const gunCands: Item[] = master.items
    .filter((i) => i.type === 1 && isPlayer(i))
    .map((i) => new Item({ master: itemMasters.get(i.id)!, remodel: REMODEL, slot: 0 }));
  const radarCands: Item[] = master.items
    .filter((i) => i.type === 12 && isPlayer(i))
    .map((i) => new Item({ master: itemMasters.get(i.id)!, remodel: REMODEL, slot: 0 }));

  const soloValue = (it: Item) => it.data.fire + it.bonusFire;
  const gunMix = [...gunCands].sort((a, b) => soloValue(b) - soloValue(a)).slice(0, MIX_TOP);
  const emptyItem = new Item();

  function build(sm: ShipMaster, gunIds: number[], radarId: number, boilerInEx: boolean) {
    const normal: Item[] = [
      ...gunIds.map((id) => new Item({ master: itemMasters.get(id)!, remodel: REMODEL, slot: 0 })),
      new Item({ master: itemMasters.get(radarId)!, remodel: REMODEL, slot: 0 }),
    ];
    let exItem = emptyItem;
    if (boilerInEx) exItem = new Item({ master: itemMasters.get(BOILER_ID)!, remodel: 0, slot: 0 });
    else normal.push(new Item({ master: itemMasters.get(BOILER_ID)!, remodel: 0, slot: 0 }));
    const ship = new Ship({ master: sm, level: 99, items: normal, exItem });
    return { fp: Ship.getDayBattleFirePower(ship, FLEET_TYPE.SINGLE, false), ship, items: normal.concat(exItem) };
  }

  type Best = { fp: number; gunIds: number[]; radarId: number; sm: ShipMaster; exBoiler: boolean };
  const results: Best[] = [];

  for (const raw of master.ships.filter((s) => s.type === SHIP_TYPE.DD)) {
    const sm = new ShipMaster(raw as never);
    const boilerInEx = EXSLOT_BOILER_IDS.has(sm.id);
    const gunSlots = boilerInEx ? sm.slotCount - 1 : sm.slotCount - 2;
    if (gunSlots < 0) continue;

    const gunSets: number[][] = [];
    if (gunSlots === 0) gunSets.push([]);
    else {
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
    }

    let best: Best = { fp: -1, gunIds: [], radarId: 0, sm, exBoiler: boilerInEx };
    for (const gunIds of gunSets) {
      for (const r of radarCands) {
        const { fp } = build(sm, gunIds, r.data.id, boilerInEx);
        if (fp > best.fp) best = { fp, gunIds, radarId: r.data.id, sm, exBoiler: boilerInEx };
      }
    }
    results.push(best);
  }

  const byOrig = new Map<number, Best>();
  for (const r of results) {
    const orig = r.sm.originalId || r.sm.id;
    const cur = byOrig.get(orig);
    if (!cur || r.fp > cur.fp) byOrig.set(orig, r);
  }
  const uniq = [...byOrig.values()].sort((a, b) => b.fp - a.fp);

  const summary = (r: Best) => {
    const c: Record<string, number> = {};
    for (const id of r.gunIds) { const n = itemMasters.get(id)!.name; c[n] = (c[n] || 0) + 1; }
    const gunStr = Object.entries(c).map(([n, k]) => `${n}×${k}`).join(' + ') || '(主砲なし)';
    return `${gunStr} | 電探:${itemMasters.get(r.radarId)!.name}${r.exBoiler ? ' | [打孔]缶' : ' | 缶'}`;
  };

  console.log('==== 3-2構成(電探+缶) DD昼戦基礎火力 同一艦最強改造 TOP35 ====');
  console.log('  ★ = 缶を補強増設に積み主砲を1本増やせる特例艦(吹雪改三護/天津風改二/島風改)');
  console.log('順位\t火力\t艦娘\tスロ\t構成');
  uniq.slice(0, 35).forEach((r, i) => {
    console.log(`${i + 1}${r.exBoiler ? '★' : ' '}\t${r.fp.toFixed(2)}\t${r.sm.name}\t${r.sm.slotCount}\t${summary(r)}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
