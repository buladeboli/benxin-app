# 本心盘口分析台 · 离线工作台

> **给下一位接手的人（AI 助手或开发者）的交接文档。**
> 这份 README 描述的是**代码当前的真实状态**，不是历史计划。所有默认值都是从
> `js/core.js` 的 `PARAM_DEFS` / `DEFAULT_LIB` 里读出来的。

---

## 〇、访问密码（v15.4 起的前端门禁）

```
bx-7ur9gv9m
```

- 页面第一屏是密码锁（`js/gate.js`），输对才看得到内容；**记 30 天免输**
  （`localStorage['benxin.gate.v1']`）。
- 密码**只存哈希、不存明文**：`SALT='benxin-jc-2026'`，比对
  `SHA-256(SALT + ':' + 密码)`（安全上下文）或 `FNV-1a64(...)`（http 兜底）。换密码方法见
  `..\部署与密码说明.md` 末尾。
- **强度必须说清楚**：这是纯前端门禁，只挡"随手点开链接的人"。懂技术的人可以直接改 JS 绕过；
  里面也没有服务端。之所以够用，是因为**数据只存在各自手机的浏览器里**，别人进来也是空的。
- ⚠️ 本 README **不会**被打进部署包（`部署包\` 里没有 README），所以密码不会跟着上线。

---

## 一、这个项目是什么

**一句话**：一个**纯离线单页网页应用**，把一场足球比赛开盘前的几十个输入（近 6 场战绩、排名、
伤停、盘口水位…）换算成一套完整的研判结论 —— 机构开的是深盘还是浅盘、落在八大场景的哪一个、
仲裁过不过、综合评分多少、以及**到底该买上盘还是下盘**。

**怎么跑**：双击 `index.html` 就行。

| 特性 | 说明 |
|---|---|
| 纯离线 | 无构建步骤、无 CDN、无服务器、无 npm 依赖。所有脚本用 `<script src>` 直接引入 |
| 无框架 | 原生 DOM + 一个 180 行的 `UI` 小工具库（`js/ui.js`） |
| 数据落地 | 全部存在浏览器 `localStorage`，不落盘、不上传 |
| 能读表格 | 自带纯 JS 的 `.xls`（OLE2 + BIFF8）与 `.xlsx`（ZIP + OOXML）读取器，不依赖任何库 |
| 能写表格 | 自带手写 OOXML + ZIP 的 XLSX 生成器，以及带颜色的 HTML `.xls` |
| 联网可选 | 只有一个地方会联网：「AI 回测迭代 → AI 联网分析」和「生成录入 → B 截图识别」，都要你自己填 API Key。不填就完全离线 |

### 能干什么（按页面）

| 你要做的事 | 去哪一页 |
|---|---|
| 看一眼记录库现在什么样（样本量、上盘赢盘率、强信号命中率、缺字段体检） | 数据总览 |
| **批量录**：粘一行或多行（逗号 / 制表符）一次入库多场 | **批量计算 → ① 整行快录** |
| 把一场比赛的原始数据逐项录进去，实时看完整结果 | 批量计算 → ② 单场录入 · 盘 |
| 维护球员名单、把伤停名单自动算成「伤病/深度/停赛」三个文本标签 | 生成录入 |
| 给已录的比赛填比分，让程序自动判上盘赢没赢盘 | 批量计算 → ③ 记录库 · 赛果 |
| 按场景 / 水位 / 仲裁 / 置信度分组看投注盈利与 Wilson 区间 | 统计分析 |
| 从一堆比赛里挑出最合理的 2 场组合 | 投注建议 |
| 改系数、改映射表、看推荐准确率诊断 | 调参中心 |
| 导出 XLSX / CSV / JSON 备份，或把备份导回来 | 导出 / 导入 |
| 跑离线规则引擎扫参数、让 AI 帮你分析、看调参历史 | AI 回测迭代 |

---

## 二、目录结构与文件职责

```
D:\网页\
├── index.html              页面外壳 + 全部样式 + 脚本加载顺序
├── README.md               本文档
├── js\                     全部运行代码
│   ├── core.js             算法内核（~2900 行）
│   ├── ui.js               UI 工具库
│   ├── xlsread.js          .xls / .xlsx 读取器
│   ├── seed.js             12 场出厂示例比赛
│   ├── seed-players.js     球员库出厂数据
│   ├── app.js              应用外壳：导航 + 页面调度
│   ├── mod-players.js      球员库 / 伤停量化 / 转会窗口（工具库，不注册页面）
│   ├── mod-io.js           导入解析器（工具库，不注册页面）
│   ├── mod-dash.js         ① 数据总览
│   ├── mod-entry.js        ② 生成录入
│   ├── mod-batch.js        ③ 批量计算
│   ├── mod-stats.js        ④ 统计分析
│   ├── mod-bet.js          ⑤ 投注建议
│   ├── mod-params.js       ⑥ 调参中心
│   ├── mod-export.js       ⑦ 导出 / 导入
│   ├── mod-ai.js           ⑧ AI 回测迭代
│   └── mod-help.js         ⑨ 使用说明
├── _tools\                 开发期工具与历史脚本（见 §7.5）
├── 12版改动地方.txt          历史需求文档（v12 的改动记录，只作史料）
└── 13版文字叙述.txt          历史需求文档（v13 的改动记录，只作史料）
```

### 2.1 脚本加载顺序（`index.html`，顺序不能改）

```html
<!-- 内核：core 必须最先 -->
core.js → ui.js → xlsread.js → seed.js → seed-players.js → app.js
<!-- 工具库：无页面，但必须在用到它的模块之前 -->
mod-players.js → mod-io.js
<!-- 页面模块：注册顺序 = 左侧导航顺序 -->
mod-dash.js → mod-entry.js → mod-batch.js → mod-stats.js → mod-bet.js
→ mod-params.js → mod-export.js → mod-ai.js → jc-calc.js → mod-jc.js → mod-help.js
```

**为什么顺序重要**：这些脚本都是老式的 IIFE，靠执行时读取 `window.Core` / `window.UI` 等全局。
`mod-dash.js` 顶部就写 `const C = window.Core`，所以 `core.js` 必须先执行完。
`mod-io.js` 必须排在 `mod-export.js` 之前，因为后者在渲染时会调 `window.ImportKit.card(host)`。

### 2.2 每个文件负责什么

#### 内核层

| 文件 | 全局 | 职责 |
|---|---|---|
| `index.html` | — | 外壳 DOM（`#side` 导航 / `#main` / `#pages` / `#toast`）+ 全部 CSS 变量与组件样式 |
| `core.js` | `window.Core` | **算法内核**，纯计算 + 存取。含 `PARAM_DEFS`（98 个参数的元数据）、`DEFAULT_LIB`（全部映射表）、`evaluate()` 主入口、`computeInjury()` 伤停量化、`arbitrate()` 仲裁、`confidence()` 模型置信度、`recommend()` 推荐引擎、`decide()` 三步决策树、全部 `localStorage` 读写 |
| `ui.js` | `window.UI` | **UI 工具库**，无依赖。DOM 构造（`el`）、表格（`table` / `grid`）、表单（`field` / `input` / `number` / `select` / `textarea` / `btn` / `chips`）、容器（`card` / `note` / `bar` / `pill`）、格式化（`fmt` / `pct` / `esc`）、文件（`download` / `pickFile` / `pickFiles`）、CSV 解析（`parseCSV` / `toCSV`） |
| `xlsread.js` | `window.XlsRead` | 纯前端表格读取器。导出 `readFile` / `parseXls` / `parseXlsx` / `parseText` / `oleNames`。自己实现了 OLE2(CFB) 容器解析、BIFF8 记录解析、ZIP + OOXML 解析，**不依赖 xlrd / SheetJS / LibreOffice** |
| `seed.js` | `window.SEED_ROWS` | 12 场出厂示例比赛（含比分），首次打开时植入，让界面不空。用户可随时在批量计算里删掉 |
| `seed-players.js` | `window.SEED_PLAYERS` | 球员库出厂数据（按联赛 → 球队 → 球员列表） |
| `app.js` | `window.App` | **应用外壳**。`App.register(page)` 收集页面定义，`App.go(id)` 走 hash 路由，`App.refresh()` 重渲染当前页，`App.updateFoot()` 刷新左下角状态。启动时依次 `loadParams/loadLib/loadRows/loadSettings/loadHistory/loadIters`，首次运行植入 `SEED_ROWS`，之后每次启动跑 `migrateRows()` 补空值 |

#### 工具库（不注册页面）

| 文件 | 全局 | 职责 |
|---|---|---|
| `mod-players.js` | `window.Players` | 球员库的**数据层 + 两个子页签的渲染**。导出 `setTab` / `getTab` / `state` / `PL` / `savePL` / `reload` / `leagues` / `teamsOf` / `roster` / `playerCount` / `playersOf` / `setPlayers` / `parseGrid` / `leagueFromName` / `doUpload` / `applyImport` / `renderLib` / `renderInj` / `renderWin` / `saveInj` / `calc` / `reportText`。`calc` 就是调 `Core.computeInjury` / `Core.computeMatch` 的入口。`mod-entry.js` 的「球员库 / 伤停量化 / 转会窗口」三个页签全部委托给它渲染 |
| `mod-io.js` | `window.ImportKit` | 导入 / 跨电脑迁移的**解析器**。导出 `card` / `readFile` / `tableToInputs` / `rowsToInputs` / `doImport` / `parseXLSX` / `parseCSVTable` / `parseHTMLTable` / `zipEntries` / `zipRead` / `keyOf` / `analyse` / `state`。`card(host)` 会被 `mod-export.js` 在导出页底部调用，插入「导入 / 换电脑迁移」卡片 |
| `jc-calc.js` | `window.JCCalc` | **竞彩注数/奖金纯计算库**（v15.1 新增）。导出 `STAKE`（2 元）/ `MAX_CHORD`（8）/ `eSym`（初等对称多项式，DP）/ `comb` / `jcStats`（竞彩过关：注数/金额/全中奖金/单注区间）/ `sfcStats`（14 场与任九注数）。**不碰 DOM**，所以能单独跑单元测试（`竞彩计算器\test\calc_test.js`，43 条，含与暴力枚举对拍） |

#### 页面层（注册顺序 = 导航顺序）

| # | 文件 | `id` | 标题 | 图标 | `group` | 页签 | 全局 |
|---|---|---|---|---|---|---|---|
| ① | `mod-dash.js` | `dash` | 数据总览 | `▦` | 总览 | 无 | `window.Dash`（= `window.Effects`，旧名兼容） |
| ② | `mod-entry.js` | `entry` | 生成录入 | `⌸` | 录入 | 球员库 / 伤停量化 / 转会窗口 / B·截图识别 / 使用说明 | `window.Entry` |
| ③ | `mod-batch.js` | `batch` | 批量计算 | `∑` | 计算 | ① 整行快录 / ② 单场录入·盘 / ③ 记录库·赛果 | `window.Batch` |
| ④ | `mod-stats.js` | `stats` | 统计分析 | `▤` | 分析 | ① 单场意图解剖 / ② 场景出现准确率 / ③ 推荐准确率 / ④ 模型置信度 / ⑤ 维度下钻 | `window.Stats` |
| ⑤ | `mod-bet.js` | `bet` | 投注建议 | `◎` | 分析 | 无（单页三步） | `window.Bet` |
| ⑥ | `mod-params.js` | `params` | 调参中心 | `⚙` | 配置 | 参数项 / 映射表 / 推荐准确率 | `window.Params` |
| ⑦ | `mod-export.js` | `export` | 导出 / 导入 | `⤓` | 输出 | 无（导出区 + 导入区） | `window.Export` |
| ⑧ | `mod-ai.js` | `ai` | AI 回测迭代 | `✧` | 回测迭代 | 调参路线图 / 离线规则引擎 / AI 联网分析 / 调参历史 | `window.AIRoad`、`window.AIEngine` |
| ⑩ | `mod-jc.js` | `jc` | 竞彩选票 | `🎯` | 工具 | 无（单页：竞彩表 + 胜负彩表 + 选票汇总） | `window.JCMod` |

> **注意**：页面标题 `数据总览` 等是注册时的 `title`；`group` 决定左侧导航的分组标题
> （实际共 7 组：总览 / 录入 / 计算 / 分析 / 配置 / 输出 / 帮助）。
> 导航顺序 = `App.register()` 的调用顺序 = `index.html` 里的 `<script>` 顺序。

#### 每个页面模块的详细职责

**① `mod-dash.js` — 数据总览**（180 行）
四块内容：KPI 网格（样本场次 / 上盘赢盘率 / 强信号命中率 / 一票否决场次）、
「当前生效的核心系数」8 个快取值 + 跳转按钮、最近 10 场记录表、**记录库体检**表格
（列出缺 `hADGames` / `aADGames` / `league` / `open` 的记录，可就地补数，也有「一键补齐」按钮）。
`window.Effects` 是 `window.Dash` 的别名，仅为兼容旧引用保留。

**② `mod-entry.js` — 生成录入**（559 行）
五个页签。前三个（球员库 / 伤停量化 / 转会窗口）**渲染全部委托给 `window.Players`**。
「B·截图识别」是自己实现的：把截图发给视觉模型（`settings.visionModel || settings.apiModel`），
用内置 prompt 要求输出标准整行文本，再走 `Core.inpFromRowMap` / `coerceField` 解析。
「使用说明」是页内文档。

**③ `mod-batch.js` — 批量计算**（892 行）
三个页签：
- **① 整行快录**：粘一行或多行（半角逗号 / 全角逗号 / **制表符** —— Excel 里选中整行复制就是制表符），
  一次入库多场。核心是 `Core.parseCommaText`（分隔符自动识别 + 逐行校验），页面用
  `Batch.quickFill(text, parse)` 供外部灌数据。这是日常录入的主入口。
- **② 单场录入 · 盘**：左侧分组表单（下拉选加减项文本、数字填近 6 场），右侧 `renderLive()` 实时出
  完整结果卡。支持「从生成录入接收伤停量化结果」（`Batch.acceptFromEntry` / `applyInjury` /
  `applyInjuryBoth`）、「从整行快录送一场过来校对」，以及编辑既有记录时回写（`editRecord`）。
- **③ 记录库 · 赛果**：结算明细表 + 逐场填比分（倒序显示，明细里只显示文字数值），
  填完自动调 `Core.settle` 判上盘输赢。
  **★ v15 加了分页**：明细表和赛果录入区共用一套页码，默认每页 50 条（可切 20 / 100 / 全部），
  翻页时只重画当前页 —— 记录上千条也不会一次把上千行 DOM 画出来。

**④ `mod-stats.js` — 统计分析**（1107 行）
五个页签，全部基于 `Core.groupRates` / `Core.sideRates` / `Core.confidence` / `Core.recommendStats`：
① 单场意图解剖（机构的意图结论 / 证据链 / 近邻对照 / 反向压力测试）
② 场景出现准确率（只统计标准八大场景）
③ 推荐准确率（按 A / B1 / B2 / B3 / none 五种推荐情形拆分 + 滚动趋势）
④ 模型置信度（指标名跟着 `ITERATION` 版本号走，含校准表 + 逐场分解 + 迭代日志）
⑤ 维度下钻（`Stats.DIMS` 共 10 个维度，按 ROI 排序 + 滚动趋势）

**⑤ `mod-bet.js` — 投注建议**（592 行）
三步：勾选比赛 → 选推荐逻辑 → 枚举所有两两组合。`Bet.LOGICS` 只有 **2 条**（v13 从 9 条收敛来的）：
`intent`（只吃八大场景，按场景历史方向命中率的 Wilson 下界排序）和
`fundamental`（吃盘口不变 + 中水四场景，方向由基本面 X2 决定）。
组合层还会叠加分散加分。底部有「历史回看」表。

**⑥ `mod-params.js` — 调参中心**（994 行）
三个页签。「参数项」把 `Core.PARAM_DEFS` 按 `d.g` 分组渲染成可编辑表格；
「映射表」编辑 `Core.DEFAULT_LIB` 的各张表；「推荐准确率」是调参诊断台
（按推荐情形看命中率 + 六个方向的自动诊断 + 调参优先顺序）。
支持参数快照（`window.__pendingParams`）与历史（`benxin.history.v1`）。

**⑦ `mod-export.js` — 导出 / 导入**（522 行）
四个导出按钮：XLSX（3 个 sheet：明细 / 统计 / 分组分析）、CSV（带 UTF-8 BOM）、
带颜色的 HTML `.xls`、整站 JSON 备份（含参数与映射表）。
导出范围可选「完整明细（88 列）」或「精简表（25 列）」。
页面底部直接 `if (window.ImportKit) window.ImportKit.card(host)` 把导入区插进来。

**⑧ `mod-ai.js` — AI 回测迭代**（973 行）
- 四个页签：调参路线图（`AIRoad.ROADMAP` / `PRIORITY` / `diagState`，按「从源头到末端」六个方向讲）、
  离线规则引擎、AI 联网分析、调参历史。
- `window.AIEngine` 是离线引擎：导出 `TUNABLE`（可扫的参数键列表）/ `objective` / `sweep` /
  `coordinateDescent` / `grid2` / `loo` / `buildPrompt`。
- 联网部分只在填了 `settings.apiBase` + `settings.apiKey` 时可用，否则直接提示「请先填写 Base URL 与 API Key」。

**⑨ `mod-help.js` — 使用说明**（1044 行）
页内文档：快速上手 / 算法文档 / 参数总表 / 常见问题。
其中「算法文档」和「参数总表」是**动态读 `Core.PARAM_DEFS` 当前值**渲染的，
所以调参之后这里的数字会跟着变。

> ⚠️ `mod-help.js` 里仍残留若干历史文案（比如算法文档的标题写成「与表格版本一致」、
> 参数总表的表头写成「当前生效值 vs 原值」）。这些是**历史遗留文案，不影响算法**，
> 需要清理的时候直接改 `mod-help.js` 的字符串即可。

**⑩ `mod-jc.js` — 竞彩选票**（v15.1 新增，约 1100 行）
把「今天开售的竞彩 + 胜负彩 14 场」拉回来，勾选组成模拟选票并算钱。**与盘口算法完全独立**——
不读 `Core.store`，不改任何参数，只是同一个页面里多了一个工具页。

| 项 | 说明 |
|---|---|
| 数据来源 | 本机后端 `竞彩计算器\server.py`（Python 标准库，抓 500彩票网） |
| 后端地址 | 自动探测：页面是 http 时先试**同源**，再试 `127.0.0.1:8765~8771`；地址记在 `benxin.jc.v2.apiBase` |
| 全局 | `window.JCMod`（`state` / `calcJc` / `calcSfc` / `loadDemo` / `candidateBases` / `ticketText` / `demoData`） |
| 存储 | `localStorage['benxin.jc.v2']`（选择状态 + 后端地址），**不动** `benxin.params/lib/rows` |
| 样式 | 首次渲染时向 `<head>` 注入一段 `<style>`，所有选择器收在 `#page-jc` 下，不污染其它页面 |
| 没有后端时 | 顶部渲染**诊断卡**（分「file:// 打开」和「服务没起」两种话术）+「再试一次 / 载入示例 / 导入 JSON」三个自救按钮；**绝不会白屏** |
| 竞彩规则 | **同一场只能选一个结果**（跟真实竞彩一致），点赔率自动勾选该场；串关 1~8 关 |
| 胜负彩规则 | 每场可多选（双选/三选=复式）；`14 场` 与 `任九` 两种玩法；任九注数用 `eSym(ks, 9)` |
| 附加玩法 | 点「其他玩法」展开**比分 / 总进球 / 半全场**（500 的 `playid=312` 页里就有全部赔率），选中后也能进串关 |

> **为什么要单独一个后端？** 浏览器直接抓 500 会被跨域策略挡死（对方不给你 CORS 头）。
> 所以抓取必须在本地进程里做。这个后端同时把 `网页` 目录当静态站服务，
> 于是「页面 + 接口」同源，不存在跨域问题。
> 详细用法见 `竞彩计算器\使用说明.md`，它就是**唯一**的说明书。

### 2.3 模块之间怎么调用

