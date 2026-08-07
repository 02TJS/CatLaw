# QA 与维护脚本

本目录保持现有文件名和路径不动，以免破坏外部命令、历史报告或人工操作记录。日常维护优先使用 `package.json` 中的稳定入口；未列为稳定入口的脚本仍可按需直接运行。

## 单元与静态门禁

| 稳定入口 | 用途 | 外部条件 |
| --- | --- | --- |
| `npm run qa:unit` | 单 worker 运行完整 Vitest，避免重型确定性模拟争抢资源 | 无 |
| `npm run qa:maintenance` | 核对版本、P7 双产物说明、QA 分层、脚本目标和旧 npm 别名 | 无 |
| `npm run build` | 客户端/服务端类型检查与生产构建 | 无 |

测试源码位于 `src/**/*.test.ts` 与 `server/**/*.test.ts`。它们是逻辑和存档兼容的首要发布门禁。

## 浏览器 QA

`npm run qa:browser:readme` 直接打开本地 `README.html`，无需开发服务器。其余 `qa-*.mjs` 浏览器脚本通常需要先运行 `npm run dev`，再按脚本约定访问 `http://127.0.0.1:5173`。这组脚本覆盖地图、仓库、配方、语音、缩放、滤镜、世界编辑与报告页面。

`qa-readme-schema14.mjs` 的文件名保留历史市场协议名称；它仍是当前 README HTML 门禁，并不代表当前存档版本停留在 schema 14。

## Electron QA

`npm run qa:electron:desktop` 验证桌宠窗口、原生拖动/缩放、设置持久化、配方外链和关闭流程。它会短暂启动 Electron，默认维护和打包流程不会自动调用；需要显式验收已打包版本时设置绝对路径环境变量 `CAT_WORKSHOP_EXECUTABLE`。

其他 `qa-electron-*.mjs` 是渲染恢复、语音、地图筛选和财富历史等专项回归，按需直接执行。

## 打包 QA

| 稳定入口 | 目标 | 必填环境变量 |
| --- | --- | --- |
| `npm run qa:package:unpacked` | 完整解包目录及空白用户环境 | `CAT_WORKSHOP_PORTABLE_EXE`：解包目录内 EXE 的绝对路径 |
| `npm run qa:package:single-exe` | 单文件便携 EXE 的隔离复制、启动和健康检查 | `CAT_WORKSHOP_SINGLE_EXE`：便携 EXE 的绝对路径 |

两项都会启动被测游戏并创建隔离的 `output/` 用户数据，因此不属于默认静态验收。`qa-fresh-pc-portable.mjs` 的历史文件名保留，但其实际目标是带完整相邻运行时的解包 EXE。

## 在线与人工 QA

`npm run qa:live:deepseek` 会访问真实模型服务，需要本机 `.env` 中的有效密钥和网络；离线发布门禁不得把它当作自动通过项。`qa-deepseek-*.mts`、`qa-deepseek-*.mjs` 以及桌宠操作 JSON 属于模型、安全注入、人工浏览或录制场景专项。

旧入口 `npm run test:deepseek:live` 继续作为兼容别名。

## 报告与研究

`npm run report:progression` 生成进度报告；`generate-*`、`aggregate-*`、`analyze-*`、`measure-*`、`solve-*`、`prove-*`、`export-*` 与远程 shell 脚本用于报告、价格理论、循环证明或批量实验，不是游戏启动依赖。

进度专项稳定入口为 `qa:progression:headless`、`qa:progression:browser` 和 `qa:economy:extreme-tier-prices`；原 `test:progression:*`、`test:extreme-tier-prices`、`report:deepseek-to-35` 均保留为兼容别名。

## 历史与废弃状态

下列文件保留用于复核旧报告或定位历史回归，不再作为当前发布门禁，也不得据此宣称当前版本验收通过：

| 文件 | 状态 | 当前入口或替代方式 |
| --- | --- | --- |
| `generate-0.13.0-acceptance-report.mts`、`qa-0.13.0-acceptance-report-browser.mjs` | 0.13.0 历史归档 | 当前版本使用完整 Vitest、生产构建和分层 QA |
| `qa-market-0.7.mjs`、`qa-landmarks-0.11.mjs` | 版本冻结专项 | 使用当前市场/地标单测及对应浏览器专项 |
| `qa-35.mts`、`qa-35-batch.mts`、`qa-35-diagnose.mts`、`qa-player-35.mts` | 历史探索/诊断入口 | `npm run qa:progression:headless` 与 `npm run qa:progression:browser` |

这些文件暂不删除或移动；只有确认所有外部调用方已迁移后，才可在单独阶段清理。
