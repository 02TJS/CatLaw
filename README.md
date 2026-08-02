# 猫咪工坊 CatLaw2

法条驱动的自动化制造沙盒。玩家通过自然语言法条影响猫咪共享决策逻辑，在带私人产权、税收、信用、有偿物流和 65 种商品科技树的等距世界中建设工坊。

当前版本：`0.11.2`

## Windows 下载即玩

### [⬇️ 下载 CatWorkshop.exe](https://github.com/TingJShen/CatLaw2/releases/latest/download/CatWorkshop.exe)

下载后双击即可运行，不需要安装 Node.js、npm 或浏览器。完整发布页与 SHA-256 校验文件见 [Releases](https://github.com/TingJShen/CatLaw2/releases/latest)。

- 65 种商品通用玩家仓库
- 6 种玩家地标工程与范围叠层加成
- `1/2/3/4` 切换 `1x/2x/4x/8x`；`P` 暂停
- 猫咪可原子删除：清算资产、先还贷款、净额进入国库
- 五档累计难度与空间工业建筑
- 难度 5 第 22–30 项沿用订单、信用和价格体系：高价溢价会传导到配料作业报价
- React + TypeScript + Vite + Canvas 2D
- Electron Windows 桌面版
- Express DeepSeek 法条编译代理

完整中文说明请打开 [README.html](README.html)，基础操作见 [CatWorkshop-Operation-Guide.html](CatWorkshop-Operation-Guide.html)，最高难度前 35 项的真实操作记录见 [CatWorkshop-Difficulty5-35-Operation.html](CatWorkshop-Difficulty5-35-Operation.html)。

```powershell
npm install
npm run dev
```

本地访问：<http://127.0.0.1:5173>

> `.env`、Windows EXE、Electron 运行时、构建目录和测试输出不会提交到 Git。请仅在本机 `.env` 中配置已经轮换的 `DEEPSEEK_API_KEY`。