```
                       ┌──────────────────────────────┐
                       │  core.js  window.Core        │  ← 算法 + 存取，谁都能调
                       │  PARAM_DEFS / DEFAULT_LIB    │
                       │  evaluate / confidence / ... │
                       └───────────────┬──────────────┘
                                       │
        ┌──────────────────────────────┼───────────────────────────────┐
        │                              │                               │
 ┌──────┴──────┐               ┌───────┴────────┐              ┌───────┴────────┐
 │ ui.js       │               │ app.js         │              │ xlsread.js     │
 │ window.UI   │               │ window.App     │              │ window.XlsRead │
 └──────┬──────┘               └───────┬────────┘              └───────┬────────┘
        │                              │  register()                   │
        │                              ▼                               │
        │                    ┌──────────────────┐                      │
        │                    │ 9 个页面模块      │                      │
        │                    │ mod-*.js         │                      │
        │                    └───┬──────┬───────┘                      │
        │                        │      │                              │
        │        ┌───────────────┘      └──────────────┐               │
        ▼        ▼                                     ▼               ▼
  ┌─────────────────────┐                    ┌─────────────────────────────┐
  │ mod-players.js      │                    │ mod-io.js                   │
  │ window.Players      │                    │ window.ImportKit            │
  │ 被 mod-entry.js 调用 │                    │ 被 mod-export.js 调用        │
  │ → Core.computeInjury│                    │ → XlsRead.readFile          │
  └─────────────────────┘                    │ → Core.inpFromRowMap        │
                                             └─────────────────────────────┘
```

几条实际存在的跨模块调用（照抄代码）：

| 调用方 | 被调方 | 位置 |
|---|---|---|
| `mod-entry.js` | `window.Players.setTab` / `renderLib` / `renderInj` / `renderWin` | 页签渲染 |
| `mod-export.js` | `window.ImportKit.card(host)` | 导入区 |
| `mod-io.js` | `window.XlsRead.readFile` | 解析 `.xls` / `.xlsx` |
| `mod-bet.js` | `Core.decide` / `Core.recommend` / `Core.confidence` / `Core.sceneSide` | `scoreOne()` |
| `mod-params.js` | `Core.resolveUpper` | 上盘判定口径预览表 |
| `mod-params.js` | `window.__pendingParams` | 参数快照 / 回滚 |
| `mod-ai.js` | `Core.evaluate` / `Core.confidence` / `Core.recommendStats` | 目标函数 |
| `mod-dash.js` | `Core.auditRows` / `Core.migrateRows` / `Core.sideOf` | 体检 + 最近记录 |

---

## 三、数据流总览

从「一场比赛的输入字段」一路到「推荐方向 + 综合评分」：

```
┌─ 输入：一场比赛 ────────────────────────────────────────────────────────────┐
│ 联赛 / 轮次 / 主客队名                                                     │
│ 近 6 场（每场：进球 hG{i} / 失球 hC{i} / 对手排名 hO{i}），i = 6…1（6 最早）│
│ 主场战绩：hGames / hPts    客场战绩：aGames / aPts    是否空场：empty       │
│ 排名：hRank / aRank（区间 hTier / aTier 可空自动推）                        │
│ 加减项文本 ×7 ×2 队：历史交锋 / 伤病 / 停赛 / 疲劳 / 阵容深度 / 连赢连负 / 战意│
│ 盘口：open(初盘) / close(终盘) / openWater / closeWater / openTime / closeTime│
│ 可选：hADGames / aADGames（近 6 场实际场次）                                │
│ 赛果（后填）：scoreText「2:1」；actual 可空、由 settle() 自动判              │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
                         Core.evaluate(inp, P, LIB)
                                   │
   ┌───────────────────────────────┼────────────────────────────────────────────┐
   ▼                               ▼                                            ▼
① attackDefense('h'/'a')      ② formScore            ③ rankScore         ④ adjustScore
   攻防积分 H.score/A.score       主战绩系数偏差 F.diff   排名净分差 R.diff     加减净分差 ADJ.net
   → adDiff = H.score − A.score                                              + ADJ.hTotal / aTotal
   └───────────────┬───────────────┴───────────────────────┴────────────────────┘
                   ▼
        E  = F.diff + H.score + R.diff + ADJ.hTotal        （主队总分）
        Ft = A.score + 0        + ADJ.aTotal               （客队总分，客队不含历史交锋）
        G  = E − Ft                                        （净分差）
                   ▼
        I = 本心实力盘 = MIN(FLOOR(|G| / HCP_STEP) × HCP_UNIT, HCP_CAP) × (G>0 ? −1 : +1)
                   ▼
   ┌───────────────┬───────────────────┬────────────────────┬───────────────────┐
   ▼               ▼                   ▼                    ▼                   ▼
 盘口符号      水位档 O          变动幅度 Pp          深开/浅开 Q         上盘判定 resolveUpper
 J=inputLine(open) waterLevel()   moveLevel()      depthLabel(I,J)     J≠0 → K≠0 → 水位
 K=inputLine(close)                                                          │
 Nv = K − J                                                                  ▼
 hcpMove(J,K) 用 |K| vs |J| 判升/降盘                              upSide ∈ {主队,客队,平手}
                   ▼
            八大场景 sceneOf(Q, J, K, O) → r.scene
   ┌───────────────┴───────────────────────────────────────────────┐
   ▼                                                               ▼
仲裁 arbitrate(J, 四票)                                    四维评分
 L = adDiff + F.diff + R.diff（长期）                        Z 偏差评分  = f(|J − I|)
 S = ADJ.net（短期）                                          AA 联动评分 = f(升降盘 × 水位同/反向)
 sgnUp = J<0 ? +1 : J>0 ? −1 : 0                              AB 仲裁评分 = 仲裁分支对应分
 e1 = sgn(L)×sgnUp    e2 = sgn(S)×sgnUp                       AC 时间评分 = f(终盘时间 − 初盘时间)
   → resonance / minorSplit / longDivergence                          │
     / majorReversal / totalDivergence / thin                         ▼
                                                total = Z + AA + AB + AC
                                                strength = total ≥ STRONG_SCORE ? 强
                                                         : total ≥ MED_SCORE    ? 中 : 弱
                                                                      │
   ┌──────────────────────────────────────────────────────────────────┘
   ▼
中水二次判定 midVerdict(r)（只对 4 个中水场景）
推荐方向 recommend(r, agg) / sideOf(r, LIB)
   → dir ∈ {up, down, none} → 「买 X（上盘/下盘）」
   ▼
赛果判定 settle(upSide, J, goalDiff) → 赢盘 / 输盘 / 走水     （填了比分才有）
   ▼
派生：模型置信度 confidence(r, agg, P) → 0~100 + 五档
      三步决策树 decide(r, agg)      → 重点关注 / 谨慎参考 / 忽略 / 放弃 …
```

### 3.1 输入字段清单（以 `Core.INPUT_FIELDS` 为准）

`INPUT_FIELDS` 共 **81 项**，顺序即「整行逗号文本」的顺序，也是导入导出的顺序。

| 段 | 数量 | 字段 |
|---|---|---|
| 概要 | 18 | `seq` 序号(可空) · `league` 联赛 **必填** · `round` 轮次 · `home` 主队名称 · `away` 客队名称 · `phCorePan` 本心实力盘(占位，填「无」) · `open` 机构初盘 **必填** · `close` 机构终盘 · `openWater` 初盘水位 **必填** · `closeWater` 终盘水位 · `phTag` 深开/浅开(占位) · `phScene` 八大场景(占位) · `phArb` 冲突仲裁(占位) · `phTotal` 综合评分(占位) · `phStrength` 信号强度(占位) · `scoreText` 最终比分 · `actual` 上盘是否赢盘(算出的) · `note` 备注 |
| 近 6 场 | 36 | `hG6..hG1` / `hC6..hC1` / `hO6..hO1`，客队同理 `aG6..aG1` / `aC6..aC1` / `aO6..aO1`。**数字越大越早，第 1 场是最新一场** |
| 战绩与排名 | 9 | `hGames` 主队主场场次 · `hPts` 主队主场总得分 · `aGames` 主队**客场**场次 · `aPts` 主队**客场**总得分 · `empty` 是否空场(TRUE/FALSE) · `hRank` 主队当前排名 · `aRank` 客队当前排名 · `hTier` 主队排名区间(可空) · `aTier` 客队排名区间(可空) |
| 加减项文本 | 14 | 主队 `hHist` / `hInjury` / `hSuspend` / `hFatigue` / `hDepth` / `hStreak` / `hMotive`，客队 `aHist` / `aInjury` / `aSuspend` / `aFatigue` / `aDepth` / `aStreak` / `aMotive` |
| 时间 | 2 | `openTime` 初盘时间 · `closeTime` 终盘时间 |
| 可选 | 3 | `hADGames` 主队近 6 场实际场次 · `aADGames` 客队近 6 场实际场次 · `upSideManual` **手动指定上盘方**（v15；不在 81 列整行顺序里） |

> **`hGames` / `aGames` 的命名坑**：`aGames` / `aPts` 存的是**主队的客场数据**，
> 不是客队的。因为主战绩系数 `K = 主场场均得分 ÷ 客场场均得分` 要拿同一支球队的两个口径比。
> 客队自身的主客战绩不参与计算（`Ft = A.score + 0 + ADJ.aTotal`，中间那个 0 就是这个位置）。

**三类字段的特殊标记**（`core.js` 里的常量）：

| 常量 | 值 | 含义 |
|---|---|---|
| `NUMERIC_INPUT` | `round` `hRank` `aRank` `hGames` `hPts` `aGames` `aPts` `openWater` `closeWater` `hADGames` `aADGames` `seq` | 导入时按数字强转，转不动就报「不是数字」 |
| `PLACEHOLDER_INPUT` | `phCorePan` `phTag` `phScene` `phArb` `phTotal` `phStrength` | 引擎算出来的列。导入时**一律忽略**，由引擎重算；导出整行时写「无」 |
| `BLANK_WORDS` | `无` `空` `-` `—` `/` `N/A` `NA` `null` `undefined` `待定` `未` | 视同空值，导入时跳过 |

### 3.2 盘口符号约定（全站统一，最容易搞错的地方）

| 值 | 含义 |
|---|---|
| **负数** | **主队让球**（主队是上盘方）。`主让半球` → `−0.5` |
| **正数** | **客队让球**（客队是上盘方） |
| `0` | 平手盘 |

**★ v15 修了一个会算错结论的 bug**：`plateValue()`（中文盘口 → 数值）原来写的是
「`主让` → **正数**」，跟全站约定正好相反。结果只要盘口是**中文文本**进来的
（整行快录 / Excel 导入 / 截图识别 / 手打「主让半球」），**上盘方和赛果判定全部反转**；
而填数字（`-0.5`）是一直对的，所以这个 bug 极难自己发现。

现在统一成：

```
中文 → 数值：  主让半球 → −0.5     客让半球 → +0.5     主队受让平半 → +0.25     平手 → 0
数值 → 中文：  Core.lineTextOfBall(−0.5) → '主让半球'（单位：球，与引擎同符号）
认不出来：    返回 null（让调用方报错，不再猜）
```

> ⚠️ **单位别再混**：`Core.plateText(v)` 的入参是「**分**」（净分差，内部会再折算成球），
> `Core.lineTextOfBall(v)` 的入参是「**球**」。伤停量化算出来的 `ball` 是球，必须用后者，
> 否则显示会**放大一倍**（0.25 球显示成「半球」）—— 这也是 v15 修掉的 bug。

`Core.inputLine()` 是唯一入口：纯数字字符串走 `parseFloat`，中文走 `plateValue()`。
录入界面现在**以数字为准**（② 单场录入里给了快捷点选按钮，点一下自动填 `-0.5` 这种值）。

### 3.3 记录与输出的列定义

| 常量 | 列数 | 内容 |
|---|---|---|
| `RECORD_HEADERS` | 18 | 比赛概要：序号 / 联赛 / 轮次 / 主客队名 / 本心实力盘 / 机构初盘 / 机构终盘 / 初盘水位 / 终盘水位 / 深开浅开标签 / 八大场景匹配 / 冲突仲裁结论 / 综合评分 / 信号强度标签 / 最终比分 / 上盘是否赢盘 / 备注 |
| `MATCH_HEADERS` | 61 | 每场输入明细 36 + `hGames`/`hPts`/`aGames`/`aPts` 4 + 是否空场 1 + 当前排名 2 + 排名区间 2 + 加减文本 14 + 初盘时间/终盘时间 2 |
| `VERDICT_HEADERS` | 1 | 中水二次判定 |
| `STAT_HEADERS` | 5 | 统计分类 / 统计项 / 场次 / 投注盈利场次 / 投注盈利概率 |
| `EXTRA_HEADERS` | 3 | 主队近6场实际场次 / 客队近6场实际场次 / **手动指定上盘方**（v15 新增，留空 = 自动判定） |
| **`ALL_HEADERS`** | **88** | 上表全部拼接 = 完整明细导出，可无损回导 |
| `SUMMARY_HEADERS` | 25 | 精简导出（给人看）：序号 / 联赛 / 轮次 / 主客队名 / 机构初盘 / 机构终盘 / 初盘水位 / 终盘水位 / 上盘方 / 本心实力盘 / 深开浅开标签 / 八大场景匹配 / 推荐方向 / 仲裁结论 / 中水二次判定 / 综合评分 / 信号强度标签 / 最终比分 / 上盘是否赢盘 / 偏差评分 / 联动评分 / 仲裁评分 / 时间评分 / 备注 |

一条记录的结构：`{ seq, inp: {...}, note, seed? }`，由 `Core.newRecord(inp)` 生成。

---

## 四、算法规格

> **本节所有「默认值」都从 `PARAM_DEFS` 的 `d` 字段读出**（当前值可在调参中心实时改）。
> 全部 98 个参数的完整表格见 **§6.3**。

### 4.1 攻防积分（`Core.attackDefense`）

作用于主客队各一次。

| 步骤 | 公式 |
|---|---|
| 取 6 场 | `g[i]` = `hG6..hG1`（`i=0` 对应第 6 场，即最早一场），`c[i]` = `hC*`，`o[i]` = `hO*` |
| 大胜折算 | 若 `(g[i] − c[i]) ≥ AD_BIGWIN_DIFF`(3)，则该场进球与失球**都**乘 `AD_BIGWIN_FACTOR`(0.8) |
| 总进/失球 | `tg = Σ adjG`，`tc = Σ adjC` |
| 实际场次 | `games = hADGames`；**为空时**回退成「近 6 场里非空槽位的数量」 |
| 场均 | `avgG = tg / games`，`avgC = tc / games`（games=0 时都为 0） |
| **D 值** | `D = avgG − avgC` |
| 对手平均排名 | `avgO = mean(o[i] 中非空且非 0 的值)`；没有则 0 |
| 对手强度系数 `oppMul` | `avgO = 0` 或 `N = 0` → `1`；`avgO ≤ N × STRONG_OPP_RATIO`(1/3) → `STRONG_OPP_MUL`(1.1)；`avgO ≥ N × WEAK_OPP_RATIO`(2/3) → `WEAK_OPP_MUL`(0.85)；否则 `1` |
| 场次削弱系数 `weaken` | `games ? MIN(1, games / SAMPLE_FULL_GAMES) : 0`，默认满场次 6 |
| 联赛系数 `coef` | `LIB.leagues[联赛].coef`（未知联赛回退 `{N:20, coef:1, R:38}`） |
| 限幅 | `med = MEDIAN(−AD_CAP, D × oppMul × AD_DFW, +AD_CAP)`，默认 `AD_CAP = 0.8`、`AD_DFW = 0.35` |
| **最终得分** | `score = ROUND(med × coef × weaken, AD_BIGWIN_ROUND)`，默认保留 8 位 |

默认联赛表（`LIB.leagues`，调参中心可增删改）：

| 联赛 | N（球队总数） | coef（联赛系数） | R（总轮次） | cap |
|---|---|---|---|---|
| 英超 | 20 | 1.00 | 38 | 1.2 |
| 西甲 | 20 | 1.00 | 38 | 1.2 |
| 德甲 | 18 | 1.05 | 34 | 1.2 |
| 意甲 | 20 | 0.85 | 38 | 1.2 |
| 法甲 | 18 | 0.90 | 38 | 1.2 |
| 英冠 | 24 | 0.75 | 46 | 1.2 |
| 葡超 | 18 | 0.90 | 34 | 1.2 |

### 4.2 主战绩系数偏差（`Core.formScore`）

| 步骤 | 公式 | 默认 |
|---|---|---|
| PPG | `ppgH = hPts / hGames`，`ppgA = aPts / aGames` | — |
| 主客比 | `K = ppgA ? ppgH / ppgA : 0` | — |
| 基础系数 | `base = FORM_A + K × FORM_B` | a = 0.65，b = 0.2 |
| 限幅 | `lim = MEDIAN(FORM_LO, base, FORM_HI)` | 0.7 ~ 1.3 |
| 样本平滑 | `dh < FORM_SMOOTH` 时 `sm = 1 + (lim − 1) × dh / FORM_SMOOTH`，否则 `sm = lim` | 阈值 5 场 |
| 赛季末修正 | `rem = 联赛R − round`；`isLate = round > 0 且 rem < FORM_LATE_ROUNDS`；`lt = isLate ? 1 + (sm − 1) × FORM_CONVERGE : sm` | 轮数 5，收敛因子 0.6 |
| 空场 | `empty` 为真 → `fin = FORM_EMPTY`，**直接替换**前面的结果 | 0.5 |
| **偏差** | `diff = ROUND(fin × FORM_STEP, 6)` | 步长 0.125 |

> `isLate` 同时是**战意项是否生效**的开关（见 §4.4）。

### 4.3 排名分差（`Core.rankScore`）

```
排名区间：  排名 > RANK_TIER_MAX(18)          → 下游
            排名 ≤ RANK_TIER_LO(6)            → 上游
            排名 ≤ RANK_TIER_HI(12)           → 中游
            其余                              → 下游
            排名 = 0（没填）                   → 中游

区间衰减 dec ← LIB.decay[主队区间][客队区间]

rankRaw = ((aRank − hRank) / (N − 1)) × RANK_W(0.6) × dec
diff    = MEDIAN(RANK_LO(−0.5), rankRaw, RANK_HI(+0.5))
```

`LIB.decay` 区间衰减表（6 组）：

| 主队区间 \ 客队区间 | 上游 | 中游 | 下游 |
|---|---|---|---|
| 上游 | 1.00 | 0.90 | 0.80 |
| 中游 | — | 0.85 | 0.70 |
| 下游 | — | — | 0.50 |

> 表里只有 6 行。查不到的组合（如「中游 vs 上游」）→ `dec = 1`。
> 「上游 vs 中游」和「中游 vs 上游」是两条独立记录，不要假设对称。

### 4.4 加减分项（`Core.adjustScore`）

**主队总贡献**（历史交锋项只在主队这一侧计入）：

```
hInjRaw = LIB.injury[hInjury] × LIB.depth[hDepth]
hInj    = MEDIAN(−ADJ_CAP, hInjRaw, 0)
hTotal  = LIB.hist[hHist] + MIN(hInj, LIB.suspend[hSuspend])
          + LIB.fatigue[hFatigue] + LIB.streak[hStreak] + hMotive
```

**客队总贡献**（**不含历史交锋**）：

```
aInjRaw = LIB.injury[aInjury] × LIB.depth[aDepth]
aInj    = MEDIAN(−ADJ_CAP, aInjRaw, 0)
aTotal  = MIN(aInj, LIB.suspend[aSuspend])
          + LIB.fatigue[aFatigue] + LIB.streak[aStreak] + aMotive
```

**战意项**：

```
hMotive = isLate ? LIB.motive[hMotive]                            : 0
aMotive = isLate ? LIB.motive[aMotive] × ADJ_MOTIV_AWAY(0.5)      : 0
```

**净分差**：`ADJ.net = hTotal − aTotal`，`ADJ.abs = |net|`。
`ADJ_CAP` 默认 0.6，`ADJ_MOTIV_AWAY` 默认 0.5。

### 4.5 各加减库映射表（`LIB.*` 默认值）

**历史交锋（`hist`，只有主队用）**

| 选项 | 分值 |
|---|---|
| 近3次对战3胜 | +0.25 |
| 近3次对战2胜1平 | +0.15 |
| 近3次对战2胜1负 / 近3次对战1胜2平 | +0.05 |
| 近3次对战1胜1平1负 / 近3次对战3平 | 0 |
| 近3次对战1胜2负 / 近3次对战2平1负 | −0.05 |
| 近3次对战1平2负 | −0.15 |
| 近3次对战3负 | −0.25 |

**伤病（`injury`）** — 会先乘阵容深度倍数，再 `MEDIAN(−0.6, 乘积, 0)`

| 选项 | 分值 |
|---|---|
| 阵容齐整或无影响缺阵 | 0 |
| 单名普通主力缺阵 | −0.10 |
| 单名绝对核心缺阵 | −0.25 |
| 双核或攻防双主力缺阵 | −0.40 |
| 三核缺阵或半套主力 | −0.50 |
| 大面积伤病潮 | −0.60 |

**停赛（`suspend`）** — 与伤病取 `MIN`，不相加

| 选项 | 分值 |
|---|---|
| 无停赛 | 0 |
| 首发主力红牌停赛 | −0.10 |
| 轮换球员红牌停赛 | −0.05 |

**赛程疲劳（`fatigue`）**

