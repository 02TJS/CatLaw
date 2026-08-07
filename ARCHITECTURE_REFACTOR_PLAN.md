# 猫咪工坊架构重构计划

基线版本：`v0.14.37`（提交 `7eae67c`）
记录日期：2026-08-06

## 目标

在不改变游戏规则、模拟顺序、随机数消费、存档兼容性和用户交互的前提下，逐步缩小核心模块的职责范围，让协议、状态、渲染、平台适配和领域计算各自拥有清晰边界。

## 执行原则

1. 每个阶段先固定现有行为，再调整结构。
2. “只搬迁”“只重命名”“修改逻辑”必须分成不同提交。
3. 每个小步骤均须通过客户端与服务端类型检查、完整单元测试和生产构建。
4. 保持模拟执行顺序、金额舍入方式、随机数调用顺序和存档字段不变。
5. 不采用一次性大拆分；每次只抽离一个可验证的边界。
6. 每个阶段完成后必须生成 Windows 便携 EXE 与带完整相邻运行文件的解包版 EXE；Codex Toolbox 必须同步到该阶段的最新已验证解包版，并完成 Toolbox 重建与静态自检。默认不启动 Toolbox 或游戏。

## 分阶段计划

| 阶段 | 目标 | 主要动作 | 验收标准 |
| --- | --- | --- | --- |
| P0 基线与门禁 | 固化 `0.14.37` 行为 | 补齐地图编辑、地图分析、财富历史契约测试；发布流程先测试再构建；建立 QA 分层 | 类型检查、完整测试和生产构建通过，发布流程不能跳过测试 |
| P1 共享契约 | 消除跨页面协议和环境声明的重复来源 | 抽取 Recipe BroadcastChannel 协议；集中通道与存档 schema 常量；将 QA `Window` 声明移出游戏领域类型 | 消息值、分支和状态形状不变；协议与常量只有一个定义来源 |
| P2 GameCanvas | 分离输入、场景与绘制 | 依次抽离几何/相机、命中测试、场景 read model、右键命令、输入状态机和渲染图层 | 绘制层不修改领域状态；地图交互和视觉 QA 无回归 |
| P3 App | 将主组件收敛为组合根 | 抽离游戏时钟、会话/存档、设置、平台适配、BroadcastChannel hook 和 QA read model | 每类副作用只有一个所有者，浏览器和 Electron 行为一致 |
| P4 engine/market | 明确模拟与市场子域 | 先迁移纯函数，再显式化 tick 流水线；拆分价格、供需、成交和历史统计 | 相同状态与随机种子产生完全相同结果，模块无循环依赖 |
| P5 状态与迁移 | 分离不同生命周期的状态 | 区分持久、运行时、历史、审计和 UI 状态；将迁移改为逐版本注册表 | schema 1–17 fixture 均可加载并重新保存，旧字段无损 |
| P6 语义命名 | 统一单位与领域名称 | 分批澄清 `coins`、`playerBuildingInventory` 和两套 speed 语义 | 金额单位一致，速度类型不可混用，存档保持兼容 |
| P7 文档与 QA | 收口发布与维护入口 | 同步 README 版本；整理 QA 脚本目录、分层和 npm 入口 | 发布矩阵明确，文档版本一致，废弃脚本有明确记录 |

推荐执行顺序：`P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7`。

## 当前进度

