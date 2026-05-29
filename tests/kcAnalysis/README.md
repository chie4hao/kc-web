# kcAnalysis — 艦娘火力解析スクリプト

制空権シミュレータ(kc-web)本体の計算ロジック(`Ship` / `Item` / `ItemBonus`)を
そのまま流用して、駆逐艦(DD)の **昼戦砲撃「基礎火力」** をランキングするスクリプト集。

> 「全装備所持」前提で、各艦に最適な小口径主砲を★MAXで装備した場合を総当たり評価する。
> 装備補正(可視ボーナス)・改修補正(√★ 等)・「主砲+水上電探」等の組合せ補正をすべて込みで計算する。

## 昼戦基礎火力の式 (DD / 通常艦隊・単艦・対通常敵)

`src/classes/fleet/ship.ts` の `getDayBattleFirePower` より:

```
基礎火力 = 素火力(近代化改修満) + 装備火力Σ + 可視装備補正 + 改修隠し補正Σ + 5
```

- 改修隠し補正: 小口径主砲 = √★ (★10≈+3.16/門)。一部の砲(C型改三/D型改三系)は 0.3×★ = +3.0/門。
- 昼戦砲撃の攻撃力上限(キャップ)は180だが、ここで出る基礎火力(〜140)はいずれも未到達なので火力差はそのまま反映される。

## スクリプト

| ファイル | 内容 |
|---|---|
| `ddFireFull.ts` | 全スロットに主砲を積んだ場合のDD火力ランキング |
| `ddFire32.ts` | 3-2用。「電探1 + 缶1」を強制装備した制約下のランキング |
| `loadMaster.ts` | 加工済みマスタ(master.json)のロード共通処理 |

### 実行

```bash
# 依存(lodash等)が無ければ
npm install

npx tsx tests/kcAnalysis/ddFireFull.ts
npx tsx tests/kcAnalysis/ddFire32.ts
```

### master.json の取得

`loadMaster.ts` は以下の優先順でマスタを取得する:

1. 環境変数 `KC_MASTER_JSON` で指定したローカルパス
2. ローカルキャッシュ `tests/kcAnalysis/.cache/master.json`
3. 本家と同じ公開URL(Firebase Storage)からダウンロードして上記にキャッシュ

```bash
# 手元の master.json を使う場合
KC_MASTER_JSON=/path/to/master.json npx tsx tests/kcAnalysis/ddFire32.ts
```

> master.json は `public/START2.json`(api_start2 生データ)ではなく、
> シミュレータが各値を算出済みの形式(`ships[].fire` = 近代化改修満の火力 等)。

## ddFire32.ts の特例艦について

3-2 で「電探1 + 缶1」を積むと、4スロ艦は主砲2本・3スロ艦は主砲1本に減る。
ただし **高速+ の素質があり、+7缶(新型高温高圧缶)単体を補強増設(打孔)に積むだけで最速到達できる**
以下3形態は、缶を打孔に逃がして通常スロを1本主砲に回せる(主砲が1本増える):

- 吹雪改三護(六式)  `id 1040`
- 天津風改二        `id 951`
- 島風改            `id 229`

対象艦を増減する場合は `ddFire32.ts` の `EXSLOT_BOILER_IDS` を編集する。

## メモ / 今後の拡張余地

- 装備可否(`api_mst_equip_ship` / 補強増設可否)は未チェック。一部老朽艦は特定電探を積めない場合がある。
- 火力のみの評価。実ダメージ(交戦形態・陣形・敵装甲・キャップ後)までは計算していない。
- 軽巡(CL)・重巡等への横展開、夜戦火力ランキングも同じ枠組みで追加可能。