| 选项 | 分值 |
|---|---|
| 间隔4-5天 | 0 |
| 一周双赛(≤3天) | −0.125 |
| 休息充足(≥6天) | +0.05 |
| 连续2个客场 | −0.10 |
| 连续3个客场 | −0.15 |
| 下场有欧战，本场可能轮换 | −0.15 |

**连赢连负（`streak`）**

| 选项 | 分值 |
|---|---|
| 其他情况 | 0 |
| 连续3场胜利 | +0.10 |
| 连续3场失利 | −0.10 |

**阵容深度倍数（`depth`）** — 乘在伤病分上

| 选项 | 倍数 | 效果 |
|---|---|---|
| 深度雄厚 | 0.7 | 削弱扣分 |
| 深度一般 | 1.0 | 不变 |
| 深度薄弱 | 1.4 | 放大扣分 |

**战意（`motive`，只在赛季末生效）**

| 选项 | 分值 |
|---|---|
| 争冠/保级生死战 | +0.15 |
| 争分 / 德比/死敌 | +0.12 |
| 普通 | 0 |
| 摆烂 | −0.12 |

### 4.6 本心实力盘（四分量之和 → 盘口折算）

```
E  = F.diff + H.score + R.diff + ADJ.hTotal        （主队总分）
Ft = A.score + 0        + ADJ.aTotal               （客队总分）
G  = E − Ft                                        （净分差）

I = 本心实力盘数值
  = MIN( FLOOR(|G| / HCP_STEP) × HCP_UNIT , HCP_CAP ) × (G > 0 ? −1 : +1)
```

默认 `HCP_STEP = 0.125`（每档 0.125 分）、`HCP_UNIT = 0.25`（1 档 = 0.25 球）、`HCP_CAP = 3`（封顶 3 球）。

**注意符号**：`G > 0`（主队强）算出来的盘口是**负数**，因为负数才表示「主队让球」。
这与 §3.2 的符号约定一致。

**盘口文字**（`Core.plateText(v)`）：`FLOOR(|v| / HCP_STEP)` 档 → `MIN(档 × HCP_UNIT, HCP_CAP)` 球 →
查 `LIB.plate` 得中文名 → 前缀 `主让` / `客让`；`|v| < 1e-9` 或档数为 0 → 「平手」。

`LIB.plate` 盘口对照表（12 档）：

| 数值 | 名称 | 数值 | 名称 |
|---|---|---|---|
| 0.25 | 平半 | 1.75 | 一球半/二球 |
| 0.5 | 半球 | 2 | 二球 |
| 0.75 | 半一 | 2.25 | 二球/二球半 |
| 1 | 一球 | 2.5 | 二球半 |
| 1.25 | 一球/一球半 | 2.75 | 二球半/三球 |
| 1.5 | 一球半 | 3 | 三球 |

**临界心盘** `r.crit`：`|G − ROUND(G / HCP_STEP) × HCP_STEP| < 0.001` 时为真
（心盘正好压在盘口分界线上），会让模型置信度整体乘 `CONF_CRIT_MUL`(0.9)。

### 4.7 深开 / 浅开（`Core.depthLabel(I, J)`）

```
IF I = 0:
     J = 0 或 null → 平手
     否则           → 深开        ← 心盘平手但机构开出盘口
ELSE:
     I × (J − I) > 0 → 深开
     I × (J − I) < 0 → 浅开
     相等             → 平手
```

### 4.8 八大场景（`Core.sceneOf`）

维度：**深开/浅开** × **水档** × **升/降盘**。

- 水档：高水 | 超高水 → 「高」；低水 | 超低水 → 「低」；中水 → 「中」
- 升降盘：`Core.hcpMove(J, K)` 用 **`|K|` vs `|J|`**（**不是**有符号差 `K − J`，否则跨 0 时判反）

| 条件 | 场景名 |
|---|---|
| 深开 + 高水 + 升盘 | 场景1：深开高水升盘阻上 |
| 深开 + 高水 + 降盘 | 场景2：深开高水降盘阻上 |
| 深开 + 低水 + 升盘 | 场景3：深开低水升盘强支 |
| 深开 + 低水 + 降盘 | 场景4：深开低水降盘诱上 |
| 浅开 + 高水 + 升盘 | 场景5：浅开高水升盘诱上 |
| 浅开 + 高水 + 降盘 | 场景6：浅开高水降盘看衰 |
| 浅开 + 低水 + 升盘 | 场景7：浅开低水升盘补防 |
| 浅开 + 低水 + 降盘 | 场景8：浅开低水降盘诱下 |
| 深开 + **中水** + 升盘 | 中水·深升·待验证 |
| 深开 + **中水** + 降盘 | 中水·深降·诱上嫌疑 |
| 浅开 + **中水** + 升盘 | 中水·浅升·诱上嫌疑 |
| 浅开 + **中水** + 降盘 | 中水·浅降·看衰/保护 |
| 盘口不变 + 高水 | 盘口不变·高水 |
| 盘口不变 + 低水 | 盘口不变·低水 |
| 盘口不变 + 中水 | 盘口不变·中水 |
| 其余 | 平手或错误 |

**水档分界**（`Core.waterLevel(l)`，按**初盘水位** `openWater`）：

| 水位 l | 档位 |
|---|---|
| l ≤ `W_ULTRA_LOW` = 0.8 | 超低水 |
| l ≤ `W_LOW` = 0.9 | 低水 |
| l ≤ `W_MID` = 0.99 | 中水 |
| l ≤ `W_HIGH` = 1.09 | 高水 |
| 其余 | 超高水 |

**变动幅度**（`Core.moveLevel(|Nv|)`，`Nv = K − J` 有符号）：

| \|Nv\| | 档位 |
|---|---|
| ≤ `MOVE_SMALL` = 0.25 | 微调 |
| ≤ `MOVE_MID` = 0.5 | 中幅 |
| ≥ `MOVE_BIG` = 0.75 | 大幅 |
| 其余 | — |

**场景的方向指向**（`LIB.sceneDir`，调参中心可改）：`up` = 跟上盘，`down` = 反买下盘，`none` = 无指向，`cond` = 看中水二次判定。

| 场景 | 方向 | 理由 |
|---|---|---|
| 场景1 / 场景2 | `up` | 「阻上」= 机构怕上盘 → 跟上盘 |
| 场景3 | `up` | 「强支」= 明确支持上盘 |
| 场景4 / 场景5 | `down` | 「诱上」= 引诱买上盘 → 上盘是陷阱 |
| 场景6 | `down` | 「看衰」= 看衰上盘 |
| 场景7 | `up` | 「补防」= 给上盘补防守 |
| 场景8 | `up` | 「诱下」= 引诱买下盘 → 反着买上盘 |
| 中水·深升·待验证 | `cond` | X ≥ 3 → 上盘 |
| 中水·深降·诱上嫌疑 | `cond` | X ≤ 2 → 下盘 |
| 中水·浅升·诱上嫌疑 | `cond` | X ≤ 2 → 下盘 |
| 中水·浅降·看衰/保护 | `cond` | X ≥ 3 → 下盘 |
| 盘口不变·高水 / 低水 / 中水 | `none` | — |
| 平手或错误 | `none` | — |

场景关键词兜底（`LIB.sceneKw`，`sceneDir` 缺项时用）：
`阻上`→up、`强支`→up、`补防`→up、`诱下`→up、`诱上`→down、`看衰`→down。

### 4.9 四票与一致数量 X

```
dirAD   = sgn(adDiff)     攻防净分差方向
dirForm = sgn(F.diff)     主战绩偏差方向
dirRank = sgn(R.diff)     排名净分差方向
dirAdj  = sgn(ADJ.net)    加减净分差方向

X = consensus = [dirAD, dirForm, dirRank, dirAdj] 里 > 0 的个数    取值 0 ~ 4
```

`Core.fundamentalDir(r)` 把 X 三分类（注意**四票全是「主队 − 客队」视角**）：

| X | 结论 |
|---|---|
| X ≥ 3 | 支持主队 |
| X = 2 | 有平局 |
| X ≤ 1 | 支撑客队 |

> **X 是主队视角，不是上盘视角**。客队让球时 X 大反而说明「客队是热门但基本面偏主队」。
> 判断「基本面支不支持上盘」必须用 `Core.supportUpper(r)`，它内部会按 `r.upSide` 翻转。

### 4.10 仲裁（v14 新口径：以机构让球方为基准的方向对称检验）

**为什么要重做**：四票（攻防 / 主战绩 / 排名 / 加减）全是「主队 − 客队」的方向语义，
而下注方向是「上盘 / 下盘」。两者只在「主队 = 上盘」时重合，**客让盘时整个仲裁语义是反的**。
新口径改用上盘方为基准做对称检验。

**定义**：

```
L  = adDiff + F.diff + R.diff      长期固有实力
S  = ADJ.net                       短期突发（伤停 / 停赛 / 疲劳 / 战意）
mag = |S|

sgnUp = J < 0 ? +1 : (J > 0 ? −1 : 0)      +1 = 机构让球方是主队
upSide = sgnUp > 0 ? 主队 : sgnUp < 0 ? 客队 : 平手

e1 = (sgn(L) = 0 或 sgnUp = 0) ? 0 : sgn(L) × sgnUp     +1 = 长期实力支持机构让球方
e2 = (sgn(S) = 0 或 sgnUp = 0) ? 0 : sgn(S) × sgnUp     +1 = 短期突发支持机构让球方

vetoAbs = VETO_ABS = 0.3
```

**六个分支**（`Core.arbitrate`，按这个顺序判，第一个命中就停）：

| 优先 | 条件 | `arbKey` | 结论文字 | 得分参数 | 默认分 | `pass` | 状态 |
|---|---|---|---|---|---|---|---|
| 1 | `sgnUp = 0` | `thin` | 方向证据不足 | `ARB_THIN` | 1 | true | `thin` |
| 2 | `e1 > 0 且 e2 > 0` | `resonance` | 三方一致：机构·长期·短期同向 | `ARB_OK` | 2 | true | `valid` |
| 3 | `e1 > 0 且 e2 < 0 且 mag ≥ vetoAbs` | `majorReversal` | 短期反向：突发信息与机构让球冲突 | `ARB_REV` | 0.5 | **false** | `invalid` |
| 4 | `e1 > 0 且 e2 < 0` | `minorSplit` | 长期一致，短期小分歧 | `ARB_MINOR` | 1.5 | true | `valid` |
| 5 | `e1 < 0 且 e2 > 0` | `longDivergence` | 长期背离：机构开反了长期实力 | `ARB_DIV` | 1 | true | `caution` |
| 6 | `e1 < 0 且 e2 < 0` | `totalDivergence` | 一票否决：机构与模型全面背离 | `ARB_TOTAL` | 0 | **false** | `veto` |
| 7 | 其余（`sgn(L) = 0` 或 `sgn(S) = 0` 导致 e1/e2 都是 0） | `thin` | 方向证据不足 | `ARB_THIN` | 1 | true | `thin` |

分支的 `tone` / `pass` / `status` 集中在 `ARB_BRANCH` 常量里：

| `arbKey` | tone | pass | status |
|---|---|---|---|
| `resonance` | `ok` | true | `valid` |
| `minorSplit` | `ok` | true | `valid` |
| `longDivergence` | `warn` | true | `caution` |
| `majorReversal` | `bad` | false | `invalid` |
| `totalDivergence` | `veto` | false | `veto` |
| `thin` | `mute` | true | `thin` |

**v14.1 顺手修的一个真 bug**：分支 4（`minorSplit`）现在**会被分支 3 挡住**。
如果先判 `e1 > 0 且 e2 < 0` 再看阈值，阈值就永远不起作用。

**旧口径怎么切回**（`LIB.arbMode`）：

| 值 | 效果 |
|---|---|
| `'v2'`（**默认**） | 用上面这套新口径 |
| `'legacy'` | 用 `Core.arbitrateLegacy`：纯主队视角。`dirAdj ≠ 1 且 |ADJ.net| ≥ VETO_ABS` → 「强背离：诱盘（一票否决）」得 `ARB_VETO`(0.5)；否则若四票中「正」的个数 ≥ `CONSENSUS_MIN`(2) → 「信号有效」得 `ARB_OK`(2)；否则「信号无效：诱盘风险」得 `ARB_BAD`(0) |

切回旧口径只影响 `r.arb` / `r.arbScore`（`r.arbKey` 会变成 `ok` / `veto` / `bad`），
`r.arbNew` 永远保留新口径结果供对照。**改 `arbMode` 会连带改变模型置信度与三步决策树**，
因为 `confidence(②方向证据)` 和 `decide(第 2 步)` 读的都是当前口径。

**语义化判定函数**（v14 起 `r.arb` 的字符串取值跟着口径走，**不要再比字符串**）：

| 函数 | 为真条件 |
|---|---|
| `Core.arbIsVeto(r)` | `r.arbKey === 'totalDivergence'` 或 `r.arb === '强背离：诱盘（一票否决）'` |
| `Core.arbIsBad(r)` | `r.arbKey === 'majorReversal'` 或 `r.arb === '信号无效：诱盘风险'` |
| `Core.arbIsOk(r)` | `r.arbKey === 'resonance'` 或 `r.arb === '信号有效'` |
| `Core.arbIsCaution(r)` | `r.arbKey === 'longDivergence'` |

### 4.11 四个评分 → 综合评分 → 强度

| 代号 | 名称 | 公式 | 默认分档 |
|---|---|---|---|
| `Z` | **偏差评分** | `dev = |J − I|`（初盘 vs 心盘，`J` 为空按 0）。`dev ≤ DEV_T1` → 1；`dev ≤ DEV_T2` → 2；`dev ≥ DEV_T3` → 3；其余 → 2 | `DEV_T1`=0.25、`DEV_T2`=0.5、`DEV_T3`=0.75 |
| `AA` | **联动评分** | 升盘且终盘水位 < 初盘水位 → `LINK_HI`；降盘且终盘水位 > 初盘水位 → `LINK_HI`；升盘且水位升 → `LINK_LO`；降盘且水位降 → `LINK_LO`；其余 → `LINK_MID` | `LINK_HI`=3、`LINK_LO`=0、`LINK_MID`=1 |
| `AB` | **仲裁评分** | `= 当前仲裁分支的得分`（`arbInfo.score`） | 见 §4.10 表 |
| `AC` | **时间评分** | 初/终盘时间任一为空 → `TIME_DEF`；否则按小时差 `d`：`d ≥ 24` → `TIME_T4`；`d ≥ 6` → `TIME_T3`；`d ≥ 3` → `TIME_T2`；否则 `TIME_T1` | `TIME_DEF`=1、`T4`=2、`T3`=1.5、`T2`=1、`T1`=0.5 |

```
total    = ROUND(Z + AA + AB + AC, 4)
strength = total ≥ STRONG_SCORE(7) ? 强
         : total ≥ MED_SCORE(4)    ? 中
         :                            弱
```

**升降盘判定用的是 `|K|` vs `|J|`，水位比较用的是原值**（`Mw < Lw` / `Mw > Lw`）。
升盘 + 低水 = 机构在「阻上」，联动分给满；升盘 + 高水 = 造热诱多，联动分给 0。

### 4.12 上盘判定三步（`Core.resolveUpper(J, K, Lw, Mw, P, LIB)`，v14.1）

```
① 初盘 J ≠ 0            → J < 0 主队上盘；J > 0 客队上盘         from = 'J'
② J = 0 但终盘 K ≠ 0     → K < 0 主队上盘；K > 0 客队上盘         from = 'K'
③ J = K = 0（平手盘）    → 靠水位判，见下                        from = 'water' / 'default'
```

第 ③ 步的平手盘口径由 `LIB.flatWaterMode` 决定：

| 口径 | 含义 |
|---|---|
| `'columns'`（**默认**） | 平手盘时「初盘水位」记**主队**、「终盘水位」记**客队**，直接比这两个数，低者上盘 |
| `'home'` | 两栏都是**主队**水位（初盘 / 终盘两个时点）。先看是不是两时点都是中水 → 不推荐；否则用非中水的那个（优先初盘）判，另一侧用 `WATER_SUM − 该水位` 推 |
| `'alwaysHome'` | 平手盘一律以**主队**为上盘，不看水位 |

判不出上盘时的兜底由 `LIB.flatWaterDefault` 决定：

| 值 | 行为 |
|---|---|
| `'home'`（**默认**） | **默认主队为上盘**，`from = 'default'`，并注明「按默认设定：主队为上盘」 |
| `'none'` | `upSide = '平手'`，不推荐方向 |

平手盘判出上盘后要不要给方向，由 `LIB.flatWaterDir` 决定：

| 值 | 行为 |
|---|---|
| `'up'`（**默认**） | 跟上盘（`sideOf` 里 `flatFrom = true`，理由会说明「让球为 0 时机构只能用水位表达强弱」） |
| `'ignore'` | 只标上盘方，不给方向 |

两侧水位都落在中水档 → `upSide = '平手'`，`from = 'water'`，不推荐方向。

#### 4.12.1 ★ v15 新增：手动指定机构让球方（`inp.upSideManual`）

上面三步都是**推**出来的，推的依据分别是「盘口符号」和「水位记法」——而水位怎么记是**你的习惯**，
程序猜不准（平手盘尤其明显）。所以 v15 加了一个人工定音的开关：

| 值 | 行为 | `from` |
|---|---|---|
| `''`（默认） | 走上面的自动三步 | `J` / `K` / `water` / `default` |
| `'主队'` | **强制**主队为上盘 | `manual` |
| `'客队'` | **强制**客队为上盘 | `manual` |
| `'平手'` | 不设上盘，赛果按走水 | `manual` |

- 手动值**优先级最高**，会覆盖自动判定；
- 如果手动值与盘口符号推出来的不一致（比如盘口 −0.5 = 主让，你却点了客队），
  会往 `r.warn` 里写一条冲突提示 —— 这基本意味着**盘口正负号填反了**；
- 它不在 81 列标准整行里（不影响 `INPUT_FIELDS` 的顺序），但会作为**导出第 88 列**
  「手动指定上盘方」进 XLSX/CSV，`H2F` 也认它，所以可以无损回导。

### 4.13 推荐方向（`Core.recommend` + `Core.sideOf`）

**方向来源有两层**，`sideOf()` 是第一层（场景名指向），`recommend()` 是第二层（含盘口不变与中水补位）：

```
sceneSide(r.scene, LIB)
  → dir = LIB.sceneDir[场景键]（缺项时按 LIB.sceneKw 关键词兜底）
  → dir = 'cond' 时调 midVerdict(r) 拿方向
  → dir = 'none' 且 upFrom ∈ {water, default} 且 flatWaterDir ≠ 'ignore'
       → dir = 'up'（平手盘跟上盘）

team = dir = 'up'  ? upSide
     : dir = 'down'? (upSide = 主队 ? 客队 : 主队)
     :               —
```

`Core.recommend(r, agg)` 分成 **5 种情形**（`REC_CASES`）：

| `caseKey` | 名称 | 命中条件 | 方向 | 排序分 |
|---|---|---|---|---|
| `A` | 机构意图（8 大场景） | `scene` 以「场景」开头 | `sceneDir` 给的（`down` 才反着来，否则一律 `up`） | `(g.dn ? g.lo × 100 : 30) + total × 0.6 + (arbIsOk ? 8 : 0) − (arbIsVeto ? 40 : 0)` |
| `B3` | 中水四场景（基本面补位） | `isMidScene` | `supportUpper(r)` ? `up` : `down` | `50 + total × 0.8 + (二次判定方向一致 ? 15 : 0) − (arbIsVeto ? 30 : 0)` |
| `B2` | 盘口不变·中水（反向判定） | `scene === '盘口不变·中水'` | `supportUpper(r, wide=true)` ? `down` : `up` | `45 + total × 0.5` |
| `B1` | 盘口不变·高/低水（看基本面） | `scene === '盘口不变·高水' \| '盘口不变·低水'` | `supportUpper(r)` ? `up` : `down` | `55 + total × 0.8 + (X = 2 ? −10 : 0) − (arbIsVeto ? 35 : 0)` |
| `none` | 不参与 | 其余（「平手或错误」） | `none` | `0` |

置信标注：`A` 情形 `g.dn ≥ 5 且 g.lo > BREAKEVEN` → 高；否则 `arbIsOk` → 中，否则 低。
`B1` 情形 `arbIsOk 且 strength = 强` → 高。`B3` 情形二次判定与基本面同向 → 高。
`BREAKEVEN = 0.5128`（水位 0.95 时的理论保本胜率）。

**`Core.supportUpper(r, wide)` / `supportLower(r, wide)`**：把主队视角的 X 换算成上盘视角。

```
X = 2 时：wide ? 都算支持 : 都不算
否则：上盘是主队 → X ≥ 3 支持上盘；上盘是客队 → X ≤ 1 支持上盘
```

**中水二次判定 `Core.midVerdict(r)`**（只对 4 个中水场景生效，其他返回 `'—'`）：

