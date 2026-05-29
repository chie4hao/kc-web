/* eslint-disable no-console */
/**
 * DD 昼戦火力ランキング(全スロ主砲版)
 *   - 全スロットに小口径主砲(★MAX)を装備した場合の昼戦砲撃「基礎火力」を算出
 *   - 制空権シミュレータ本体の計算ロジック(Ship/Item/ItemBonus)をそのまま利用
 *   - 装備補正(可視ボーナス) + 改修補正(√★等) を全て込みで評価
 *
 * 実行: npx tsx tests/kcAnalysis/ddFireFull.ts
 *
 * 昼戦基礎火力(通常艦隊/単艦/対通常敵, ship.ts getDayBattleFirePower):
 *   = 素火力(近代化改修満) + 装備火力Σ + 可視装備補正 + 改修隠し補正Σ + 5
 */
import ShipMaster from '../../src/classes/fleet/shipMaster';
import ItemMaster from '../../src/classes/item/itemMaster';
import Item from '../../src/classes/item/item';
import Ship from '../../src/classes/fleet/ship';
import { FLEET_TYPE, SHIP_TYPE } from '../../src/classes/const';
import { loadMaster } from './loadMaster';

const REMODEL = 10; // ★MAX 前提
const MIX_TOP = 18; // 2種混載探索に使う上位主砲候補数

async function main() {
  const master = await loadMaster();

  const itemMasters = new Map<number, ItemMaster>();
  for (const raw of master.items) itemMasters.set(raw.id, new ItemMaster(raw as never));

  // 小口径主砲(apiType1)、深海(敵)装備を除外(id<1500)
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
    // 全スロ同一砲
    for (const g of gunCands) {
      const ids = Array(slots).fill(g.data.id);
      const fp = evalLoadout(sm, ids);
      if (fp > best.fp) best = { fp, ids, sm };
    }
    // 2種混載(組合せ補正拾い)
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

  // 同一艦は最強改造のみ
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

  console.log('==== DD 昼戦基礎火力 (全スロ主砲★MAX / 同一艦最強改造) TOP40 ====');
  console.log('順位\t火力\t艦娘\tスロ\t最適主砲構成');
  uniq.slice(0, 40).forEach((r, i) => {
    console.log(`${i + 1}\t${r.fp.toFixed(2)}\t${r.sm.name}\t${r.sm.slotCount}\t${gunSummary(r.ids)}`);
  });

  console.log('\n==== 火力内訳 TOP20 (素 / 装備 / 可視補正 / 改修補正 / 表示火力 / 基礎火力) ====');
  console.log('艦娘\t素\t装備\t可視\t改修\t表示\t基礎');
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