- P1：已完成（2026-08-07）。Recipe 通道协议与通道名已有单一来源；存档 schema 常量已集中；QA `Window` 声明已移出游戏领域类型。现有消息值、兼容分支、存档字段和迁移顺序均未改变。便携 EXE 位于 `release-stage-0.14.37-p1/CatWorkshop-0.14.37-p1-portable.exe`，Toolbox 指向 `release-stage-0.14.37-p1/win-unpacked/猫咪工坊.exe`；Toolbox 已重建并通过静态自检。
- P2：已完成（2026-08-07）。`GameCanvas` 已按渲染接线、几何/命中、输入状态、场景 read model、右键菜单和绘制实现拆分；事件顺序、命中优先级、坐标/相机公式、scene layer/order、绘制顺序、控制器调用和状态修改顺序均未改变。新增 10 项纯模块契约测试；客户端/服务端类型检查、43 个测试文件共 275 项测试及生产构建全部通过。便携 EXE 位于 `release-stage-0.14.37-p2/CatWorkshop-0.14.37-p2-portable.exe`，Toolbox 指向 `release-stage-0.14.37-p2/win-unpacked/猫咪工坊.exe`；Toolbox 已重建并通过 30 项注册测试与静态自检。
- P3：已完成（2026-08-07）。`App.tsx` 从 1422 行收敛为 757 行组合根；抽离会话/存档接线、偏好设置、平台适配、Recipe BroadcastChannel、DeepSeek 设置与 QA read model，保持副作用顺序、定时器、事件、controller 调用和清理顺序不变。新增 5 项契约测试；客户端/服务端类型检查、47 个测试文件共 280 项测试及生产构建全部通过。便携 EXE 位于 `release-stage-0.14.37-p3/CatWorkshop-0.14.37-p3-portable.exe`，完整解包 EXE 位于 `release-stage-0.14.37-p3/win-unpacked/猫咪工坊.exe`；Toolbox 已同步 P3 路径并重建，通过注册测试与静态自检。
- P4：已完成（2026-08-07）。`engine.ts` 从 1804 行收敛为 1378 行，`market.ts` 从 2204 行收敛为 2142 行；抽离价格、信用/净值、供需预算、玩家成交、财富与市场历史统计，并将 tick 阶段顺序显式化。原 `engine`/`market` 公共导出继续作为兼容门面；模拟阶段、排序、金额公式、随机数消费和历史压缩顺序均未改变，32 个游戏模块无循环依赖。新增 5 项边界契约测试；客户端/服务端类型检查、48 个测试文件共 285 项测试在资源隔离验收中全部通过，生产构建通过。便携 EXE 位于 `release-stage-0.14.37-p4/CatWorkshop-0.14.37-p4-portable.exe`，完整解包 EXE 位于 `release-stage-0.14.37-p4/win-unpacked/猫咪工坊.exe`；Toolbox 已同步 P4 路径并重建，通过注册测试与静态自检。
- P5：已完成（2026-08-07）。新增 `stateLifecycle.ts`，在不改变平面 `GameState` 字段、嵌套层级和存档形状的前提下，显式区分持久、运行时、历史、审计与 UI 生命周期，并将原有序列化排除规则收口到持久化边界；新增 `saveMigrationRegistry.ts`，逐项注册 schema 1–17（包括无操作版本），由注册链生成与原 `<3/<4/<5/<6/<12/<14` 条件完全等价的迁移计划，`migrateSaveSnapshot` 内默认值、修复动作和执行顺序均未改变。新增 41 项生命周期、注册连续性、谓词等价与 schema 1–17 加载/重存 fixture 测试；客户端/服务端类型检查、50 个测试文件共 326 项测试在资源隔离验收中全部通过，生产构建通过。便携 EXE 位于 `release-stage-0.14.37-p5/CatWorkshop-0.14.37-p5-portable.exe`，完整解包 EXE 位于 `release-stage-0.14.37-p5/win-unpacked/猫咪工坊.exe`；Toolbox 已同步 P5 路径并重建，通过 30 项注册测试与静态自检。
- P6：已完成（2026-08-07）。新增 `domainUnits.ts` 与 `domainSemantics.ts`：所有明确金额字段以不改变运行时表示的 `Cents` 别名统一标注为整数分；玩家混合仓库通过 `playerWarehouseInventory` 使用规范领域名称，但磁盘字段仍为 `playerBuildingInventory`；确定性引擎内部倍率与仅存在于控制器的 1×/2×/4×/8× 播放倍率使用不可混用的类型和明确 API，同时保留 `coins`、`treasuryCoins`、`SPEED_PRESETS`、`getSpeedMultiplier`、`setSpeed` 等存档/调用兼容入口。原内部倍率取整、运行时最近预设及较小值平局规则、金额公式、存档形状、迁移、随机数和执行顺序均未改变。新增 5 项语义边界契约测试；客户端/服务端类型检查、51 个测试文件共 331 项测试及生产构建全部通过。便携 EXE 位于 `release-stage-0.14.37-p6/CatWorkshop-0.14.37-p6-portable.exe`，完整解包 EXE 位于 `release-stage-0.14.37-p6/win-unpacked/猫咪工坊.exe`；Toolbox 已同步 P6 路径并重建，通过 30 项注册测试与静态自检。
- P7：已完成（2026-08-07）。`README.md` 已与 `package.json`、`README.html` 统一为 0.14.37，并明确正式发布名、本地便携/解包双产物、当前 schema 17 与分层发布矩阵；新增 `scripts/README.md`，在不移动或删除旧文件的前提下，将 QA 分为单元/静态、浏览器、Electron、打包、在线/人工及报告/研究层，并记录版本冻结和历史探索脚本不再作为当前发布门禁。`package.json` 新增 11 个稳定 QA/报告入口并保留 5 个旧入口兼容别名；新增 `qa-maintenance-entrypoints.mjs` 自动核对版本、产物说明、脚本目标、分层文档和别名。游戏、金额、存档、迁移、随机数与执行顺序均未改变。维护契约、README 浏览器 QA、客户端/服务端类型检查、51 个测试文件共 331 项测试及生产构建全部通过。便携 EXE 位于 `release-stage-0.14.37-p7/CatWorkshop-0.14.37-p7-portable.exe`，完整解包 EXE 位于 `release-stage-0.14.37-p7/win-unpacked/猫咪工坊.exe`；Toolbox 已同步 P7 路径并重建，通过 30 项注册测试与静态自检。P1–P7 架构重构规划至此全部完成。