> **★ v15 重定基准：一律以「基本面四项占优方向」为准。**
> 旧逻辑用场景名（深升 / 深降 / 浅升 / 浅降）去**反转或否决**方向，于是会出现
> 「二次判定说 ⚠️ 警惕（下盘）、推荐引擎说买上盘」这种自相矛盾的输出。
> 现在方向只有**一个来源** —— 四票（攻防 / 主战绩 / 排名 / 加减）占优的那一边；
> 场景名只作为**风险提示文字**保留，不再反转方向。

```
非中水场景               → '—'（tone mute，无方向）
arbIsVeto                → 有重大利空，基本面{ak}，❌ 放弃：不投上盘，也不建议反向下盘（bad，无方向）
devScore ≤ 1             → 偏差太小（初盘≈心盘，机构等于没表态），基本面{ak}，⚠️ 放弃（warn，无方向）
其余（基准 = 基本面四项）：
    supportUpper(r) 为真  → 买上盘   （dir = 'up'）
    否则                  → 买下盘   （dir = 'down'）
    X = 2（四票 2:2 打平） → 同「否则」= 下盘，但标 mute + 文字注明「弱信号」
    文字尾部附带场景风险提示：深升「机构态度待验证」/ 深降·浅升「诱上嫌疑」/ 浅降「可能是给上盘补防」
```

**这三条是硬约束，改代码时必须守住**：

1. `evaluate()` 调用 `midVerdict()` 时**必须把 `upSide` / `J` 一起传进去**。
   旧版本传了个残缺对象，导致 `homeIsUpper()` 回退成 `undefined < 0 = false`，
   **主队让球的中水场次全部按"客队上盘"算**，表格那列和推荐方向自相矛盾（v15 修）。
2. `midVerdict(r).dir` 必须与 `recommend(r).dir` 一致（自检里有 300+ 场抽样交叉验证）。
3. 想调整中水的判断口径，改 `supportUpper()` 这一处，**不要**再在场景名里加方向特例。

> **历史遗留（已消除）**：v13 及以前 `core.js` 里曾有两个同名 `midVerdict`（626 行 / 1947 行），
> 靠函数声明提升只生效后者。**v15 起全文只有一份**，不存在改错哪一份的问题。

**`Core.flatAdvice(r)`**（盘口不变方向建议，v13）：

```
非盘口不变场景     → '—'
盘口不变·中水      → '— 中水待定'
X = 2              → '— 有平局'（dir = down）
上盘是主队：X ≥ 3 → '✅ 看好上盘（主队）'（up）；否则 '❌ 看衰上盘（主队）'（down）
上盘是客队：X ≤ 1 → '✅ 看好上盘（客队）'（up）；否则 '❌ 看衰上盘（客队）'（down）
```

### 4.14 赛果自动判定（`Core.settle`）

```
settle(upSide, J, goalDiff)
  upSide = '平手' → 走水
  hcp = |J|
  v = upSide = '主队' ? goalDiff − hcp
                      : −goalDiff − hcp
  v > 0 → 赢盘    v < 0 → 输盘    v = 0 → 走水
```

**符号约定（v14.1 修正的关键点）**：`J < 0` = 主队让球 = 主队上盘。
所以「主队上盘赢盘」的条件是 `goalDiff > |J|`，**不是** `goalDiff > −|J|`。
旧写法用「受让」逻辑（`+hcp`），在让球盘上会把输盘判成赢盘。

**只有填了 `scoreText` 才会自动判**：`evaluate()` 用正则 `/(-?\d+)\s*:\s*(-?\d+)/` 抽出比分
（`: `和全角 `：` 都支持），算出 `goalDiff = 主队进球 − 客队进球`。
如果 `inp.actual` 已经有值，就**不覆盖**（手动填的优先）。

### 4.15 伤停量化五步算法（`Core.computeInjury` / `Core.computeMatch`）

**输入**：`players` = 全队 `[{num, name, pos, val}]`（`val` 单位万欧元，可空），
`ctx` = `{injured:[...], suspended:[...], starters:[...], subs:[...], subsMode, newSign:[...], subW?}`。

**第 ① 步 · 有效阵容池 ValidPool**

```
1. 全队身价升序，取第 FLOOR(人数 × EDGE_PCT) 个作为分位切点 pctCut
2. 边缘候选 = 号码 > EDGE_NUM(40) 且 身价 ≤ pctCut（两个条件必须同时成立）
3. 从池里剔掉边缘候选
4. 保护 1：剔完若人数 < POOL_MIN(18) → 按身价从低到高把边缘候选放回，直到达标
5. 保护 2：池内门将数 ≤ GK_KEEP(2) → 被剔掉的门将强制放回
```

`valSum = Σ 池内身价`，`avgVal = valSum / 池内人数`。

**第 ② 步 · W_i / PosFac / S_i**

`W`（出场优先级权重，`PARAM_DEFS` 的「伤停量化」组）：

| 情形 | 权重参数 | 默认 |
|---|---|---|
| 上一场首发 | `W_START` | 1.00 |
| 替补且有上场 | `W_SUB_PLAYED` | 0.45 |
| 进大名单但没上场 | `W_BENCH` | 0.15 |
| 没进大名单 | `W_OUT` | 0.02 |
| 新援（本队没有上一轮记录） | `W_NEW` | 0.60 |

**优先级**：显式标注 > 新援 > 上一场首发 > 上一场替补 > 没进大名单。
`②替补名单` 里逐个标 `(是)` → 0.45，标 `(否)` 或未标注 → 走 `subsMode`
（`'played'` → 0.45；否则 → 0.15）。

`PosFac` 位置伤害修正系数（`LIB.posFac`）：

| 位置类别 | 系数 | 说明 |
|---|---|---|
| GK 门将 | 1.20 | 替补门将水平断崖 |
| CB 中后卫 | 1.10 | |
| FB 边后卫 | 1.00 | |
| DM 后腰 | 1.08 | ★ 规则没列，取值介于 CB 与 CM 之间 |
| CM 中前卫 | 1.05 | |
| AM 前腰 | 1.02 | ★ 规则没列 |
| WM 边前卫/边锋 | 0.95 | |
| ST 中锋 | 0.95 | |

位置命名 → 类别（`LIB.posClass`）：守门员→GK；中卫/后卫→CB；左后卫/右后卫→FB；后腰→DM；
中前卫/中场→CM；前腰→AM；左边锋/右边锋/左中场/右中场→WM；中锋/前锋/影锋→ST。
查不到时按关键词兜底（`门将|守门`→GK，`后卫|中卫|边卫`→CB，`后腰|防守中场`→DM，
`中场|前卫`→CM，`前腰|组织`→AM，`锋|前锋|边锋`→ST，其余→CM）。

```
每人损失 li = W_i × S_i × PosFac_i
  其中 S_i = eff_i / valSum，eff_i = 身价（缺失或 ≤ 0 时用 avgVal 兜底）
Loss_Est = Σ li
sumDamaged = Σ (W_i × eff_i × PosFac_i)
```

**第 ③ 步 · Loss_Est → 伤病文本标签**

| Loss_Est | 标签 |
|---|---|
| 没人在伤病名单 | 阵容齐整或无影响缺阵 |
| < `LOSS_T1` = 0.04 | 阵容齐整或无影响缺阵 |
| < `LOSS_T2` = 0.10 | 单名普通主力缺阵 |
| < `LOSS_T3` = 0.18 | 单名绝对核心缺阵 |
| < `LOSS_T4` = 0.27 | 双核或攻防双主力缺阵 |
| < `LOSS_T5` = 0.35 | 三核缺阵或半套主力 |
| ≥ `LOSS_T5` | 大面积伤病潮 |

**第 ④ 步 · 阵容深度文本标签**

规则原文的 `ResidualRatio = (ValidSumVal − Σ(W×Val×PosFac)) / ValidSumVal`
≡ `1 − Loss_Est` —— **和伤病等级是同一个数的两种分档**，两个乘数同向叠加等于对「缺人」惩罚两次
（违反规则自己写的「禁止重复惩罚」原则）。

修正口径（`LIB.depthMode = 'squad'`，**默认**）：

```
池内身价降序，前 DEPTH_XI(11) 人当首发，其余当替补
avgStarter = 前 11 人平均身价
avgBench   = 其余人平均身价
DepthRatio = avgBench / avgStarter（"替补能顶几成首发"）
   ≥ DEPTH_HI(0.28) → 深度雄厚（×0.7）
   ≥ DEPTH_LO(0.19) → 深度一般（×1.0）
   低于            → 深度薄弱（×1.4）
```

原口径（`LIB.depthMode = 'residual'`）：用 `residual` 本身，阈值 `DEPTH_RES_HI = 0.88` / `DEPTH_RES_LO = 0.75`。
切到这个口径时程序会打印一条警告，提醒你存在重复惩罚。

**两条附加规则**：

```
DEPTH_FORCE = 1（默认）且本场无伤病 → 强制输出「深度一般」，避免凭空拿 0.7 红利
主力门将在伤病名单 → 深度等级降一档（已是「深度薄弱」则不变）
   主力门将优先取「上一场首发的门将」，没有首发信息才退回身价最高的门将
```

**第 ⑤ 步 · 停赛文本标签**

```
停赛名单里有人 W = W_START（首发级别） → 首发主力红牌停赛
否则有非空停赛名单                     → 轮换球员红牌停赛
都没有                                 → 无停赛
名单非空但有号码没匹配上花名册          → 保守按「轮换球员红牌停赛」
```

**落到主表的分值**：

```
injScore = LIB.injury[injuryLabel]
depMul   = LIB.depth[depthLabel]
susScore = LIB.suspend[suspendLabel]
injFinal = MEDIAN(−0.6, injScore × depMul, 0)        ← 封顶硬编码 −0.6，与 ADJ_CAP 同值
finalContribution = MIN(injFinal, susScore)          ← 伤病与停赛取 MIN，不相加
```

**伤病 + 停赛同时出现** → 停赛优先，从伤病里剔除并打备注（「一个人不可能同时伤病+停赛」）。

**`Core.computeMatch(homeRoster, awayRoster, ctx)`**（两队一起算）：

```
net      = 主队 finalContribution − 客队 finalContribution
steps    = FLOOR(|net| / HCP_STEP)
ball     = MIN(steps × HCP_UNIT, HCP_CAP)            每 0.125 分 = 0.25 球，封顶 3 球
ballText = |net| < HCP_STEP ? '平手' : plateText(±ball)
```

**`(是) / (否) / (停) / (新)` 标注语法**（`Core.parseRosterList`）

支持在号码（或姓名）后面跟一对括号标注，中英文括号都行，「号码 空格 (是)」这种中间带空格也能识别，
也可以用 `9-是` / `9:是` 这种写法；多个标注可以用 `/` `,` `，` `、` `+` `＋` `|` 组合。

| 标注词 | 正则（`MARK_*`） | 含义 |
|---|---|---|
| `(是)` | `是\|有\|有上\|上场\|上了\|上过\|出\|出场\|首发\|y\|yes\|true\|1` | 上一场**有**上场（`played = true`） |
| `(否)` | `否\|没\|没有\|没上\|未\|未上\|未出场\|板凳\|替补席\|坐板凳\|n\|no\|false\|0` | 上一场**没**上场（`played = false`） |
| `(停)` | `停\|停赛\|红牌\|红牌停赛\|禁赛` | 本场是**停赛**（自动并进停赛名单，并从伤病里剔除） |
| `(新)` | `新\|新援\|转会\|新签` | **新援** |
| `(伤)` | `伤\|伤病\|伤停\|受伤` | 伤病（默认，不改变 `played`） |

写法示例：`9`、`9(是)`、`9（有）`、`9(否)`、`9(停)`、`9(新)`、`9(是/停)`、`9(否,伤)`、`凯恩(是)`。
分隔符支持 `空白` `,` `，` `、` `;` `；` `|` `/`。

认不出来的标注不会静默丢弃：`computeInjury` 会往 `notes` 里写一条
「这些标注没看懂，已按「未标注」处理：`#9(xxx)`」。

### 4.16 模型置信度四分量（`Core.confidence`）

指标名跟着迭代版本号走：`Core.confName(P)` → `'模型置信度 v' + P.ITERATION`（默认 `v12`）。

```
kind = scene   ← 场景名以「场景」开头
     | mid     ← 4 个中水场景
     | flat    ← 盘口不变·高水 / 低水 / 中水
     | none    ← 其余（平手或错误）
```

| 分量 | 权重参数 | 默认 | 算法 |
|---|---|---|---|
| ① 场景证据 | `CONF_W_SCENE` | 45 | 取该场景键在 `agg.side.byScene` 里的历史（按方向买）。先做**小样本收缩** → 收缩后的 Wilson 下界 `lo`；再映射到 `f = clamp01((lo − CONF_LO_FLOOR) / (CONF_LO_CEIL − CONF_LO_FLOOR))`；`p1 = f × 45` |
| ② 方向证据 | `CONF_W_DIR` | 25 | 看「长期实力 L + 短期突发 S」是否支持**要买的那一边**：都支持 → 1.0；短期小分歧 → 0.8；短期明显反向（`|S| ≥ VETO_ABS`）→ 0.2；全面背离 → 0.05；长期背离但短期支持 → 0.5；没方向 → 0.5。再乘 `dirMul`（一票否决 → 0；短期反向 → 0.6；其余 → 1）。`p2 = dirSupport × 25 × dirMul` |
| ③ 场景清晰度 | `CONF_W_CLARITY` | 15 | `W3 × kindMul × devMul`。`kindMul`：scene 1 / mid 0.6 / flat 0.33 / none 0。`devMul`：偏差评分 3 → 1；2 → 0.85；否则 0.6 |
| ④ 盘口结构 | `CONF_W_STRUCT` | 15 | `W4 × (linkPart + timePart + movePart) / 0.99`。`linkPart`：联动 ≥3 → 0.4；≥1 → 0.27；否则 0.07。`timePart`：时间 ≥2 → 0.33；≥1.5 → 0.27；≥1 → 0.17；否则 0.07。`movePart`：大幅 0.27；中幅 0.2；否则 0.1 |

**小样本收缩**（`Core.shrunkLo`）：

```
W = w + CONF_PRIOR_N × CONF_PRIOR_P
N = dn + CONF_PRIOR_N
lo = wilson(W, N).lo
```

默认 `CONF_PRIOR_N = 4`、`CONF_PRIOR_P = 0.5`。避免「1 胜 0 负」直接给出 100% 置信。

**封顶与折扣**：

| 条件 | 封顶参数 | 默认 |
|---|---|---|
| 一票否决（`arbIsVeto`） | `CONF_CAP_VETO` | 25 |
| `kind = none`（平手或错误） | `CONF_CAP_NEUTRAL` | 30 |
| `kind = mid` 且二次判定没给方向 | `CONF_CAP_MIDWATER` | 55 |

心盘临界（`r.crit`）→ 整体乘 `CONF_CRIT_MUL` = 0.9。最后 `clamp(0, 100)` 并保留 1 位小数。

**分档**（`CONF_T1`~`CONF_T4` = 80 / 65 / 50 / 35）：

| 分数 | 档位 | 建议 |
|---|---|---|
| ≥ 80 | 高置信 | 证据完整，可正常出手 |
| ≥ 65 | 中高 | 可以出手，但建议控制仓位 |
| ≥ 50 | 中等 | 小注或观望，等临场信息 |
| ≥ 35 | 偏弱 | 建议观望 |
| < 35 | 低置信 | 放弃 |

`Core.confCalibration(recs)` 把记录库按上面五档分段，算每档的**实际**投注盈利概率与 ROI ——
这是检验置信度有没有「说到做到」的唯一办法（统计分析 → ④ 标签页就是它）。

### 4.17 三步决策树（`Core.decide`）

```
第 1 步 · 看场景
   ├─ 平手或错误             → 不参与（直接给结论，不走第 2 步）★ 第 1 步优先
   ├─ 场景 1~8               → 进入第 2 步
   ├─ 中水四场景             → 进入第 2 步（标注方向要等二次判定）
   └─ 盘口不变·高/低/中水     → 进入第 2 步（标注方向参考价值低于标准 8 场景）

第 2 步 · 看仲裁结论
   ├─ totalDivergence 一票否决   → 放弃（诱盘），不投上盘也不建议反向下盘
   ├─ majorReversal 短期反向     → 谨慎（最多小注）
   ├─ longDivergence 长期背离     → 通过但标黄，建议减仓
   └─ resonance / minorSplit / thin → 进入第 3 步

第 3 步 · 看信号强度
   ├─ 强 → 重点关注   ├─ 中 → 谨慎参考   └─ 弱 → 忽略
```

每一步都会附三行：**判定**、**为什么**、**模型规律提示**
（把该分支在记录库里的历史命中率 + 场次 + Wilson 下界算出来；第 1 步还会额外给出
「按本场景方向买」的历史命中率）。

结论等级（`decide().level`）：

| `level` | `label` | `score` | 触发条件 |
|---|---|---|---|
| `neutral` | 平手或错误 · 不参与 | 0 | 第 1 步就是「平手或错误」 |
| `veto` | 放弃（诱盘） | −100 | 一票否决 |
| `midwater` | 中水 · 不判定 | 1 | 中水场景但二次判定没给方向 |
| `invalid` | 谨慎（可能诱盘） | 2 | `majorReversal` |
| `strong` | 重点关注 | 5 | 强度「强」 |
| `mid` | 谨慎参考 | 3 | 强度「中」 |
| `weak` | 忽略 | 1 | 强度「弱」 |

### 4.18 统计口径

| 函数 | 作用 |
|---|---|
| `Core.wilson(w, n, z)` | Wilson 得分区间，`z` 默认 1.959964（95%）。返回 `{p, lo, hi}` |
| `Core.groupRates(recs, P, LIB)` | 按维度汇总历史胜率。维度：`overall` / `scene` / `q` / `arb` / `strength` / `depth`(X/4) / `water` / `move` / `league` / `upSide` / `side`。每项 = `{n, dn, w, rate, lo, hi}` |
| `Core.sideRates(recs, P, LIB)` | 只统计「按场景方向买」的命中率：正向场景上盘赢盘算命中，反向场景上盘**输**盘算命中；中水场景只有在二次判定给出方向时才计入 |
| `Core.recommendStats(recs, P, LIB)` | 按 5 种推荐情形（A / B1 / B2 / B3 / none）分组，算推荐方向是否赢盘 + ROI |
| `Core.confCalibration(recs, P, LIB)` | 置信度校准表（五档） |

**三个关键口径**（全站一致）：

1. **「已开奖」= `actual` 是「赢盘」或「输盘」**，走水与未填比分都不计入。
2. **全站只有「投注盈利」一个口径**（★ v15 起）：买上盘用记录里的水位 `w`，
   买下盘用 `max(0.5, ROUND(WATER_SUM − w, 2))` 估算；单场盈利 = 赢 `(水位 − 1)`，输 `−1`。
3. ~~`Core.computeStats` 的「赢盘率」是旧口径~~ —— **v15 已删除**。
   `computeStats()` 现在也只算投注盈利，输出的键是：
   `场次 / 已开奖 / 下注场次 / 投注盈利场次 / 投注盈利概率`，
   其中「投注盈利概率」与 `sideRates()` 的 `rate` **逐场景完全相等**（自检里有 40+ 组交叉验证）。
   「赢盘场次 / 赢盘率」这两个键**不再存在**，别在别处引用它们。
   `意图验证` / `场景验证准确率` 保留 —— 它们问的是「机构意图对不对」，不是「赚不赚钱」。

`Core.intentOf(r)` 判定「机构意图是否正确」：场景 4 / 5 / 6 是反向场景，
`输盘` 或 `走水` 算正确；其余场景 `赢盘` 算正确。

---

## 五、参数系统

### 5.1 `PARAM_DEFS` 的结构

每个参数是一个对象（定义在 `core.js` 顶部）：

| 字段 | 含义 |
|---|---|
| `k` | **键名**，`store.P` 里的属性名，也是 `PARAM_DEFS` 的唯一标识 |
| `g` | **分组**，调参中心的卡片标题 |
| `n` | **中文名**，界面显示的标签 |
| `d` | **默认值**。`defaultParams()` 就是遍历所有 `d` 拼出来的 |
| `s` | **步长**，用字符串写以免浮点误差（`'0.01'` / `'0.001'` / `'1'`） |
| `min` / `max` | 输入框上下限 |
| `int` | 为 `1` 时是整数参数，步长与显示都按整数处理 |
| `why` | **这个参数控制什么**，界面上直接显示（支持 `<b>` 等 HTML） |
| `lib` | 可选，标注它对应哪一条映射表键（历史遗留标记，**代码不读**） |
| `src` | 可选，标注来源（历史遗留标记，**代码不读**） |

**当前共 98 个参数，分 8 组**：

