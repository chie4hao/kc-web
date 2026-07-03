# kcAnalysis — 驱逐舰(DD)@ 3-2 综合解析与评分

针对 **3-2 刷图(只打 C / L 两战)** 的驱逐舰(DD)分析套件,把四件事串成一条流水线:

1. **火力**: 复用制空权模拟器(kc-web)本体逻辑(`Ship` / `Item` / `ItemBonus`)算 **昼战炮击基础火力**,
   为每舰穷举最优小口径主炮配置(★MAX)。
2. **进攻**: 调用本家 [fleethub-core](https://github.com/MadonoHaru/fleethub)(Rust→wasm)算 **对 3-2 实际敌舰的命中率·期望伤害·一击必沉率**。
3. **生存**: 同样用 fleethub-core 算 **敌方炮击 + 闭幕雷击 → 我方的大破率**。
4. **评分**: 把进攻/生存合成 **综合评分**,给 DD 排行(fleethub 无内置评分,见下「综合评分」)。

> **两套引擎分工**: 配置决策(挑哪些炮/电探、★几)由 **kc-web** 完成(它含自舰 master 与装备补正库);
> 命中/装甲乱数/伤害/大破等**战斗结算一律调 fleethub-core**(不自行实现公式,避免抄写出错)。
> kc-web 的 master **不含敌舰**,敌方数据来自 fleethub 公开数据(见「敌方数据」)。

> 火力部分以「全装备所持」为前提,对各舰装备最优小口径主炮(★MAX)做穷举评估,
> 计入装备补正(可视加成)、改修补正(√★ 等)、「主炮+水上电探」等组合补正。

> **固定前提**(三个 fleethub 脚本通用): Lv170 / 不喂运(用初始运)/ 阵型単縦 / 高速+統一 /
> 交战形态按 同航45·反航30·T有利15·T不利10% 加权(3-2 带不了彩云,发生率固定)。各脚本顶部可改。

## 昼战基础火力公式 (DD / 通常舰队·单舰·对通常敌)

出自 `src/classes/fleet/ship.ts` 的 `getDayBattleFirePower`:

```
基础火力 = 素火力(近代化改修满) + 装备火力Σ + 可视装备补正 + 改修隐藏补正Σ + 5
```

- 改修隐藏补正: 小口径主炮 = √★ (★10≈+3.16/门)。部分炮(C型改三/D型改三系)为 0.3×★ = +3.0/门。

## 脚本

| 文件 | 内容 |
|---|---|
| `ddFireFull.ts` | 全槽都装主炮时的 DD 火力排名 |
| `ddFire32.ts` | 3-2 专用(高速+統一)。每舰算「带电探型/多炮型」两种配置 + Δ + 渦潮权衡表 |
| `loadMaster.ts` | 加工后 master(master.json) 的加载公共逻辑 |
| `loadEnemy.ts` | 敌舰属性·海域编成(数据源自 fleethub)的加载公共逻辑 |
| `ddHitDamage32.ts` | 3-2 C/L 各敌舰的命中率·期望伤害(直接调用 fleethub-core) |
| `ddSurvival32.ts` | 我方 DD 生存评估(敌方炮击+闭幕雷击→我方, fleethub-core) |
| `ddSummary32.ts` | **综合一览 + 评分排行**: 火力+进攻命中/伤害+生存+综合评分 全汇一张表(对齐输出, 可写 UTF-8 文件) |

### 运行

```bash
# 若缺依赖(lodash / fleethub-core 等)
npm install

npx tsx tests/kcAnalysis/ddFireFull.ts
npx tsx tests/kcAnalysis/ddFire32.ts
npx tsx tests/kcAnalysis/ddHitDamage32.ts   # 命中率·期望伤害(需 fleethub-core)
npx tsx tests/kcAnalysis/ddSurvival32.ts    # 生存评估(需 fleethub-core)
npx tsx tests/kcAnalysis/ddSummary32.ts     # 综合一览(火力+命中/伤害+生存, 需 fleethub-core)
npx tsx tests/kcAnalysis/ddSummary32.ts result.txt   # 直接写 UTF-8 文件(勿用 PowerShell 的 `>`, 会乱码)
```

### 命中率·伤害计算(ddHitDamage32.ts)

命中率·装甲乱数·期望伤害的公式 **一律不自己实现,直接调用本家 fleethub-core(wasm)**,
以避免抄写公式出错。

- 依赖: `fleethub-core` / `equipment-bonus` (npm。已 `npm i -D fleethub-core equipment-bonus`)
- node 环境需加载同步 wasm 版,故用 `createRequire` 加载:
  ```ts
  import { createRequire } from 'module';
  const { FhCore } = createRequire(import.meta.url)('fleethub-core'); // package.json 的 main=node 版
  ```
- 调用流程:
  ```
  const core = new FhCore(await loadFhMasterData());   // 直接把 master_data.json 传入
  const analyzer = core.create_analyzer();
  const myShip = core.create_ship({ ship_id, level, g1:{gear_id,stars}, ... , gx:{...} });
  const enemyShip = core.create_comp_by_map_enemy(Uint16Array.from([敌shipId])).main.get_ship('s1');
  const a = analyzer.analyze_ship_attack(config, myShip, enemyShip, /*attacker_is_left*/ true);
  const rep = Object.values(a.day.data)[0];            // 'SingleAttack'
  rep.hit_rate.total          // 命中率
  rep.damage.damage_density    // 含 miss(=0) 的伤害分布 → 加权平均=期望伤害
  ```
- 自军配置复用 `ddFire32.ts` 的 `computeBest32()`。每艘有带电探型(`gunIdsRadar`+`radarId`)与
  多炮型(`gunIdsGun`)两套(改二補等死格另带 `extraIdsRadar/extraIdsGun` 機銃),
  **命中/伤害/汇总脚本对每艘 DD 都同时算 [探]/[炮] 两套对比**。要用实际手持装备评估时,
  替换 `buildShipState()` 里读取的装备 id 即可。
- 当前固定: 等级 Lv170、不喂运、**阵型单縦**、通常单发炮击(SingleAttack)。可改顶部 CONFIG。
- 输出按目标列出 4 交战形态伤害 + **加权**(按发生率 同航45/反航30/T有利15/T不利10% 加权的综合期望伤害)。
  3-2 带不了彩云,故用此发生率固定。

#### 关于交战形态与阵型(已定论)

- **交战形态(T有利/同航/反航/T不利)不影响命中率**(命中项里没有交战形态项),只影响伤害:
  precap 的 engagement_mod(×1.2/1.0/0.8/0.6)。但期望伤害是「攻击力×形态系数 − 装甲乱数」,
  所以实际波动比系数更大(T不利不止降到同航的 6 成,会更低)。
- **阵型固定用单縦**。原因:Lv 高时命中已顶到上限(96),複縦的命中×1.2 失效、只白损火力×0.8;
  其它阵型 power 系数更低,炮击伤害更差;警戒阵是回避特化、牺牲炮击,对 3-2 这种格下敌不需要。
  (此前已用 fleethub 实跑对比验证,结论明确,故脚本不再保留阵型对比。)

### master.json 的取得

`loadMaster.ts` 按以下优先级取得 master:

1. 环境变量 `KC_MASTER_JSON` 指定的本地路径
2. 本地缓存 `tests/kcAnalysis/.cache/master.json`
3. 从与本家相同的公开 URL(Firebase Storage)下载并缓存到上述位置

```bash
# 想用手头的 master.json 时
KC_MASTER_JSON=/path/to/master.json npx tsx tests/kcAnalysis/ddFire32.ts
```

> master.json 不是 `public/START2.json`(api_start2 原始数据),而是
> 模拟器已算好各值的形式(`ships[].fire` = 近代化改修满的火力 等)。

> **游戏更新后刷新数据**: 新船/新装备实装后, 删掉缓存让脚本重新下载即可:
> ```bash
> rm tests/kcAnalysis/.cache/master.json tests/kcAnalysis/.cache/fh_master_data.json tests/kcAnalysis/.cache/fh_map_32.json
> ```
> 代码侧(新船的 ItemBonus 组合补正等)则 `git fetch upstream && git merge upstream/main`。
> fleethub-core / equipment-bonus 为 npm 包, `npm view fleethub-core version` 看有无新版。

### 敌方数据(loadEnemy.ts)的取得与可靠性

kc-web 的 master.json **不含敌舰**(只有自舰)。敌舰属性与海域编成复用
[fleethub](https://github.com/MadonoHaru/fleethub) 公开的 GCS 数据:

- 敌舰/装备属性: `…/data/master_data.json`
- 海域编成·阵形: `…/data/maps/{mapId}.json` (3-2 = 32, brotli 压缩)

> **bucket 迁移(2026-06-25)**: 旧 bucket `kcfleethub.appspot.com` 开始返回 403,
> 新地址为 `https://storage.googleapis.com/kcfleethub`(从 jervis.vercel.app 的应用 bundle 里确认)。
> `loadEnemy.ts` 已切到新地址; 若将来再 403, 用同样方法(抓应用 `_app-*.js` 里的 `storage.googleapis.com` 常量)找新 bucket。

取得方式与 `loadMaster.ts` 相同的三段式(环境变量 → 缓存 → 下载)。
环境变量为 `KC_FH_MASTER_DATA`(master_data 路径)和 `KC_FH_MAP_DIR`(`{mapId}.json` 放置目录)。

```bash
# 验证: 显示 3-2 C/L 点的敌方编成
npx tsx tests/kcAnalysis/loadEnemy.ts
```

> **可靠性提醒**: firepower/torpedo/armor/anti_air/hp 等源自官方 api_start2,可靠度高;但
> **回避(evasion)官方 API 不公开,是社区(KCNav/制空检证部等)的实测推定值**。
> 命中率计算里回避是主要输入,务必记住这一项是推定值。
> 编成数据也出自 TsunDB/KCNav 玩家集计,但常设海域(如 3-2)长期固定,实用上没问题。

#### 数据取得流程(备忘)

```
[1] 敌舰/装备属性  master_data.json
      GCS: https://storage.googleapis.com/kcfleethub.appspot.com/data/master_data.json
      来源: 官方 api_start2 (仅回避为社区推定)
                │
[2] 海域编成      maps/{mapId}.json   ※mapId = 世界*10 + 海域号 (3-2→32, 3-3→33)
      GCS: https://storage.googleapis.com/kcfleethub.appspot.com/data/maps/{mapId}.json
      来源: TsunDB/KCNav (tsunkit.net),经 fleethub 转发。brotli(content-encoding: br) 压缩
                │
[3] loadEnemy.ts 加载两者 → buildShipIndex / buildGearIndex 建索引
                │
[4] getEnemiesAt(map, "A") 取节点的编成 pattern 数组
      → 对各 enemy.main(/escort) 的 ship_id 用 resolveEnemy() 解析为装备计入后的属性
```

要点 / 注意:

- **mapId 规则**: `世界号 * 10 + 海域号`。例: 3-3 = `33`、7-1 = `71`。
- **brotli**: map JSON 在 GCS 上以 br 压缩保存。`curl` 用 `--compressed`;`loadEnemy.ts` 的
  `decodeMaybeBrotli()` 会自动判别明文/br(对 fetch 不自动解压的环境兜底)。
- **敌舰属性是装备计入前**: `firepower`/`armor` 等是素值。`resolveEnemy()` 会加上
  `stock`(初期搭载装备) 的加成得到最终值。装备 master **只有非零项才存在字段**,故 `?? 0` 必须。
- **属性数组 `[a, b]`**: 自舰是 `[初期, 最大]`;敌舰两值相同,用 `[0]` 即可。
- **查任意海域/任意节点的方法**:
  ```bash
  # loadEnemy.ts 自测固定为 3-2 C/L。要看其它节点时,
  # 写个一次性脚本调用 loadFhMap(mapId) / getEnemiesAt(map, point) 即可。
  npx tsx tests/kcAnalysis/loadEnemy.ts        # 显示 3-2 C/L(连通性验证)
  ```

## ddFire32.ts 的路线策略与两种配置

3-2 走 **高速+統一·随机沟**(见下「3-2 路线与渦潮」)。**速度件(达高速+)配置**:

- **特例 4 舰**: 缶塞补强增设(孔)即高速+,**装备位全留给炮/电探**。
- **其余所有舰**: 缶塞孔 **+ 装备位再放 1 个タービン**(缶+タービン协同)才高速+,即**额外占 1 个装备位**。

> 速度件**不影响火力**: 缶(id 87)与タービン(id 33)火力均为 0(占位数已在槽位计算里扣掉)。
> タービン 回避 +6,但 Lv170 高回避区被回避上限吸收、生存几乎不变;**低等级时タービン回避才真正起作用**。

因此 `ddFire32.ts` **对每艘 DD 都算两种 3-2 配置**:

- **带电探型**: 炮 + 电探1 (+非特例タービン) + 缶(孔) —— 用于全队中带电探的若干艘。
- **多炮型**  : 炮(比带电探型多 1 门) (+非特例タービン) + 缶(孔),不带电探 —— 其余舰用,火力更高。
- **Δ = 多炮火力 − 电探火力** = 用电探换 1 门炮的火力代价。组队时把电探发给 **Δ 最小**的舰最划算。

### 特例舰(仅缶孔即高速+)

下列 4 形态**仅靠"缶塞孔"就能高速+**(不需タービン),故装备位全留给炮/电探,
比同槽位的普通舰多 1 门炮:

- 吹雪改三護(六式)  `id 1040`
- 天津風改二        `id 951`
- 島風改            `id 229`
- Ташкент改        `id 395`

要增减对象舰,编辑 `ddFire32.ts` 的 `SPECIAL_IDS`。

### 装备回避(命中/伤害/生存所需)与字段坑

> **重要字段坑**: kc-web master 里装备的真实回避是 **`avoid2`** 字段;`avoid` 其实是"射撃回避id"(分类号)。
> `ItemMaster` 内 `this.avoid = item.avoid2`。取回避务必用 `avoid2`。

3-2 常用装备回避(`avoid2`)/命中(`accuracy`):

| 装备 | 回避 | 命中 |
|---|---|---|
| 新型高温高圧缶 (缶) | +13 | 0 |
| 改良型艦本式タービン | +6 | 0 |
| SG レーダー(初期/後期型) | +6 | +8/+10 |
| 逆探(E27)+22号対水上電探改四(後期) | +5 | +9 |
| SCレーダー改(後期調整型) | +4 | +3 |
| GFCS Mk.37 | +2(装甲+1) | +9 |
| 22号対水上電探改四(後期) | 0 | +9 |
| 主炮(高角砲等) | 0 | 视装备 |

- **电探带回避**(+4~6),故"带电探/多炮"在生存上**有别但差异很小**(Lv170 回避已高、被上限压缩,约 ±1pp 被命中)。
- 部分主炮对特定舰有**回避 fit-bonus**(见 `ItemBonus.ts`),会让"多炮型"的回避被部分补回,故探/炮谁更耐打因舰而异。
- 这些回避(装备 + fit-bonus + 缶/タービン)**fleethub 都已计入"被命中%"**。
- **速度档**: 实测 fleethub 不施加"高速+"额外回避加成(speed 维持基础值、回避项不因缶+タービン而变档)。

## 3-2 路线与渦潮(备忘)

刷 3-2(只打 C、L 两战)的到 boss 路线及条件:

| 路线 | 经过渦潮? | 战斗数 | 条件 |
|---|---|---|---|
| **CEFL** | ❌ 完全绕开 | 2 战 | 最速統一 + 电探4艘 **或** 高速+統一 + 电探5艘 |
| CGFL | ✅ 经过 G 渦潮 | 2 战 | 高速統一 + 电探(少) |
| CGHFL | ✅ 经过 G | 3 战(多打 H) | 同上,从 G 随机岔去 H |

**本项目采用的策略**: 全队 **高速+統一**(每舰带 1 缶,不追最速——缶太多不划算),
**接受随机沟**(C→E 跳过 或 C→G 渦潮, 且 G 可能随机去 H 多打一场)。
不强求绕渦潮的 CEFL(高速+统一要绕渦潮需电探 5 艘)。

### 渦潮(G·燃料)减免表 —— 按「带电探的舰数」计,**无上限**

> 3-2 G うずしお(燃料): 基本喪失割合 35%, 実効ベース 28%, 喪失上限 30 燃料。

| 带电探的舰数 | 减免系数 | 实际喪失率 | 比上一档多省 |
|---|---|---|---|
| 0 | 1.00 | 28%   | — |
| 1 | 0.75 | 21%   | 7.0pp |
| 2 | 0.60 | 16.8% | 4.2pp |
| 3 | 0.50 | 14%   | 2.8pp |
| 4 | 0.45 | 12.6% | 1.4pp |
| 5 | 0.42 | 11.76%| 0.84pp |
| 6 | 0.40 | 11.2% | 0.56pp |

> **注意**: 早期常被误传「3 艘触顶」是**错的**。减免一直到 6 艘都在降,只是边际收益急剧衰减。
> 0→3 把损耗腰斩(28%→14%),3 以后每艘只省不到 1.4pp;且这是对剩余燃料的百分比、还有 30 燃料上限,
> 绝对省油量很小。故 **3 艘是火力/省油甜区**(非物理上限),实战可按对省油的在意程度自行增减。

### 电探发给谁,代价天差地别

电探的火力代价**不均匀**: 发给**特例舰(吹雪改三護/天津風/島風改/Ташкент改)和 4 槽舰**几乎免费
(带不带电探的火力差 Δ 很小),发给 **3 槽纯炮舰最亏**(等于用 1 门主炮换电探)。
所以「**哪几艘带电探**」比「带几艘」更重要 —— `ddFire32.ts` 的「组队权衡」会按 Δ 升序自动分配并打印
电探数 0~6 的「渦潮损耗% / 该队总火力」曲线供取舍。

## 综合评分(ddSummary32.ts)

> **fleethub 没有舰娘综合评分/tier 的 API**(只有 `aviation_detection_score`(索敵机)、
> `ContactRank`(触接)、`remodel_rank`(改修档)等局部概念)。故综合评分是**本项目自定义**。

`ddSummary32.ts` 把进攻、生存合成一个 0~100 的综合分,并按「每舰最佳模式」排行。

### 评分公式(权重在脚本顶部 `W_OFF` / `W_SURV` / `TAIHA_ZERO` 可调)

```
进攻分 = 按「实际敌方出现频率」加权的一击必沉率 × 100
         一击必沉率 = fleethub damage_state_density.Sunk, 按交战形态发生率加权
         权重 = 各敌舰在 C+L 全 pattern 的出现次数(= 随机打一个敌人的期望击沉率)
生存分 = max(0, (1 − 单次C/L被大破率 / TAIHA_ZERO)) × 100
         (被大破率 = 1 − (1−炮大破)(1−雷大破); TAIHA_ZERO=0.30, 即 30%大破=0分)
综合分 = 0.55 × 进攻分 + 0.45 × 生存分
```

- **进攻用「一击必沉率」而非期望伤害**: 3-2 要的是把敌人打沉(沉了才不会闭幕雷反咬、才给经验)。
  该指标已把火力+命中+暴击+装甲乱数+交战形态**一并**算进去。
- **进攻分按实际编成频率加权**, 不是对硬目标等权平均。3-2 C/L 的实际人口里**杂鱼駆逐占大多数**
  (HP22~38、谁都一发秒),所以进攻分普遍偏高、彼此差距被压缩 → 生存的相对影响变大、耐揍舰上位。
  人口在输出里直接打印(駆逐ロ級後期型×7 / 駆逐ロ級×6 / 駆逐ハ級後期型×5 / 雷巡チ級×4 / 輸送ワ×4 / 軽巡各变体…)。
  > 近似: 假设每节点 3 个 pattern 等概率(fleethub 数据未给 pattern 出现率)。
- **生存合并炮击与闭幕雷**: 单次 C/L 里挨「最强炮源 1 发 + 最强雷源 1 发」的综合大破概率。
  炮击威胁极低(≤1.6%),**雷击才是主因**。
- **权重 0.55/0.45**: 进攻略重(打不动 軽巡 的 DD 没意义);但大破撤退会废掉整轮,故生存接近。
  想更保守可调高 `W_SURV`。
- **每舰取最佳模式**: 同舰 [探]/[炮] 各算一次综合分,排行取较高者(进攻权重下多为 [炮];
  少数高回避收益舰为 [探])。

### 主表列(对齐输出, CJK 宽度感知)

`火力 / HP / 避(裸回避) / 命中min%(暴) / 伤@T1..T6(对各硬目标加权期望伤害) / 杀%(平均一击必沉)`
`/ 被炮% / 炮破% / 被雷% / 雷伤 / 雷破% / 综合`。表头给出 T1~T6 的敌名图例。表下附**装备明细**(含★)。

### 输出编码

PowerShell 的 `>` 会按 UTF-16 + 控制台代码页重定向,**中日文必乱码**。脚本支持**自己写 UTF-8**:

```bash
npx tsx tests/kcAnalysis/ddSummary32.ts result.txt   # 直接生成 UTF-8(无 BOM)文件
```

### 局限

- 单发评估(满血受 1 次): 实战道中会被多个敌连续攻击,**累积大破率更高**。
- 仅昼战: 不计夜战补刀(故「一击必沉」未把"打成大破、夜战再杀"算作有效)。
- 评分是**相对排序工具**, 数值刻度(尤其 `TAIHA_ZERO`)为设计取值, 跨海域/等级需重新审视。
- **新船回避待定**: 回避是社区实测推定值, 刚实装的新船(如 5/31 的 涼波改二補 等「補」形态)
  fleethub 数据里 `evasion=[null,null]`, **算不了生存** → 该形态列入 pending 区(只显示进攻预览),
  不污染排名;同一舰若有"回避已知的较弱形态"(如 長波改二)则仍按它进排名。待社区测出回避后重跑即纳入。
  脚本靠 `ship.has_unknown_stat('evasion')` 检测。
- **新船 fleethub 装备補正(fit-bonus)滞后(已知偏差, 待完善)**: 比回避更隐蔽。新改二補(743/744/745)
  回避补上后已进排名(#10/#11),但 fleethub 的 `equipment-bonus` 包对它们的**装备 fit 補正仍不全**。
  实测(探, Lv170)朝霜改二補 fit 火力補正 **+7**, 而朝霜改二 **+12**(**差约 5 火力**; 命中 −5 但已顶上限无影响,
  回避 −2 微, 雷装 −4 昼战无关, 装甲一致)。后果: **改二補在 fleethub 里火力被低估约 5、进攻分偏低,
  甚至低于对应改二** —— 而 **kc-web 的 ItemBonus 已更新(改二補 = 改二 +5 才是游戏真实)**, 两套引擎数据不同步。
  2026-06-25 发布的 equipment-bonus 7.13.26 / fleethub-core 1.12.18 **仍未补**(直接调
  `createEquipmentBonuses` 实测: 同装备下 朝霜改二補 fp+6 vs 朝霜改二 fp+12)。且**涼波改二(1034)同样缺**
  (5/31 实装的 4 个新形态 743/744/745/1034 全没录, ebonus 里按 yomi+ctype 匹配也搜不到)。
  只能等作者补数据后 `npm update equipment-bonus && 删缓存重跑` 自动转正。
  **当前把改二補当作「≈对应改二、实际略强」、涼波改二按同样思路看待即可。**
  > 后续可加自动预警: 对每艘排名舰比对 kc-web 火力 vs fleethub 火力(naked+gear+ebonus), 差距过大就标注「fleethub 補正可能滞后」。

## 备忘 / 后续可扩展

- 装备可否大体未校验(`api_mst_equip_ship`/补强增设),个别舰可能装不了某些电探。但**逐格"死格"已处理**:
  按 `Const.FORBIDDEN_LINK_SHIP_ITEM`,若某槽同时禁 主炮(1)+小型電探(12)+機関部(17)(如**改二補 743/744/745 的第4格**,
  只能機銃),则主炮/电探/タービン不占该格;该格改为**穷举対空機銃(type21)**,其火力与
  **夕雲型機銃補正**(`ItemBonus.ts` 里 `requiresSR` 等大量条目)由引擎计算 →
  改二補比对应改二**高约 5~6 火力**(最优機銃因舰而异: 長波/朝霜選 FlaK M42、涼波選 25mm連装機銃(熟練機銃員分隊))。
  时雨改三/初月改二等第4格只禁主炮/魚雷、仍可放電探/タービン,不算死格,火力不变。
- 组队分电探目前只按火力 Δ; 电探同时加命中(攻)+回避(生存), 更优分配应综合三者(暂未做)。
- 横向扩展到轻巡(CL)/重巡等、以及夜战火力排名,都可套用同一框架。
- 换其它海域: `loadFhMap(其它mapId)` + 改节点字母即可(如 3-3 A 点用 `loadFhMap(33)` + `'A'`)。