| 分组 | 数量 |
|---|---|
| 攻防积分 | 10 |
| 主战绩系数 | 9 |
| 排名分差 | 6 |
| 加减分项 | 2 |
| 盘口与场景 | 11 |
| 评分与置信度 | 23 |
| 模型置信度 | 17 |
| 伤停量化 | 20 |

### 5.2 怎样加一个新参数（要动哪几处）

**最小改动 = 1 处**：在 `core.js` 的 `PARAM_DEFS` 里加一条。

因为 `loadParams()` 先 `store.P = defaultParams()` 再覆盖已存的值，
**新增参数会自动拿到默认值**，不需要写迁移代码；
调参中心是按 `PARAM_DEFS` 循环渲染的，也会自动出现。

```js
{ k: 'MY_PARAM', g: '盘口与场景', n: '我的新参数', d: 0.5, s: '0.05', min: 0, max: 2,
  why: '这个参数控制什么，写清楚' },
```

然后在算法里用 `num(P.MY_PARAM, 0.5)` 读取（`num(v, dflt)` 会把空值 / 非数字都变成默认值，
**永远不要直接写 `P.MY_PARAM`**，否则用户清空输入框时会算出 `NaN`）。

**如果需要动的地方**：

| 情况 | 还要改哪里 |
|---|---|
| 参数参与「离线规则引擎」的自动扫描 | `mod-ai.js` 顶部的 `TUNABLE` 数组，以及 `panelRoad()` 里对应方向的 `keys` 列表 |
| 参数要出现在「使用说明 → 参数总表」 | 不用改，`mod-help.js` 是遍历 `PARAM_DEFS` 渲染的 |
| 参数要在「使用说明 → 算法文档」正文里被引用 | `mod-help.js` 里的 `dv('KEY', 小数位)` / `pt('KEY')` / `pn('KEY')` 三个小工具只能引用**已存在**的键，写错键会渲染出 `undefined` |
| 参数是新映射表的开关 | 见 §5.3 |

**不要**改 `loadParams()` 里那段兼容代码去「修」新参数 —— 那是给历史数据兜底用的。

### 5.3 `DEFAULT_LIB` 里有哪些映射表

`DEFAULT_LIB` 定义在 `core.js`，`loadLib()` 会先深拷贝默认值，再用 `localStorage` 里的同键值覆盖
（**只覆盖 `DEFAULT_LIB` 里存在的键**，所以给 `DEFAULT_LIB` 加新键就能自动生效）。

| 键 | 类型 | 说明 | 调参中心可改 |
|---|---|---|---|
| `leagues` | 对象 | 联赛 → `{N 球队总数, coef 联赛系数, R 总轮次, cap}`。7 个联赛 | ✅ 可增删 |
| `decay` | 数组 | 排名区间衰减，`[{h 主队区间, a 客队区间, v 系数}]`，6 组 | ✅ 可增删 |
| `plate` | 数组 | 盘口对照表，`[[数值, 中文名], ...]`，12 档 | ✅ 可增删 |
| `hist` | 对象 | 历史交锋分值，10 项 | ✅ 可增删改 |
| `injury` | 对象 | 伤病分值，6 项 | ✅ |
| `suspend` | 对象 | 停赛分值，3 项 | ✅ |
| `fatigue` | 对象 | 赛程疲劳分值，6 项 | ✅ |
| `streak` | 对象 | 连赢连负分值，3 项 | ✅ |
| `depth` | 对象 | 阵容深度倍数，3 项 | ✅ |
| `motive` | 对象 | 战意分值，5 项 | ✅ |
| `posClass` | 对象 | 位置命名 → 8 类别（GK/CB/FB/DM/CM/AM/WM/ST），16 个命名 | ✅ 键值对可改 |
| `posFac` | 对象 | 位置类别 → 伤害修正系数，8 项 | ✅ |
| `transferWindows` | 数组 | 5 大联赛的夏窗/冬窗 `{from, to, hm, tz}` | ✅ 可增删 |
| `depthMode` | 字符串 | `'squad'`（默认，修正版）\| `'residual'`（旧口径） | ✅ 下拉 |
| `arbMode` | 字符串 | `'v2'`（**默认**，新口径）\| `'legacy'`（旧口径） | ✅ 下拉 |
| `flatWaterMode` | 字符串 | `'columns'`（默认）\| `'home'` \| `'alwaysHome'` | ✅ 下拉 |
| `flatWaterDefault` | 字符串 | `'home'`（默认）\| `'none'` | ✅ 下拉 |
| `flatWaterDir` | 字符串 | `'up'`（默认）\| `'ignore'` | ✅ 下拉 |
| `sceneDir` | 对象 | 场景键 → `'up'` / `'down'` / `'none'` / `'cond'`，17 项 | ✅ 下拉 |
| `sceneKw` | 对象 | 方向关键词兜底：阻上/强支/补防/诱下→up，诱上/看衰→down | ❌ 只读 |
| `midWaterNames` | 数组 | 哪些水位档算「中水」（默认代码里回退到 `['中水']`） | ❌ 界面上没有 |
| `flatWaterRef` | 字符串 | 兼容旧键，`Core.flatWaterRef()` 读它 | ❌ 界面上没有 |
| `players` | — | 球员库**不放在这**，见下 | — |

> 球员库有独立的存储：`benxin.players.v1`（由 `mod-players.js` 管理），
> 不在 `DEFAULT_LIB` 里，也不跟 `benxin.lib.v1` 一起保存。
> `DEFAULT_LIB` 里有一行注释 `/* 球员库（上传/编辑；结构与 seed-players.js 一致）*/` 但没有实际键。

### 5.4 持久化键与版本迁移

| 键 | 内容 | 谁写 | 上限 / 备注 |
|---|---|---|---|
| `benxin.params.v1` | `store.P` 全部参数 | `Core.saveParams` | — |
| `benxin.lib.v1` | `store.LIB` 全部映射表 | `Core.saveLib` | — |
| `benxin.rows.v1` | `store.rows` 全部比赛记录 | `Core.saveRows` | 记录库本体 |
| `benxin.rows.bak.v1` | **v15 新增**：升级前的记录库快照 | `app.js` 启动时写一次 | 只在「还没有备份且旧数据 < 900KB」时写；`导出 / 导入`页有「退回升级前」按钮可一键恢复 |
| `benxin.settings.v1` | `store.settings`：`apiBase` / `apiKey` / `apiModel` / `visionModel` / `ui` | `Core.saveSettings` | `visionModel` 由 `mod-entry.js` 写入 |
| `benxin.history.v1` | 调参 / 回测历史 | `Core.saveHistory` | **只保留最后 60 条**（`slice(-60)`） |
| `benxin.iters.v1` | 迭代日志（模型置信度按版本命名） | `Core.saveIters` | `Core.defaultIters()` 提供 v11 / v12 两条初始记录 |
| `benxin.players.v1` | 球员库 | `Players.savePL` | 结构：`{leagues:{联赛:{球队:[{num,name,pos,val}]}}}` 类似 |
| `benxin.injury.v2` | 伤停量化页的输入状态 | `mod-players.js` | — |
| ~~`benxin.injury.v1`~~ | **已停用**，当前代码不再读写 | — | 保留在文档里只为避免误用 |

**版本迁移怎么做**（现有两种模式，照抄即可）：

**模式 A — 抬下限（`loadParams` 里那段）**

```js
if (store.P.AD_BIGWIN_ROUND < 8) store.P.AD_BIGWIN_ROUND = 8;
```

读取完参数后纠正历史脏值。**只做单向、幂等的修正**，不要在这里做复杂逻辑。

**模式 B — 按主键找「权威样本」+ 只补空值（`migrateRows`）**

```js
function migrateRows() {
  const fix = {};
  (global.SEED_ROWS || []).forEach(function (r) {
    if (!r || !r.home) return;
    fix[r.home] = {
      hADGames: r.hADGames, aADGames: r.aADGames,
      hGames: r.hGames, hPts: r.hPts, aGames: r.aGames, aPts: r.aPts,
    };
  });
  let n = 0;
  store.rows.forEach(function (rec) {
    const f = fix[rec.inp.home];
    if (!f) return;
    for (const k in f) {
      if (f[k] === undefined || f[k] === null || f[k] === '') continue;
      const cur = rec.inp[k];
      if (cur === undefined || cur === null || cur === '') { rec.inp[k] = f[k]; n++; }
    }
  });
  if (n) saveRows();
  return n;
}
```

这里用**主队名**当匹配键（`fix[rec.inp.home]`），从出厂示例里取「权威值」。
两条硬规矩：**① 只填空值，绝不覆盖用户填过的数据；② 权威值本身为空时跳过，不要用空串去填。**
每次启动在 `app.js` 里跑一遍，返回补了几个字段。

> 局限（见 §7.1 第 5 条）：这套迁移**只对「主队名和出厂示例里某一场完全相同」的记录有效**，
> 而且只覆盖那 6 个字段。要做更通用的迁移，得另写一套，别硬塞进这个函数。

**加一个全新的 `localStorage` 键**（比如把 `injury` 从 v2 升到 v3）：

1. 在 `mod-players.js` 顶部改常量：`const LS_INJ = 'benxin.injury.v3';`
2. 在 `loadInj()` 里做一次迁移：先读新键，读不到再读旧键，成功迁移后
   **不要**删旧键（保留可回滚），或者明确 `localStorage.removeItem('benxin.injury.v2')`。
3. 在 §5.4 的表里记一笔，并注明旧键已停用。

**不要**把版本号写进对象内部再判断 —— 现有代码全部靠**键名后缀**区分版本。

---

## 六、开发者手册

### 6.1 怎么新增一个页面模块

1. 在 `js/` 下新建 `mod-xxx.js`，写成 IIFE：

```js
(function () {
  'use strict';
  const C = window.Core, U = window.UI;      // 注意：必须在 core.js / ui.js 之后加载

  const S = { tab: 'a' };                     // 模块私有状态

  function page(host) {                       // host 是一个已插入 #pages 的 <div class="page">
    // ... 用 U.card / U.el / U.table 往 host 里塞内容
  }

  window.App.register({
    id: 'xxx',                                // 必填。hash 路由 + 导航锚点都用它，必须唯一
    title: '我的新页面',                        // 必填。左侧导航文字 + 页面 <h1>
    icon: '★',                                // 可选。导航图标（单字符最好看），默认 '•'
    group: '分析',                             // 可选。导航分组标题，默认 '模块'。
                                              // 同一个 group 字符串连续出现时只渲染一次标题
    desc: '一句话说明这一页干什么。',             // 可选。会以 html 形式插到 <h1> 下面
    render: page,                             // 必填。接收 wrap 元素；抛错会被 App 捕获并显示错误卡
  });

  window.Xxx = { /* 想给别的模块或自检脚本用的函数 */ };
})();
```

2. 在 `index.html` 的「页面模块」段落里，按你想要的**导航位置**插入 `<script src="js/mod-xxx.js"></script>`。

**`App.register` 的字段约定**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 全局唯一。`App.go(id)` 就是设 `location.hash = '#' + id` |
| `title` | ✅ | 导航文字 + 页头 `<h1>` |
| `render` | ✅ | `render(wrap)`。`wrap` 已经带着 `.page.on` 类名挂在 `#pages` 里，你只管往里 `appendChild` |
| `icon` | ❌ | 导航左侧那个小图标 |
| `group` | ❌ | 导航分组标题，默认 `'模块'` |
| `desc` | ❌ | 页头说明，**按 HTML 插入**（`U.el('p', {html: page.desc})`），所以里面可以用 `<b>`，但**用户输入不能放进来** |
| `actions` | ❌ | 一组 DOM 元素，会渲染到页头右侧（`.flexline` 容器）。用 `U.btn(...)` 造元素，**不能传字符串** |

**页面内部做子页签的标准写法**（所有现有模块都是这个模式）：

```js
const chips = U.el('div', { class: 'chips', style: { marginBottom: '12px' } });
[['a', '第一个页签'], ['b', '第二个页签']].forEach(function (t) {
  const c = U.el('span', { class: 'chip' + (S.tab === t[0] ? ' on' : ''), text: t[1] });
  c.addEventListener('click', function () { S.tab = t[0]; window.App.refresh(); });
  chips.appendChild(c);
});
host.appendChild(chips);
if (S.tab === 'b') panelB(host); else panelA(host);
```

`App.refresh()` 会**整页重渲染**（`host.innerHTML = ''` 之后重新调 `render`），
所以页签状态必须放在模块自己的 `S` 对象里，**不能**依赖 DOM 状态。

**渲染出错怎么办**：`App` 会把 `render` 包在 try/catch 里，出错时页面显示一张红色错误卡
（含 message 与 stack），导航不会挂。所以调试时直接看页面上那张卡就行。

### 6.2 UI 组件的用法与坑

`window.UI`（`js/ui.js`）全部导出项：

#### DOM 与文本

| 函数 | 说明 |
|---|---|
| `U.$(sel, root?)` / `U.$$(sel, root?)` | `querySelector` / `querySelectorAll`（后者返回真数组） |
| `U.el(tag, attrs?, kids?)` | 建元素。`attrs` 里的 `class` / `html` / `text` / `style`(对象) / `on*`(函数) 有特殊处理；值为 `null` / `undefined` / `false` 的属性**不会**被设置。`kids` 只能是字符串或 DOM 节点，`null` 会被跳过 |
| `U.esc(s)` | HTML 转义（`& < > " '`）。**任何用户输入进 HTML 之前都要过它** |
| `U.fmt(v, n?)` | 数字格式化，`n` 省略时 `|v| < 1` 用 4 位小数、否则 3 位，并去掉尾随 0 |
| `U.pct(v, n?)` | 百分比，默认 1 位小数。非有限数返回 `'—'` |
| `U.pill(text, kind?)` | 返回 `<span class="pill kind">` **HTML 字符串**。`kind`：`ok` / `bad` / `warn` / `info` / `mute` / `purple` |
| `U.bar(ratio, kind?)` | 返回进度条 **HTML 字符串**。`ratio` 会被 clamp 到 0~1 |
| `U.note(text, kind?)` | 返回 **DOM 元素**（不是字符串），`text` 按 HTML 插入。`kind`：`warn` / `bad` / `ok` / 空 |
| `U.card(title?, bodyEls?, desc?, hint?)` | 返回 **DOM 元素**。`bodyEls` 是 DOM 元素数组，`null` 会被跳过 |

#### 表格 —— ⚠️ 最容易踩的坑

| 函数 | 返回 | 能放什么 |
|---|---|---|
| `U.table(cols, rows, opts?)` | **HTML 字符串** | 单元格只能是**字符串**，或 `{html: '...', cls: '...'}` 对象。**不能放 DOM 元素** |
| `U.grid(cols, rows, opts?)` | **DOM 元素** | 单元格可以是**字符串**，也可以是**DOM 元素**（输入框 / 下拉 / 按钮） |

`U.table` 的 `cols` 元素字段：`k`（键名，或 `function(row, i)`）、`n`（表头文字）、
`w`（`min-width`）、`num`（右对齐 + 等宽字体）、`wrap`（允许换行，`max-width: 330px`）、
`cls`（额外 td class）、`raw`（强制当 HTML 输出，跳过下面的自动检测）。

**`U.table` 的自动转义规则**（`U.looksHtml`）：单元格值是字符串、含 `<`、
且匹配 `U.HTML_TAGS` 白名单标签（`span|b|i|em|strong|code|button|input|div|br|a|img|svg|small|section|...`）、
且**不含**危险内容（`U.DANGER_HTML`：`script` / `iframe` / `style` / `link` / `meta` / `form` /
`on*=` / `javascript:` / `data:text/html`）→ 当 HTML 直接输出；否则一律 `U.esc` 转义。

> 这条规则是为了让「纯文本永远不会漏转义、HTML 也不会被显示成源码」。
> **代价**：如果你的纯文本里恰好含 `<div>` 这类字样，它会被当 HTML 解析。
> 反过来，如果单元格里是 DOM 元素，`U.table` 会把它 `String()` 成 `[object HTMLInputElement]`。

**要在单元格里放控件 → 用 `U.grid`**：

```js
U.grid([{ n: '姓名', w: '120px' }, { n: '号码', w: '60px', num: true }],
  rows.map(function (p) {
    return [ U.input(p.name, function (v) { p.name = v; save(); }),
             U.number(p.num, function (v) { p.num = v; }) ];
  }), { maxH: '540px' });
```

`U.grid` 的 `cols` 元素字段：`n`（表头）、`w`（固定宽度，会同时设 `flex: 0 0 w` 和 `width`）、`num`（右对齐）。
**不写 `w` 的列会平分剩余空间**。`U.grid` 用 `.pl-grid` / `.pl-row` / `.pl-head` 这套样式，
表头是 sticky 的。

**`U.table` 有一个和 `U.grid` 都有的坑**：两者都是「一次性快照」。
用户改了输入框之后，**必须自己把新值写回数据 + 调 `window.App.refresh()`**（或局部重绘），
组件不会帮你同步。

#### 表单控件

| 函数 | 说明 |
|---|---|
| `U.field(label, inputEl, hint?)` | 把控件包成 `<label class="f">`。`hint` 显示在标签后面（小灰字） |
| `U.input(val, onInput?, attrs?)` | `type="text"`。`onInput(value, el)` |
| `U.number(val, onInput?, attrs?)` | `type="number"`。**空字符串会原样传 `''`**（不是 0），所以回调里要 `v === '' ? '' : Number(v)` |
| `U.select(opts, val, onChange?, attrs?)` | `opts` 可以是字符串数组，也可以是 `[{v, n}]`。`onChange(value, el)` |
| `U.textarea(val, onInput?, attrs?)` | 默认 `rows: 8`、`spellcheck="false"` |
| `U.btn(text, onClick, cls?, title?)` | `cls` 可用：`pri`（主按钮）/ `ghost` / `danger` / `sm`（小） |
| `U.chips(items, active, onPick, multi?)` | 药丸式选择器。`items` 可以是字符串数组或 `[{v, n}]` |

> **`U.number` 的坑**：回调收到的是 `''`（用户清空）或 `Number`。
> 直接 `store[k] = v` 会把 `''` 存进去，后面 `num()` 会兜底成默认值，但 `JSON` 里会多一个空串。
> 现有代码的写法是 `v === '' ? '' : Number(v)`。

#### 文件与剪贴板

| 函数 | 说明 |
|---|---|
| `U.download(filename, content, mime?)` | 触发下载。`content` 可以是字符串或 `Blob` |
| `U.pickFile(accept, cb)` | 单文件选择，`cb(file)` |
| `U.pickFiles(accept, cb)` | 多文件选择，`cb(files[])` |
| `U.copy(text)` | 复制到剪贴板（失败自动回退到 `execCommand`） |
| `U.confirmBox(msg, cb)` | 包装 `window.confirm` |
| `U.toast(msg, kind?, ms?)` | 右下角提示。`kind`：`ok` / `bad` / `warn` / 空。默认 2600ms |
| `U.parseCSV(text, delim?)` | 支持引号、`""` 转义、换行。`delim` 省略时自动识别 `\t` / `，` / `,` |
| `U.detectDelim(text)` | 只做分隔符识别 |
| `U.toCSV(headers, rows, quoteAll?)` | 输出带 **UTF-8 BOM** + `\r\n` 的 CSV（Excel 双击不乱码） |

### 6.2.5 移动端适配（v15.2，<768px）

整站是桌面优先的，**桌面端样式一个像素都没改**；手机端全部收在
`index.html` 末尾的一个 `@media (max-width: 767px)` 里 + 一个 `UI` 辅助函数。

#### 三条设计原则

1. **绝不缩放页面**（不要 `user-scalable=no`，也不靠 `zoom`）。手机上做的是**重排**：
   侧栏变抽屉、宽表变卡片、窄表保留表格但可横向滚。
2. **触控优先**：按钮 `min-height:44px`；输入框字号强制 `16px`（iOS Safari 在字号 <16px
   时会自动放大整页）；`input[type=number]` 固定 108px 宽（倍数这类不需要占满整行）。
3. **适配刘海屏**：`viewport` 带 `viewport-fit=cover`，侧栏/顶栏/底部提示用
   `env(safe-area-inset-*)` 留出安全区。

#### 外壳：顶栏 + 抽屉

| 元素 | 桌面 | 手机 |
|---|---|---|
| `#side`（左侧导航） | 固定 246px 宽 | `position:fixed` 走 `translateX(-103%)`，汉堡按钮打开，遮罩层点击关闭，点导航项自动收起 |
| `#mtop`（手机顶栏） | `display:none` | 汉堡 + 标题 + 记录条数 |
| `#app` | `flex; height:100vh` | `flex-direction:column; height:100dvh`（`dvh` 才不会在 iOS 被地址栏顶掉） |

抽屉逻辑在 `app.js` 的 `setupMobileNav()`；`App.closeNav()` 可被模块调用。

#### 表格怎么变成卡片（关键机制）

难点：全站表格有三种来源 —— `U.table` 字符串、`U.grid` 的 div、各模块自己拼的
`innerHTML`。逐个改必漏，所以做成**事后自动补标**：

```js
// ui.js
U.autoLabelTables(root)      // 给每个 <td> 补 data-th="列名"，并按列数打标记
```

- `app.js` 在 `render()` 里渲染完立刻调一次（立刻生效，无闪烁）；
- 再用一个 `MutationObserver` 监听 `#pages`（60ms 防抖）——因为很多模块会**局部重绘**
  （`renderLive` / `paintLeague` / 分页…），那些新表格不经过 `App.render`；
- 规则：**列数 ≥ 5 → `table.as-cards`（整表变卡片）；列数 < 5 → `table.as-scroll`
  （保留表格形态 + 横向滚动，`<th>` 的内联 `min-width` 会被压掉，避免顶破屏幕）**。

CSS 侧靠一行伪元素把表头文字画出来：

```css
table.as-cards td::before{ content: attr(data-th); flex:0 0 84px; color:var(--txt-3) }
```

`colspan` 的行（展开行、"暂无数据"）自动跳过标签（`data-nolabel`）。

#### 竞彩选票的「例外」

`mod-jc.js` 里的竞彩表**不走**通用卡片转换 —— 因为把 13 列竖着堆，一场就是 750px，
根本没法比较 胜/平/负。它用 `matchMedia('(max-width:767px)')` 判断，**换一套手机专用渲染**：

```
┌─────────────────────────────┐
│ ☐ 周一001  葡超      10-27 02:45 │
│ 圣克拉拉 vs 本菲卡              │
│ 胜平负   胜9.35   平4.95  负1.22 │   ← 三列并排，格子 48px 高
│ 让球     让胜3.30 让平3.55 让负1.84│
│ 主受让1                        │
│ [ 其他玩法 ▾ ]                 │
└─────────────────────────────┘
```

胜负彩同样处理（14 张小卡，胜/平/负 三个大格子）。窗口跨过断点时会自动重渲染
（`matchMedia` 的 `change` 事件）。

#### 怎么验证「手机上没问题」

`_tools/mobile_shot.mjs` 是一个**用 CDP 做真机模拟**的截图/巡检脚本（零依赖，自己实现了
WebSocket 客户端）：

```bat
node _tools\mobile_shot.mjs "http://127.0.0.1:8765/#dash" out.png 390 844 iphone
node _tools\mobile_shot.mjs "http://127.0.0.1:8765/#dash,#batch,#jc" x.png 390 844 iphone
```

- **不要用 `--window-size` 冒充手机**：Edge/Chrome 无头窗口最小宽度约 **492px**，
  设 `--window-size=390` 实际还是 492 CSS px，截出来是「裁切」而不是「重排」
  （这个坑我踩过：一度以为布局溢出，其实是截图方式错了）。
  只有 `Emulation.setDeviceMetricsOverride` 才是真的 390px 视口。
- 脚本会顺便量 `document.documentElement.scrollWidth`，并列出**超出视口的元素**
  （会自动跳过 `overflow:auto` 的容器），用来做「零横向溢出」回归。

**当前状态：10 个页面在 390px 下全部 `sw == iw == 390`，零横向溢出。**

#### ⚠️ 手机表单布局的两个致命坑（v15.4.2 实测记录）

真机（安卓 360~393px）反馈「标签被挤成一列竖排单字、输入框错位」。根因有**两层**，缺一不可：

**坑 1：横向布局在窄格子里必然崩**
早期手机端用「标签在左、控件在右」的 `label.f{flex-direction:row}`。一旦字段被放进两列栅格
（每格只有 ~168px），标签就被压到几个字符宽并逐字换行。
→ 改成**纵向堆叠**：`label.f{flex-direction:column}`，控件 `width:100%`。

**坑 2（更隐蔽）：`grid-column: span 2` 会凭空造出一条隐式列**
模块里大量用内联 `style="grid-column: span 2"` 让字段"跨两列占满整行"。
把栅格压成 1 列后，`span 2` 会让网格**自动生成一条隐式列** → 结果仍然是两列，
`getComputedStyle(grid).gridTemplateColumns` 实测是 **`111px 224px`（1:2）**，于是坑 1 又复发了。

```css
/* 单列栅格里的子项必须取消跨列，否则 span 2 会造出隐式列 */
.g2>*,.g3>*,.grid:not(.g2):not(.g3):not(.g4)>*,.grid:has(label.f)>*{grid-column:auto !important}
/* 含表单字段的栅格一律单列（.g4 的两列是留给 KPI 卡片的） */
.grid:has(> label.f),.grid:has(label.f){grid-template-columns:1fr !important}
```

**排查这类问题的正确姿势**（别再靠截图猜）：

```js
// 在真机宽度下逐个数一下还有哪些栅格是多列的
[...document.querySelectorAll('.grid')].forEach(g => {
  const t = getComputedStyle(g).gridTemplateColumns.split(' ');
  if (t.length > 1 && g.querySelector('label.f,input,select'))
    console.log(g.className, t, g.getBoundingClientRect().width);
});
```

我写了个巡检脚本一起跑：`_tools/mobile_shot.mjs` 的第 7 个参数可以传 JS（会打印返回值），
所以「404 个元素里哪几个被挤成竖排」可以被自动查出来，而不是人眼找。

### 6.2.6 手机端：只留 4 个模块 + 数据落到手机本地（v15.3）

#### 一、模块裁剪（桌面端完全不受影响）

手机端只显示 4 个页面，其余隐藏。白名单在 **`app.js` 顶部一处**：

```js
const MOBILE_PAGES = ['entry', 'batch', 'bet', 'export'];
// 生成录入 / 批量计算 / 投注建议 / 导出
```

| 接口 | 作用 |
|---|---|
| `App.mobilePages` | 白名单数组，运行时可改（例如加 `'help'`） |
| `App.pages()` | 当前设备**可见**的页面列表（桌面 = 全部 10 个） |
| `App.isMobile()` | `matchMedia('(max-width:767px)')` |

- `buildNav()` 用 `App.pages()` 渲染，所以导航会跟着变；
- `render()` 里如果 hash 指向被隐藏的页面（比如地址栏还留着 `#dash`），会**悄悄改成第一个可见页**
  （`history.replaceState`，不产生历史记录）；
- 窗口跨过 767px 断点时自动 `buildNav()` + 重渲染（`setupMobileNav` 里的 resize 监听）。

另外 `mod-batch.js` 的默认页签也跟着设备走：**手机端直接进「② 单场录入 · 盘」**，桌面端仍是「① 整行快录」。

#### 二、数据落到手机本地（`js/file-store.js` → `window.FileStore`）

**先认清平台能力**（这是浏览器安全策略，绕不过去）：

| 能力 | 电脑 Chrome/Edge | 安卓 Chrome | 苹果 Safari |
|---|---|---|---|
| `showDirectoryPicker()` 选一个**用户看得见**的文件夹 | ✅ | ❌ | ❌ |
| **OPFS**（`navigator.storage.getDirectory`）私有文件系统 | ✅ | ✅ | ✅ 15.2+ |
| `navigator.share()` 把文件分享到"文件"App | — | ✅ | ✅ |

所以 `FileStore` 分三档，自动降级：

```
mode = 'dir'   桌面浏览器选过文件夹 → 真写进你能看到的文件夹（handle 存 IndexedDB，下次自动恢复）
mode = 'opfs'  手机 / 其它          → 写进 OPFS：浏览器私有目录，关掉再开还在，但文件管理器里看不到
mode = 'none'  都不支持             → 只留 localStorage，界面提示「只能用导出按钮」
```

- **触发时机**：`app.js` 的 `hookFileSync()` 把 `Core.saveRows` 包了一层
  → **任何模块只要调用 `saveRows()`，就会自动同步**（0.5s 防抖），不用改各个模块。
- **写什么**：目录 `本心盘口/` 下两个文件
  - `本心手机端记录.json` —— 给电脑端导入用的数据（全量覆盖写）
  - `最近一次保存.txt` —— 人类可读的"刚才确实写进去了"凭证（时间/条数/触发原因）
- **失效兜底**：如果用户把文件夹删了/权限被回收，会自动退回 OPFS 再写一次，不会丢数据。

#### 三、导出 ↔ 导入的「契约」（这才是关键）

手机导出的格式 = **输入对象数组**：

```json
[ {"league":"西甲","home":"皇家社会","away":"维戈塞尔塔","open":-0.25, ... ,"note":""}, ... ]
```

这个形状**电脑端原生就认** —— `mod-io.js` 的 `handle()` 里：
`Array.isArray(o)` → 提示「识别为 JSON 数组：N 条记录」→ 走 `rowsToInputs()`。
**所以电脑端一行代码都没改**。已做端到端验证：手机端 12 条 → 电脑端解析 12 条，
`league/home/away/scoreText` 全部带上（首条 68 个字段）。

手机端导出按钮的行为：有 Web Share 就先弹系统分享（可"存储到文件"），否则退回 `<a download>`。

> ⚠️ **一个必须知道的坑**：`showDirectoryPicker` / Web Share 都要求**安全上下文**（https 或 localhost）。
> 手机用局域网 IP（`http://192.168.x.x:8765`）访问时，这两样都不可用 —— 但**数据保存（OPFS/localStorage）照常工作**。
> 所以第二阶段必须先有第三阶段的 **https 部署**，手机上的"导出成文件"才能在真机上用。

### 6.2.7 PWA 与密码锁（v15.4）

#### 文件清单

| 文件 | 作用 |
|---|---|
| `js/gate.js` | 密码锁：遮罩 + 哈希校验 + 30 天免输。**在 App 脚本之前加载**，已解锁时同步摘掉遮罩，不会闪 |
| `sw.js` | Service Worker：预缓存 30 个静态资源；导航请求网络优先、断网退缓存；**跨域（127.0.0.1 抓取接口）一律放行不拦** |
| `manifest.webmanifest` | 名称 / 图标 / `display:standalone` / `theme_color` / 3 个快捷方式（单场录入·投注建议·导出） |
| `js/pwa.js` | 注册 SW（只在安全上下文）+ `beforeinstallprompt` 自定义「装到主屏幕」提示（手机端才弹） |
| `icon-*.png` / `apple-touch-icon.png` | 图标：深色圆角 + 「本」字 + 蓝色强调线（PIL 生成，含 maskable 版） |

#### 三个容易踩的点

1. **`sw.js` 必须放在站点根目录**（`scope` 才能覆盖整站），所以它在 `网页/` 根下，不在 `js/`。
2. **改完任何 js/html 都要改 `sw.js` 的 `VERSION`**（`benxin-v15.4.0`），否则老用户拿到的是旧缓存。
   `vercel.json` 里已经给 `sw.js` 配了 `max-age=0`，保证浏览器每次都来问新版本。
3. **SW 只缓存同源 GET**。竞彩选票模块调的是 `http://127.0.0.1:8765/api/*`（跨域），
   SW 里显式 `return` 放行，绝不能拦 —— 否则抓取会变成"永远返回缓存"。

#### 部署包

`..\部署包\` 是给线上用的干净副本（30 个文件 / 1.08 MB，只含 `index.html` + `js/` + 图标 + `sw.js` + `manifest` + `vercel.json`），
**不含** `README.md`、`_tools/`、`竞彩计算器/`。部署步骤见 `..\部署与密码说明.md`。

#### 已验证（本地等价环境）

| 项 | 结果 |
|---|---|
| 密码锁：错密码 | 拦住 + 提示 + 抖动，仍是锁定态 |
| 密码锁：对密码 | 解锁、遮罩移除、`localStorage` 写入 token、4 个模块正常 |
| manifest | 能解析（`本心盘口分析台` / 3 个图标 / `standalone`） |
| Service Worker | 接管（`controller` 非空） |
| **断网刷新** | ✅ 仍能打开，4 个模块 + 标题正常 |
| 部署包独立运行 | ✅ 把它单独当静态站跑，上面全部成立 |


### 6.2.8 ⚡ 自动填充（v15.5，`js/vz-api.js`）

「② 单场录入」顶部可以贴 V站（vzhan310）链接或 8 位 ID，一键把本场数据抓下来填表。

#### 只走 JSON 接口（**纯前端，手机上也能用**）

| 用途 | 接口 | 备注 |
|---|---|---|
| 基础信息 | `GET /new-match/new-detail/base-info?match_id=` | 联赛/轮次/队名/时间/**当时排名** |
| 韦* 盘口 | `GET /new-match/detail/odds/detail/list?match_id=&book_id=6&type_id=1` | 全部变化史：`!!` 分行、`^` 分列 |
| 某日全部比赛 | `GET /new-match/jc/football-list?date=YYYY-MM-DD&page=1` | 比分 + 双方当时排名（`date` 必须配 `page`） |

域名 `https://mapi.shemen365.com`（从 `_nuxt` 包里挖出来的）。**参数是 `match_id`（下划线）** —— 试了 7 种写法才对。

#### ★ 两个必须记住的实测结论

1. **盘口字段 `f[6]` 的正负号就是方向，且与模型约定一致**：负数=主队让球，正数=主队受让。
   10 场比赛交叉验证（`+0.5` ↔ 网页「受半球」、`−0.75` ↔ 「半一」）。
   → 所以**不需要抓网页**（`www.vzhan310.com` 还被 CORS 挡着，抓也抓不到）。
2. **`book_id = 6` 是「韦*」**，用「初盘 2.07/1.80 + 即时 1.94/1.91」双指纹验证。
   变化史按时间**倒序**：第 0 条 = 终盘，最后一条 = 初盘 → 两个时间都有了。

#### 性能（实测，110 天上限）

| 场景 | 耗时 |
|---|---|
| 冷启动（翻 110 天历史） | **4.6~4.9 秒** |
| 第二次（命中 localStorage 缓存） | **0.17~0.31 秒** |

优化的关键：并发 8 路 + 120ms 错峰 + 双层缓存（内存 / localStorage）。
**注意 `MAX_DAYS` 别调小**：改成 70 天会导致近 6 场只找到 4 场（实测过）。

#### 三条铁律（都落到代码里）

1. **宁可不填，也不填错**：让球方要求「盘口符号」与「初盘水位」两条一致才填；初盘/终盘方向相反会报警。
2. **不偷偷改用户数据**：联赛不在 `LIB.leagues` 里**不自动选**，弹出「➕ 加进联赛库」按钮，**点了才加**（默认 20 队/系数 1.00，之后去调参中心校正）。抓不到的字段**不写进表单**，不覆盖手填值。
3. **限速 + 缓存**：同一天的数据只问一次；两队近 6 场共用一次翻页（不是各翻一遍）。

#### 抓不到、仍需手填的 5 项

伤病 / 停赛 / 阵容深度 / 战意 / 空场 —— 三家网站都没结构化数据。


### 6.2.9 🔄 球队/球员库更新（v15.6，`竞彩计算器\titan_db.py`）

「生成录入 → 球员库」顶部有「🔄 更新球队 / 球员库」卡片，一键从**球探网（titan007）**抓球队名单和球员阵容。

#### ★ 这件事为什么只能由后端做

`zq.titan007.com` 只支持 **TLS 1.0**。现代客户端（Python 默认 / Node / curl）握手会被它直接断开
（`RemoteDisconnected` / `curl 000`），**浏览器 fetch 也一样连不上**。必须：
```python
ctx.minimum_version = ssl.TLSVersion.TLSv1
ctx.set_ciphers("DEFAULT@SECLEVEL=0")
```
所以这个功能依赖 `启动.bat` 起的本地后端（`http://127.0.0.1:8765`），部署到 Netlify 的纯静态版用不了。

#### 数据来源（全是 jsData 静态文件，好解析）

| 文件 | 内容 |
|---|---|
| `/jsData/leftData/leftData.js` | 联赛目录 `[id,简,繁,英,类型]` |
| `/cn/League/<id>.html` 或 `/cn/SubLeague/<id>.html` | **从页面里抠出真正的赛果数据地址**（文件名带动态后缀！） |
| 上一步得到的 `s<id>[_xxx].js` | `arrTeam = [[球队id,简,繁,英,,logo,0],...]` |
| `/jsData/teamInfo/teamDetail/tdl<球队id>.js` | `teamDetail` + `goalkeeper/rearguard/midfielder/vanguard` 四组球员 |

**实测：英超 20 队 → 572 名球员**，阿森纳 28 人（含号码/位置）。

#### 两个坑（都踩过）

1. **文件名有动态后缀**：英超是 `s36.js`，但韩K联是 `s15_781.js`、葡超是 `s23_1123.js`。
   → 必须先抓联赛页 HTML，用正则把 `/jsData/matchResult/.../s<id>...js` 抠出来，**不能硬拼**。
2. **联赛页有两种**：`/cn/League/`（英超/西甲/葡超…）和 `/cn/SubLeague/`（日职联/澳超/韩K联…），要挨个试。

#### 球探限流很凶（重要）

连续快速请求会让**整个 IP 被临时断连**（所有请求 `Remote end closed connection`），我测试时触发过一次，
恢复要 10~30 分钟。所以做了这些防护：

| 防护 | 做法 |
|---|---|
| 目录缓存 | `data/league_catalog.json`，7 天有效，不用每次请求 |
| 限速 | 默认 `spacing=1.2` 秒/请求 |
| 指数退避 | 被掐断时睡 3→6→12 秒重试，最多 3 次 |
| 连续失败熔断 | 连续 4 队失败 → 停 8 秒 |
| **断点续抓** | 已有阵容的球队默认跳过（`force=True` 才重抓） |
| **逐队落盘** | 每抓成功一队就 `save()`，进程被杀也不丢 |
| 失败不清空 | 抓失败的球队**保留旧阵容**，并在 `warn` 里记一笔 |

**使用建议：一次别选超过 2~3 个联赛。**

#### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/titan/db` | 读库 + 汇总（联赛数/球队数/球员数/上次更新时间） |
| GET | `/api/titan/status` | 后台任务进度（running/done/total/msg/error） |
| POST | `/api/titan/refresh` | body `{"leagues":["英超"],"force":false}` → 起后台线程 |

后台跑（daemon 线程），前端每 1.5 秒轮询 `/api/titan/status`，可以切页面不影响。


#### 附：Transfermarkt 数据源（v15.6.1，`竞彩计算器\tm_db.py`）

「球员库」那张卡上可以切换两个数据源，输出**同一个 JSON 结构**，前端不用区分：

| | **Transfermarkt**（推荐） | **球探 titan007** |
|---|---|---|
| 实现 | `tm_db.py` → `data/tm_db.json` | `titan_db.py` → `data/titan_db.json` |
| 阵容字段 | 号码/位置/年龄/身高/惯用脚/国籍/**身价/合同到期/加盟日期/来自哪队**/队长/照片 | 号码/姓名/位置 |
| 球员名 | 英文 | **简体中文** |
| 限流 | 宽松（实测连发 12 次零失败，服务端有缓存） | 严（会临时封 IP） |
| 赛季 | 支持 `season_id`（可抓历史/下赛季） | 只抓当前赛季 |
| 实测 | 英超 20 队 **547 人**（70 秒）、葡超 18 队 **519 人**（56 秒） | 英超 20 队 572 人（23 秒，之后被封） |

**为什么用它**：Transfermarkt 官方条款禁止自动抓取、Cloudflare 也很凶（直连 403）。
这里用的是社区维护的公开封装服务（`transfermarkt-api`），**是它去访问 TM**，
我们的 IP 不会被 TM 记住；而且它在服务端做了缓存（响应里有 `updatedAt`）。

**★★ 该服务没开 CORS** → 浏览器不能直连，必须由本地后端代抓（和球探一样依赖 `启动.bat`）。

**联赛 id 映射（实测逐个试出来的，注意两个反直觉的）**：
```
英超 GB1  西甲 ES1  德甲 L1(!)  意甲 IT1  法甲 FR1
英冠 GB2(!)  葡超 PO1  荷甲 NL1  沙地联 SA1  美职联 MLS1
挪超 NO1  日职联 JAP1  韩K1联 RSK1  芬超 FI1  澳超 AUS1
```
> 德甲是 `L1` 不是 `BL1`；英冠是 `GB2` 不是 `ELC`。
> 还可以用 `/competitions/search/<名字>` 兜底（实测搜 "Veikkausliiga" 命中 6 条）。

**灵活更新（转会 / 升降级 / 下赛季）**：

| 需求 | 做法 |
|---|---|
| 球员转会 | 再点一次「更新选中联赛」→ 每队写入 `changes:{added,removed}`，界面显示「有 N 队阵容变动」 |
| 下赛季 / 补历史 | 在「赛季」输入框填赛季 id（如 `2027`），留空 = 各联赛当前赛季 |
| 只想重抓某一队 | 目前一次抓整个联赛；单队重抓 = 勾选该联赛后点「强制全量重抓」 |
| 中途断了 | 已抓过的队伍默认跳过，再点一次从断点继续 |

### 6.3 参数总表（从 `PARAM_DEFS` 读出，共 98 项 / 8 组）

> 下表是**代码里的默认值**。用户在调参中心改过之后，`store.P` 里的值会不同 ——
> 要拿运行时真值，读 `Core.store.P`，不要读 `PARAM_DEFS[].d`。

**攻防积分（10）**

| 键 | 名称 | 默认 | 步长 | 区间 |
|---|---|---|---|---|
| `AD_DFW` | D值权重 | 0.35 | 0.01 | 0 ~ 2 |
| `AD_BIGWIN_DIFF` | 大胜判定净胜球 | 3 | 1 | 1 ~ 10 |
| `AD_BIGWIN_FACTOR` | 大胜折算系数 | 0.8 | 0.01 | 0 ~ 1 |
| `AD_CAP` | D值限幅 | 0.8 | 0.05 | 0.1 ~ 3 |
| `AD_BIGWIN_ROUND` | 结果保留位数 | 8 | 1 | 2 ~ 12 |
| `STRONG_OPP_RATIO` | 强对手判定比例 | 1/3 | 0.01 | 0 ~ 1 |
| `STRONG_OPP_MUL` | 强对手系数 | 1.1 | 0.01 | 0.5 ~ 2 |
| `WEAK_OPP_RATIO` | 弱对手判定比例 | 2/3 | 0.01 | 0 ~ 1 |
| `WEAK_OPP_MUL` | 弱对手系数 | 0.85 | 0.01 | 0.2 ~ 1.5 |
| `SAMPLE_FULL_GAMES` | 样本满场次 | 6 | 1 | 1 ~ 20 |

**主战绩系数（9）**

| 键 | 名称 | 默认 | 步长 | 区间 |
|---|---|---|---|---|
| `FORM_A` | 基础系数 a | 0.65 | 0.01 | 0 ~ 3 |
| `FORM_B` | 斜率系数 b | 0.2 | 0.01 | 0 ~ 3 |
| `FORM_LO` | 系数下限 | 0.7 | 0.01 | 0 ~ 3 |
| `FORM_HI` | 系数上限 | 1.3 | 0.01 | 0 ~ 5 |
| `FORM_SMOOTH` | 样本平滑阈值（场） | 5 | 1 | 1 ~ 30 |
| `FORM_LATE_ROUNDS` | 赛季末修正轮数 | 5 | 1 | 0 ~ 20 |
| `FORM_CONVERGE` | 收敛因子 | 0.6 | 0.01 | 0 ~ 1 |
| `FORM_EMPTY` | 空场强制系数 | 0.5 | 0.01 | 0 ~ 2 |
| `FORM_STEP` | 偏差折算步长 | 0.125 | 0.001 | 0.001 ~ 1 |

**排名分差（6）**

| 键 | 名称 | 默认 | 步长 | 区间 |
|---|---|---|---|---|
| `RANK_W` | 排名权重 | 0.6 | 0.01 | 0 ~ 3 |
| `RANK_LO` | 净分差下限 | −0.5 | 0.05 | −5 ~ 0 |
| `RANK_HI` | 净分差上限 | 0.5 | 0.05 | 0 ~ 5 |
| `RANK_TIER_LO` | 上游/中游分界排名 | 6 | 1 | 1 ~ 30 |
| `RANK_TIER_HI` | 中游/下游分界排名 | 12 | 1 | 1 ~ 40 |
| `RANK_TIER_MAX` | 区间判定上限排名 | 18 | 1 | 1 ~ 40 |

**加减分项（2）**

| 键 | 名称 | 默认 | 步长 | 区间 |
|---|---|---|---|---|
| `ADJ_CAP` | 伤病/停赛封顶 | 0.6 | 0.05 | 0 ~ 3 |
| `ADJ_MOTIV_AWAY` | 客队战意折扣 | 0.5 | 0.05 | 0 ~ 1 |

**盘口与场景（11）**

| 键 | 名称 | 默认 | 步长 | 区间 |
|---|---|---|---|---|
| `HCP_STEP` | 盘口步长 | 0.125 | 0.001 | 0.001 ~ 1 |
| `HCP_UNIT` | 每档盘口头 | 0.25 | 0.01 | 0.01 ~ 1 |
| `HCP_CAP` | 盘口封顶 | 3 | 0.25 | 0.25 ~ 6 |
| `WATER_SUM` | 上下盘水位之和 | 2 | 0.01 | 1.5 ~ 2.5 |
| `W_ULTRA_LOW` | 超低水上限 | 0.8 | 0.01 | 0 ~ 3 |
| `W_LOW` | 低水上限 | 0.9 | 0.01 | 0 ~ 3 |
| `W_MID` | 中水上限 | 0.99 | 0.01 | 0 ~ 3 |
| `W_HIGH` | 高水上限 | 1.09 | 0.01 | 0 ~ 3 |
| `MOVE_SMALL` | 微调上限 | 0.25 | 0.05 | 0 ~ 3 |
| `MOVE_MID` | 中幅上限 | 0.5 | 0.05 | 0 ~ 3 |
| `MOVE_BIG` | 大幅下限 | 0.75 | 0.05 | 0 ~ 3 |

**评分与置信度（23）**

| 键 | 名称 | 默认 | 步长 | 区间 |
|---|---|---|---|---|
| `DEV_T1` | 偏差评分1档 | 0.25 | 0.05 | 0 ~ 3 |
| `DEV_T2` | 偏差评分2档 | 0.5 | 0.05 | 0 ~ 3 |
| `DEV_T3` | 偏差评分3档 | 0.75 | 0.05 | 0 ~ 3 |
| `LINK_HI` | 联动评分·高 | 3 | 0.5 | 0 ~ 10 |
| `LINK_LO` | 联动评分·背离 | 0 | 0.5 | 0 ~ 10 |
| `LINK_MID` | 联动评分·中性 | 1 | 0.5 | 0 ~ 10 |
| `ARB_OK` | 仲裁评分·三方一致 | 2 | 0.5 | 0 ~ 10 |
| `ARB_MINOR` | 仲裁评分·短期小分歧 | 1.5 | 0.5 | 0 ~ 10 |
| `ARB_DIV` | 仲裁评分·长期背离 | 1 | 0.5 | 0 ~ 10 |
| `ARB_REV` | 仲裁评分·短期重大反向 | 0.5 | 0.5 | 0 ~ 10 |
| `ARB_TOTAL` | 仲裁评分·全面背离（真否决） | 0 | 0.5 | 0 ~ 10 |
| `ARB_THIN` | 仲裁评分·方向证据不足 | 1 | 0.5 | 0 ~ 10 |
| `ARB_VETO` | 仲裁评分·旧口径一票否决 | 0.5 | 0.5 | 0 ~ 10 |
| `ARB_BAD` | 仲裁评分·旧口径信号无效 | 0 | 0.5 | 0 ~ 10 |
| `TIME_T4` | 时间评分·24h+ | 2 | 0.5 | 0 ~ 10 |
| `TIME_T3` | 时间评分·6h+ | 1.5 | 0.5 | 0 ~ 10 |
| `TIME_T2` | 时间评分·3h+ | 1 | 0.5 | 0 ~ 10 |
| `TIME_T1` | 时间评分·不足3h | 0.5 | 0.1 | 0 ~ 10 |
| `TIME_DEF` | 时间评分·缺失默认 | 1 | 0.5 | 0 ~ 10 |
| `CONSENSUS_MIN` | 信号一致数量门槛 | 2 | 1 | 1 ~ 3 |
| `VETO_ABS` | 一票否决阈值 | 0.3 | 0.05 | 0 ~ 3 |
| `STRONG_SCORE` | 强信号分界 | 7 | 0.5 | 0 ~ 20 |
| `MED_SCORE` | 中信号分界 | 4 | 0.5 | 0 ~ 20 |


**模型置信度（17）**

| 键 | 名称 | 默认 | 步长 | 区间 |
|---|---|---|---|---|
| `ITERATION` | 模型迭代版本号 | 12 | 1 | 1 ~ 999 |
| `CONF_W_SCENE` | ① 场景证据权重 | 45 | 5 | 0 ~ 100 |
| `CONF_W_DIR` | ② 方向证据权重 | 25 | 5 | 0 ~ 100 |
| `CONF_W_CLARITY` | ③ 场景清晰度权重 | 15 | 1 | 0 ~ 100 |
| `CONF_W_STRUCT` | ④ 盘口结构权重 | 15 | 1 | 0 ~ 100 |
| `CONF_PRIOR_N` | 先验样本量 | 4 | 1 | 0 ~ 50 |
| `CONF_PRIOR_P` | 先验胜率 | 0.5 | 0.05 | 0 ~ 1 |
| `CONF_LO_FLOOR` | 下界映射下限 | 0.25 | 0.05 | 0 ~ 1 |
| `CONF_LO_CEIL` | 下界映射上限 | 0.55 | 0.02 | 0 ~ 1 |
| `CONF_CAP_VETO` | 强背离封顶 | 25 | 5 | 0 ~ 100 |
| `CONF_CAP_NEUTRAL` | 平手或错误封顶 | 30 | 5 | 0 ~ 100 |
| `CONF_CAP_MIDWATER` | 中水不判定封顶 | 55 | 5 | 0 ~ 100 |
| `CONF_CRIT_MUL` | 心盘临界折扣 | 0.9 | 0.05 | 0.1 ~ 1 |
| `CONF_T1` | 高置信分界 | 80 | 5 | 0 ~ 100 |
| `CONF_T2` | 中高分界 | 65 | 5 | 0 ~ 100 |
| `CONF_T3` | 中等分界 | 50 | 5 | 0 ~ 100 |
| `CONF_T4` | 偏弱分界 | 35 | 5 | 0 ~ 100 |

**伤停量化（20）**

| 键 | 名称 | 默认 | 步长 | 区间 |
|---|---|---|---|---|
| `EDGE_NUM` | ① 边缘候选·号码下限 | 40 | 1 | 1 ~ 99 |
| `EDGE_PCT` | ① 边缘候选·身价分位 | 0.10 | 0.01 | 0 ~ 0.5 |
| `POOL_MIN` | ① 有效池最低人数（保护1） | 18 | 1 | 11 ~ 30 |
| `GK_KEEP` | ① 门将保护人数（保护2） | 2 | 1 | 1 ~ 5 |
| `W_START` | ② W 上一场首发 | 1.00 | 0.05 | 0 ~ 2 |
| `W_SUB_PLAYED` | ② W 替补有上场 | 0.45 | 0.05 | 0 ~ 2 |
| `W_BENCH` | ② W 替补坐板凳 | 0.15 | 0.05 | 0 ~ 2 |
| `W_OUT` | ② W 未进大名单 | 0.02 | 0.01 | 0 ~ 2 |
| `W_NEW` | ② W 新援 | 0.60 | 0.05 | 0 ~ 2 |
| `LOSS_T1` | ③ 伤病分档 T1 | 0.04 | 0.01 | 0 ~ 1 |
| `LOSS_T2` | ③ 伤病分档 T2 | 0.10 | 0.01 | 0 ~ 1 |
| `LOSS_T3` | ③ 伤病分档 T3 | 0.18 | 0.01 | 0 ~ 1 |
| `LOSS_T4` | ③ 伤病分档 T4 | 0.27 | 0.01 | 0 ~ 1 |
| `LOSS_T5` | ③ 伤病分档 T5 | 0.35 | 0.01 | 0 ~ 1 |
| `DEPTH_XI` | ④ 深度·首发人数 N | 11 | 1 | 5 ~ 20 |
| `DEPTH_HI` | ④ 深度·雄厚阈值（squad） | 0.28 | 0.01 | 0 ~ 2 |
| `DEPTH_LO` | ④ 深度·薄弱阈值（squad） | 0.19 | 0.01 | 0 ~ 2 |
| `DEPTH_RES_HI` | ④ 深度·雄厚阈值（residual 旧口径） | 0.88 | 0.01 | 0 ~ 1 |
| `DEPTH_RES_LO` | ④ 深度·薄弱阈值（residual 旧口径） | 0.75 | 0.01 | 0 ~ 1 |
| `DEPTH_FORCE` | ④ 无伤病时强制「深度一般」 | 1 | 1 | 0 ~ 1 |

### 6.4 自检怎么跑

**脚本**：`_tools/selfcheck.cjs`。它是一个 Node 脚本，自带一套最小 DOM shim
（`makeEl` / `document` / `localStorage` / `window` / `Blob`），把 `js/` 下所有模块
用 `new Function(...)` 加载进同一个假窗口，然后跑断言。

**命令**（PowerShell，用 bundle 里的 node）：

```powershell
& "C:\Users\chaoxing\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "D:\网页\_tools\selfcheck.cjs" "D:\网页"
```

**当前状态：全绿 —— `通过 1494 项，失败 0 项`，退出码 0。**（v15 实测，连跑两次结果一致）

#### 6.4.1 覆盖范围

`selfcheck.cjs` 会先 `new Function(...)` 把 `js/` 下的模块按加载顺序灌进一个假窗口，
然后从算法一路测到 UI 渲染。它覆盖 **31 段**：

```
加载脚本 · 算法回归快照（大阪钢巴 vs 神户胜利船）· 12 场示例数据的自洽性 · 调参生效性
统计 / 置信度引擎（v12）· 生成录入 · 智能解析 · 记录库体检 + 历史数据修复
批量计算 · 整行解析 · 批量计算 · 记录转换 · 导出 · XLSX 产物结构校验 · 导出 · CSV
AI 回测迭代 · 离线引擎 · 导入 / 跨电脑迁移 · 解析器
★ 修正：阵容深度与伤病解耦（消除重复惩罚）· ★ 伤停量化：一场比赛两队同时录 + 号码标注 (是)/(否)
新增 · 三步决策树（decide）· ★ v14 仲裁重新设计 · ★ v14.1 上盘判定
v12 新增 · 中水四场景 / 中水二次判定 / 模型置信度 · v13.2 · 统计页三处调整
v13 · 推荐准确率（统计页 + 调参诊断台）· 新增 · 投注建议模块（v13 收敛成 2 条逻辑）
修复 · 表格单元格里的 HTML 不再被转义 · UI 渲染冒烟（全部页面 render 不抛错）
UI 子标签页冒烟 · 改动① · 赛果录入倒序 + 明细只显示文字数值
改动② · ② 盘 加「从赛果录入载入 / 回写」· 导入 · 真实 DEFLATE 压缩的 ZIP
```

**所以：改 `core.js` 之后一定要跑一遍自检。** 它是这个项目唯一的回归保护。

#### 6.4.2 维护自检脚本时要知道的 3 件事

1. **文件清单写死在脚本里**。第 142 行的 `FILES` 与第 143 行的 `MODS` 是**手写数组**，
   不是扫描目录。**新增 / 删除 / 重命名 `js/` 下的文件之后，必须同步改这两行**，
   否则脚本会因为 `fs.readFileSync` 抛 `ENOENT` 而在加载段直接 `process.exit(1)`
   （表现是只打印几个 PASS 就退出，看不到有意义的报错）。
   当前清单：

   ```js
   const FILES = ['core.js','ui.js','xlsread.js','seed.js','seed-players.js','app.js'];
   const MODS  = ['mod-dash.js','mod-params.js','mod-players.js','mod-entry.js','mod-batch.js',
                  'mod-stats.js','mod-bet.js','mod-io.js','mod-ai.js','mod-help.js'];
   ```

2. **`js/` 里的文件必须能被 `new Function()` 直接解析**。也就是说：
   - 不能有 **UTF-8 BOM**（`new Function` 会把 BOM 当成非法字符 → `Invalid or unexpected token`；
     浏览器不会，所以这是一个**只在自检里暴露**的坑）；
   - 不能有语法错误。一旦某个文件语法坏了，自检会停在「加载脚本」段，
     而且报错信息只有一个 `SyntaxError: Invalid or unexpected token`，**不告诉你是哪个文件**。
     排查手法：逐个文件 `node --check js\xxx.js`。

3. **断言助手**（写新断言时照这个来）：

   | 助手 | 用法 |
   |---|---|
   | `ok(name)` | 直接记一次通过 |
   | `bad(name, extra?)` | 直接记一次失败 |
   | `truthy(v, name)` | 真值断言 |
   | `eq(a, b, name)` | 字符串相等（内部 `String(a) === String(b)`） |
   | `near(a, b, tol?, name)` | 数值近似（默认 `tol = 1e-6`，另有相对误差兜底） |
   | `section(title)` | 打印一个分段标题 |
   | `finish()` | 结尾汇总「通过 N 项，失败 M 项」，然后 `process.exit(FAIL ? 1 : 0)` |

   所以**退出码非 0 = 有 FAIL**。

#### 6.4.3 还可以补的断言

现在这几块**没有**被测到，值得加：

- `Core.resolveUpper`：三种 `flatWaterMode` × 两种 `flatWaterDefault` × `flatWaterDir`
- `Core.recommend`：五种情形（A / B1 / B2 / B3 / none）各一个用例
- `Core.confidence`：四分量、三种封顶、心盘临界折扣
- `Core.computeInjury`：`(是)/(否)/(停)/(新)` 标注、两条保护、门将降档
- `Core.settle` 的符号约定：用 12 场示例验证「主队上盘赢盘 ⟺ `goalDiff > |J|`」

> **关于「存盘快照」类断言**：自检里有一段「算法回归快照」，做法是**把当前引擎的输出
> 写死在脚本里**，以后改动导致输出变化就会 FAIL。这类断言的价值很高，但代价是
> **快照会跟着算法一起漂** —— 每次有意改算法，都要**有意识地**更新快照，
> 并记清楚为什么变。不要为了让它变绿就随手改数字。

### 6.5 `_tools/` 下每个脚本是干什么的

这个目录里绝大多数是**一次性历史脚本**（当时拿一个本地表格工作簿做数据源、
做逐位对账时写的），现在**已经不需要**，只是保留了史料价值。真正的工具只有 2 个。

#### 仍然有用的

| 文件 | 作用 |
|---|---|
| `selfcheck.cjs` | **唯一的自动化测试**。Node 里跑全部模块 + 1494 条断言（当前全绿，见 §6.4） |
| `smoke.mjs` | 用 Edge 无头模式加载工作台，收集控制台错误与关键渲染结果。改完 UI 想确认真实浏览器里不报错时用它 |

#### 数据生成（一次性，已被 `seed.js` / `seed-players.js` 取代）

| 文件 | 作用 |
|---|---|
| `gen_seed.cjs` | 把 `seed.js` 重写成「只有示例数据」的版本（去掉旧的对账期望值），并把 `seed-fix.js` 的确认值合并进来 |
| `gen_players.py` | 从 6 个 `.xls` 生成 `js/seed-players.js` |
| `gen_golden.cjs` | 生成自检脚本里「算法回归快照」那一段的替换文本（值全部取自当前引擎） |
| `regen_cache.py` | 用当前引擎重算快照值并回写 `seed.js` |
| `depth_calib.py` | 统计 114 支球队的「固有板凳厚度」分布，用来给 `DEPTH_HI` / `DEPTH_LO` 定标（0.28 / 0.19 就是这么来的） |
| `fix_seed.cjs` | 修 `seed.js` 里某支球队的字段 |
| `fix_wording.cjs` | 一次性把 `js/` 里残留的 Excel 术语从**文案与注释**里换掉（不动逻辑） |

#### 调试 / 排查（一次性）

| 文件 | 作用 |
|---|---|
| `dbg_bet.cjs` | 投注建议模块的打分排查 |
| `dbg_formula.cjs` | 公式对比 |
| `dbg_parse.cjs` | 定位录入解析的字段错位 |
| `dbg_re.cjs` | 单行正则试验 |
| `dbg_scene.cjs` | 水位档判定排查 |
| `dbg_seed.cjs` / `dbg_seed2.cjs` | 看 `seed.js` 的行数/长度 |
| `dbg_seg23.cjs` | 第二/三段算式的分段排查 |
| `dbg_veto.cjs` | 找能触发/关闭一票否决的输入组合 |
| `diag_arb.cjs` | 仲裁结论与四分量方向一致性诊断（只读，不改模型） |
| `peek.cjs` | 打印 `selfcheck.cjs` 某段原文，方便做大段替换前确认边界 |

#### 历史数据源脚本（依赖已弃用的表格源文件，**现在跑不了**）

| 文件 | 作用 |
|---|---|
| `parse_xls.py` | 纯 Python 的 OLE2(CFB) + BIFF8 解析器（`xlsread.js` 的算法来源） |
| `dump_rows.py` | 用 openpyxl 导出一批比赛记录 |
| `dump_v12.py` | 导出 v12 的批量数据成 JSON，供 Node 侧逐列对账 |
| `inspect1.py` ~ `inspect5.py` | 探查工作簿结构 |
| `recon_v12.cjs` | v12 全量对账：拿工作簿里保存的输入，用网页内核重算，逐列比对 |
| `verify1.py` | 用 Python 复刻 JS 引擎，重算 12 行做验证 |
| `verify_full.py` | 全算法验证 |
| `vba_dump.py` / `vba_extract.py` / `vba_extract2.py` / `vba_hex.py` / `vba_hex2.py` / `vba_scan.py` / `vba_scan2.py` / `extract_vba.py` | 尝试从工作簿里提取 VBA 源码（当时是为了搞清楚保存宏的行为）。**结论：读不出来** |

#### 一次性源码补丁（改完就废）

| 文件 | 作用 |
|---|---|
| `cut_entry.cjs` / `cut_entry2.cjs` / `cut_entry3.cjs` | 从 `mod-entry.js` 里删页签 |
| `splice2.cjs` / `splice_arb.cjs` / `splice_inj.cjs` / `splice_inj2.cjs` / `splice_sec1.cjs` | 把某段文本拼进 `selfcheck.cjs` / `mod-players.js` |
| `patch_arb.cjs` | 把「`r.arb === LABELS.arb.xxx`」这类字符串比较换成语义化判定函数 |

#### 文本素材（补丁的输入）

`_injblock.txt` / `_injblock2.txt` / `_newblock.txt` / `_newblock2.txt` / `_newblock3.txt` / `_newsec1.txt`
—— 上面那些 `splice_*.cjs` 用的待插入代码片段。

#### 建议

这些历史脚本**不要删**（它们是早期表格版算法的唯一记录，将来要追溯某个系数怎么来的会用到），
但也不要在里面继续开发。**新工具请另起名字**，别混进 `dbg_*` / `splice_*` 这一堆里。

---

## 七、已知限制

以下每条都**在当前代码里成立**，与历史工作簿无关。

### 7.1 数据与算法

1. **客队历史交锋恒等于 0 —— 已确认为设计约定（v15 起写进自检）**。
   `evaluate()` 里 `Ft = A.score + 0 + ADJ.aTotal`，中间那个 `0` 就是客队历史交锋的位置。
   **填什么都等于 0**：`aHist` 会被原样记录、在记录里能查，但**绝不参与计算**。
   `ADJ.a` 里带一个 `histIgnored: true` 标记提醒后来人。
   `mod-batch` 的 ⑥ 加减分项里，客队那一格的标签写成「客队（不计分）」。
   自检断言：`aHist` 填「3胜」与「3负」的净分差**完全相同**。
2. **`aGames` / `aPts` 是主队的客场数据**，不是客队的。字段名容易误读，改动时务必当心。
3. **「本心实力盘」用的是攻防积分的最终得分，不是原始场次数据**。
   `E = F.diff + H.score + R.diff + ADJ.hTotal`，其中 `H.score` 是
   `MEDIAN(...) × 联赛系数 × 场次削弱系数` 之后的结果。
4. **`hADGames` / `aADGames` 为空时，攻防积分的场均会用「近 6 场非空槽位数量」代替**。
   只要近 6 场里有空槽（没踢的比赛），估算值就会偏。数据总览的「记录库体检」就是查这个。
5. **`Core.migrateRows()` 只从「出厂示例」里补 6 个字段**。
   它按主队名去 `window.SEED_ROWS` 里找同名的示例比赛，把
   `hADGames` / `aADGames` / `hGames` / `hPts` / `aGames` / `aPts` 这 6 个字段
   **只补你自己的记录里为空的那几个**（绝不覆盖已填的值）。
   所以：
   - 它**只对「主队名和 12 场示例里某一场完全相同」的记录有效**，其余记录不会被碰；
   - 它**只能补上面那 6 个字段**，别指望它修别的缺失（比如 `league` / `open`）。
   数据总览的「🔧 一键补齐」按钮和 `app.js` 启动时的提示走的都是它。
6. ~~**`Core.midVerdict` 有两个定义**~~ —— **v15 已确认不存在此问题**（全文只有一份 `midVerdict`，
   不会再出现"函数声明提升导致改错那一份"的情况）。v15 同时重写了它的判定基准，见 §4.13。
7. **「僵尸参数」v15 已清理**：
   - `TIMING_NOTE_DAYS`（过早投注天数）**已从 `PARAM_DEFS` 删除** —— 引擎从未读过它，调它没有任何反应；
   - `leagues[联赛].cap`（联赛表里的"封顶值"）**已从调参界面移除** —— 引擎从未读过它
     （数据结构里还留着这个键，只是为了不动历史数据）；
   - `CONSENSUS_MIN` 仍只被旧口径 `arbitrateLegacy` 使用，`arbMode = 'v2'`（默认）时不生效。
8. **平手盘（初盘终盘都是 0 球）的方向判定依赖水位口径**，而水位口径有三种
   （`flatWaterMode`）。默认 `'columns'` 假设「初盘水位记主队、终盘水位记客队」——
   这是个**约定**，不是从数据里推出来的。
   **v15 起不必再改口径**：② 单场录入里多了一个「**机构让球方（上盘方）**」下拉，
   手动点一下就以你点的为准（存 `inp.upSideManual`，导出时是最后一列「手动指定上盘方」）。
9. **水位缺失的行为 v15 改了**：不再把「没填」当成 0 判成「超低水」，
   而是把水档判成 **`未知`** → 场景落「平手或错误」（不参与），并在界面顶部给出红色警告。
   平手盘 + 水位全缺 + 又没手动指定时，仍按 `flatWaterDefault = 'home'` **兜底判主队为上盘**
   （这条没变），但界面会明说「这是默认设定，不是算出来的」。

### 7.2 统计与置信度

10. **中水四场景历史样本极少**。这几个场景是 v12 才拆出来的，老记录里几乎没有样本。
    所以「置信度 ① 场景证据」这一块在短期内会一直偏低，整体置信度也会偏低 ——
    这是**诚实的表现**，不是 bug。
11. ~~**`Core.computeStats` 的「赢盘率」是旧口径**~~ —— **v15 已统一成全站唯一的「投注盈利」口径**，
    两套数并存的问题没有了。另外修掉一个连带 bug：旧版 `computeStats` 不输出
    `投注盈利场次 / 投注盈利概率` 这两个键，导致「完整明细」导出里那两列**一直是空的**，
    现在会正常填。
12. **记录库分页（v15）**：明细表和赛果录入区默认每页 50 条（可切 20 / 50 / 100 / 全部）。
    600 条记录时「纯计算」约 90ms，慢的是画 DOM —— 分页后只画当前页。
    如果切到「全部」又觉得卡，就是一次性画上千行的代价，不是算法问题。
12. **下盘水位是估算值**。记录里只存了上盘水位（`openWater` / `closeWater`），
    买下盘时用 `max(0.5, ROUND(WATER_SUM − 上盘水位, 2))` 推。默认 `WATER_SUM = 2`。
    真实盘口请自行核对；想保守就把它调到 1.9。
13. **一票否决会同时影响三处**：`r.arbScore`（仲裁评分 = 0）、
    模型置信度（封顶 25）、推荐引擎（`A` 情形 −40 分 / `B3` 情形 −30 分 / `B1` 情形 −35 分）。
    改 `ARB_TOTAL` 只改仲裁评分，**不会**改后面那两处。
14. **`decide()` 的第 1 步优先于第 2 步**。一场比赛如果同时是「平手或错误」和「一票否决」，
    结论是「平手或错误 · 不参与」，不会走到第 2 步。这是刻意设计，不是漏判。

### 7.3 伤停量化

15. **球员表里本身有空号**：`seed-players.js` 里葡超 81 名、西甲 37 名、德甲 20 名、
    英超 13 名球员的「号码」栏是 `-`。程序把它们存成 `null`，
    这类球员**不能用号码定位**，填伤停名单时要写姓名。
16. **身价缺失用队内平均身价兜底**（约 500 人）：这些球员的 `S_i` 是估计值。
    想要更准就在球员库里手动补身价。
17. **`DEPTH_FORCE = 1`（默认）意味着「无伤病 → 强制深度一般」**。
    无伤病时伤病分本来就是 0，所以乘数不影响结果；
    但「深度」这一栏显示的就不是球队真实板凳厚度了。
    想要如实反映球队属性，把它改成 0。
18. **`depthMode = 'residual'` 存在重复惩罚**。规则原文的 `ResidualRatio ≡ 1 − Loss_Est`，
    与伤病等级同源，两个乘数同向叠加。默认已经切到 `'squad'`（固有板凳厚度），
    `'residual'` 只作对照保留，切过去时程序会打警告。
19. **伤停量化的结果只是「文本标签」**，最终分值仍由 `LIB.injury` / `LIB.depth` / `LIB.suspend`
    查表得到。所以改 `DEPTH_HI` 之类阈值会改变标签，但**不会**改变分值本身 ——
    要改分值得改映射表。

### 7.4 转会窗口

20. **德甲冬窗日期不确定**。原文写「1月初 – 1月底/2月初」，默认按
    **1月1日 – 1月31日 20:00 (CET)** 处理。可以在「转会窗口」页直接改成实际日期。
21. **`transferWindows` 有两份**：`DEFAULT_LIB.transferWindows`（可编辑）和
    `core.js` 里的 `TRANSFER_WINDOWS` 常量（硬编码，`Core.transferStatus` 在 LIB 缺项时才用它）。
    改界面上的那张表只改前者。

### 7.5 工程

22. **自检脚本的文件清单是手写的**（`selfcheck.cjs` 第 142 / 143 行的 `FILES` 与 `MODS`）。
    新增 / 删除 / 重命名 `js/` 下的文件之后如果忘了同步这两行，自检会在加载段
    直接 `process.exit(1)`，而且**只报一个看不懂的 `ENOENT`**。
    同理，`js/` 里任何文件带上 **UTF-8 BOM** 或出现语法错误，自检都会在加载段停住
    （浏览器不受 BOM 影响，所以这是只在自检里暴露的坑）。详见 §6.4.2。
23. **`mod-help.js` 里仍有历史文案**（比如算法文档的标题写成「与表格版本一致」、
    参数总表的表头写成「当前生效值 vs 原值」）。它们不影响算法，只是文案没清干净。
24. **`Core.arbitrateLegacy` 的 `CONSENSUS_MIN`** 是旧口径专用的；
    默认 `arbMode = 'v2'` 时它完全不参与计算。
25. **`seed.js` 的初始记录只在「记录库为空」时植入一次**（`app.js` 的判断），
    之后你删掉了就不会再来。要恢复就清空 `localStorage` 里的 `benxin.rows.v1`。
26. **`localStorage` 的容量上限约 5MB**。记录库、球员库都往里塞，
    球员库（`seed-players.js`）本身就有 145KB，塞进 `benxin.players.v1` 后更大。
    记录多了会写失败 —— `saveRows()` 的 `try/catch` 是**静默吞掉**的，
    写不进去你不会收到任何提示。**建议定期用「导出 / 导入」做 JSON 备份。**
27. **AI 功能需要自己填 API Key**，Key 明文存在 `benxin.settings.v1`（`localStorage`）。
    不要在这台机器上填别人的 Key。

---

## 八、变更历史

只保留还有意义的版本节点。更早的细节在 `12版改动地方.txt` 与 `13版文字叙述.txt` 里。

| 版本 | 关键改动 |
|---|---|
| v11 | 八大场景用**有符号差值**判升/降盘（存在跨零误判）；统计口径为「赢盘率」；模型置信度首版（场景证据 + 方向证据 + 场景清晰度 + 盘口结构） |
| **v12** | ① 深开/浅开的 `depthLabel` 补 `I = 0` 分支（心盘平手但机构开出盘口 → 判「深开」，不再一律判平手）<br>② 升/降盘改用 **`ABS(K)` vs `ABS(J)`**（修跨零误判），新增**中水四场景**（中水·深升 / 深降 / 浅升 / 浅降），兜底场景改名为「平手或错误」<br>③ 联动评分同步改用绝对值比<br>④ 新增「中水二次判定」`midVerdict`<br>⑤ 统计口径从「赢盘率」改为「投注盈利」<br>⑥ 记录结构收敛（导出列布局随之调整） |
| **v13** | ① 投注建议的推荐逻辑从 9 条**收敛成 2 条**（`intent` 只看八大场景、`fundamental` 吃盘口不变 + 中水四场景）<br>② 统一推荐引擎 `Core.recommend`，把情形分为 `A` / `B1` / `B2` / `B3` / `none` 五种，并新增 `REC_CASES`<br>③ 中水二次判定按公式**原意**重写：原公式拿「支持主队 / 有平局 / 支撑客队」去比「支持上盘 / 不支撑上盘」，永远匹配不上，导致 X≥3 与 X≤1 的场次全部落到「不判定」。新版改用 `supportUpper` / `supportLower`（按 `r.upSide` 翻转）<br>④ 新增 `flatAdvice` 盘口不变方向建议<br>⑤ 调参中心新增第三个标签页「推荐准确率」诊断台<br>⑥ 统计分析五个标签页重排（单场意图解剖分「出现八大场景 / 没出现」两种结论、场景出现准确率只留八大场景、标签顺序调整）<br>⑦ AI 回测迭代新增「调参路线图」（六个方向 + 自动诊断） |
| **v14** | ① **仲裁推倒重做**：旧口径四票全是「主队 − 客队」，而决策方向是「上盘 / 下盘」，客让盘时语义整反。新口径以**机构让球方**为基准做方向对称检验（`L` 长期 / `S` 短期 / `e1` / `e2`），分六个分支 `resonance` / `minorSplit` / `longDivergence` / `majorReversal` / `totalDivergence` / `thin`<br>② 引入语义化判定 `arbIsVeto` / `arbIsBad` / `arbIsOk` / `arbIsCaution`，禁止再比 `r.arb` 字符串<br>③ `LIB.arbMode` 开关，可切回旧口径对照<br>④ 模型置信度的「② 方向证据」从 `consensus/4`（纯主队视角）改成**相对下注方向**的对称口径<br>⑤ 伤停量化引擎落地（有效池 + 两条保护 + `W × S × PosFac` + `Loss_Est` 分档 + 停赛取 MIN）<br>⑥ 「阵容深度」与伤病解耦：新增 `depthMode = 'squad'`（固有板凳厚度：替补平均身价 ÷ 首发平均身价），修掉 `ResidualRatio ≡ 1 − Loss_Est` 带来的重复惩罚；旧口径保留为 `'residual'`<br>⑦ 号码标注语法 `(是) / (否) / (停) / (新)`<br>⑧ 球员库与转会窗口 |
| **v14.1** | ① **上盘判定三步** `resolveUpper`：初盘 `J ≠ 0` → 用 `J` 的符号；`J = 0` 但终盘 `K ≠ 0` → 用 `K` 的符号；`J = K = 0` 平手盘 → 靠水位判（`flatWaterMode` 三种口径 + `flatWaterDefault` 兜底 + `flatWaterDir` 是否给方向）<br>② **`settle()` 盘口符号修正**（独立 bug）：旧写法用「受让」逻辑（`goalDiff − (−hcp)`），在让球盘上会把输盘判成赢盘。修正为「主队上盘赢盘 ⟺ `goalDiff > |J|`」<br>③ 新增/修改的参数：`flatWaterMode` / `flatWaterDefault` / `flatWaterDir`（映射表开关），`resolveUpper` 相关逻辑<br>④ 模块重组：删掉 `js/mod-effects.js`（拆成 `mod-dash.js`，其中「算法自检」整页删除，有用的「记录库体检」并进数据总览）；删掉 `js/seed-fix.js`（值并进 `seed.js`）<br>⑤ `benxin.injury.v1` → `benxin.injury.v2` |
| **v15** | **① 中文盘口符号修正（会算错结论的 bug）**：`plateValue()` 原来把「主让」映射成**正数**，与全站「负 = 主队让球」相反 → 凡是从文本进来的盘口（整行快录 / Excel 导入 / 截图识别 / 手打），**上盘方与赛果全部反转**。改后中文与数字结果完全一致；没写「谁让谁」的中文一律返回 `null` 报错、不再猜。同时去掉 `mod-entry.js` 里重复翻负号的那一层<br>**② 折算盘口单位修正**：`computeMatch()` 把「球」传给了按「分」解释的 `plateText()`，导致伤停量化折算显示**放大一倍**（0.5 球显示成「一球」）。新增 `lineTextOfBall()`（球单位）并改用它<br>**③ 中水二次判定的基准改成「基本面四项占优」**：方向不再由场景名反转/否决，`midVerdict().dir` 与 `recommend().dir` 强制一致；并修掉 `evaluate()` 传给 `midVerdict` 的残缺对象（它让主队让球的中水场次全判反）<br>**④ 缺值不再当 0**：终盘留空 = 与初盘相同（原判「降盘」）；水位留空 → 水档「未知」→ 场景落「平手或错误」并给出红色警告；初盘留空 → 深开浅开 =「无法判定」；联赛不在表里 → 明确警告。新增 `r.warn[]` 列表，② 单场录入顶部直接列出来<br>**⑤ 新增「手动指定机构让球方」**：`inp.upSideManual`（主队/客队/平手），优先级最高，导出为第 88 列；平手盘水位记法摸不准时用它定音<br>**⑥ 录入界面改造**：机构初盘/终盘加「快捷点选 + 实时识别为」提示，一律以数字为准<br>**⑦ 清理僵尸项**：删 `TIMING_NOTE_DAYS`（参数 99 → 98）、联赛表移除无效的「封顶值」列、客队历史交锋下拉加「不参与计算」标注<br>**⑧ 数据安全**：升级首次启动自动快照旧记录库（`benxin.rows.bak.v1`），导出页可一键退回<br>**⑨ 自检**：修正 18 条把旧错误行为当基准的断言，新增 68 条 v15 回归断言（含 300+ 场中水一致性交叉验证、40+ 组统计口径交叉验证、分页与 aHist 约定），总数 1422 → 1490<br>**⑩ 口径统一 + 分页（v15 第二批，按使用方要求）**：① 「客队历史交锋」确认为**恒等于 0**（填什么都不影响结果，自检钉死）；② `computeStats` 删掉旧的「赢盘场次 / 赢盘率」，全站只留「投注盈利」一个口径，并修掉「完整明细里投注盈利两列一直是空的」这个连带 bug；③ 记录库 + 赛果录入加**分页**（默认每页 50，可 20/100/全部），记录多了不再一次画上千行 |
| **v15.1** | **新增「竞彩选票」模块（与盘口算法无关的工具页）**：① 左侧导航「工具 → 竞彩选票」；② 数据由本机后端 竞彩计算器\server.py 提供（Python 标准库零依赖，抓 500彩票网）；③ 竞彩支持胜平负 / 让球 / 比分 / 总进球 / 半全场 + 1~8 关串关，注数奖金用「初等对称多项式」DP 精确计算（js\jc-calc.js，43 条单元断言含暴力枚举对拍）；④ 胜负彩 14 场 / 任九，支持双选三选复式；⑤ 后端挂了会渲染诊断卡并给出三种自救方式（重试 / 示例 / 导入 JSON），**不会白屏** |

**当前版本号**：`PARAM_DEFS` 里 `ITERATION = 12`。
这个值只用来给「模型置信度」指标命名（`模型置信度 v12`），
**不代表上面那张表的版本**——上面的 v14 / v14.1 / v15 是算法改动记录。
要把它推进到 v13，改 `ITERATION` 并在迭代日志里写一笔（统计分析 → ④ 页签里有入口）。

---

## 九、给下一个对话的开场白（可直接复制）

> 我在 `D:\网页` 有一个纯离线的单页网页应用（双击 `index.html` 就能跑，
> 无构建、无 CDN、无服务器、无依赖）。请先读 `README.md`，
> 再读 `js/core.js`（算法内核，~2960 行，参数定义在 `PARAM_DEFS`，共 98 项）。
> 改 `core.js` 之后**一定要跑一遍 `_tools/selfcheck.cjs`**（命令见 README §6.4，
> 当前是全绿：通过 1494 项 / 失败 0 项）。它是这个项目唯一的回归保护。
> **当前算法版本是 v15**（详见 §八 变更历史）：盘口符号、折算单位、中水判定基准、缺值行为都在 v15 改过，
> 读代码时别按 v14 的文档理解。

**开工前建议先确认的四件事**：

1. 跑一遍 §6.4 的命令，确认自检是**全绿**（预期：`通过 1494 项，失败 0 项`，退出码 0）。
2. 打开 `index.html`，看数据总览能不能正常渲染（浏览器 F12 控制台应当无报错）。
3. 读一遍 `PARAM_DEFS`，确认你要改的参数**在引擎里真的被读**（见 §7.1 第 7 条的僵尸参数）。
4. 盘口相关改动**先读 §3.2 的符号与单位约定**——v14 及以前这里有三个坑（中文符号反、
   `plateText` 与 `plateValue` 单位不一致、缺值当 0），v15 已修，别改回去。
