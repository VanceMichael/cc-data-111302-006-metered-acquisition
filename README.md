# 按披露计费的数据源领取与费用核销

内部数据接入项目。包含一个本地合成供应商、一层与财务对得上的采购控制，以及
一个本地对账台。供应商、资料和页面数据均为合成内容，不连接真实账户、设备或
付费接口；`SourceClient` 会拒绝任何非回环地址，测试也不会调用真实付费 API。

## 环境与命令

Node.js 22.22.1 或更新的 22.x，依赖由 package-lock.json 锁定。

```sh
npm ci --ignore-scripts
npm run build
npm test
npm start          # 同时启动合成来源与对账台
npm run demo       # 演示报价上涨、响应丢失、取消交错、重启恢复与复用
```

`npm start` 在标准输出打印来源地址、对账台地址和账本路径：

```json
{"source":"http://127.0.0.1:...","console":"http://127.0.0.1:...","ledger":".local/ledger.json","status":"来源与采购控制台就绪"}
```

可通过 `HOST`、`PORT`（来源）、`CONSOLE_PORT`、`LEDGER_PATH`、`LOCAL_DIR`
指定监听地址、端口与账本位置。默认只绑定本机回环地址和动态端口。

```sh
docker build -t metered-acquisition:local .
docker run --rm --network none metered-acquisition:local
docker run --rm --network none metered-acquisition:local npm run demo
```

依赖在镜像构建阶段安装，运行阶段不需要公网。

## 目录

- `src/source.mjs`：本地合成供应商（按披露计费）。
- `src/client.mjs`：来源 HTTP 客户端；拒绝非回环地址。
- `src/engine.mjs`：采购单、预占、查单核销、取消、复用与人工处理。
- `src/store.mjs`、`src/atomic.mjs`：原子落盘的账本。
- `src/console.mjs`、`docs/console.html`：本地对账台与操作 API。
- `src/serve.mjs`、`src/demo.mjs`：启动入口与演示。
- `fixtures/source.json`：来源初始状态。
- `docs/source-contract.md`：协议、费用阶段与对账口径。
- `test/`：来源契约、采购控制、重启恢复、控制台测试。

## 对账台

启动后打开打印出的 `console` 地址：

- 新建采购单（预算、授权用途、资料版本、截止时间）。
- 查看每张采购单的预占、实际扣费、释放、未知费用、可用额度与逐条领取明细。
- 查看披露记录（用途、版本、扣费、取得时间、复用截止、原文 SHA-256）。
- 在“未知费用”区域重新查单或录入人工处理依据；取消采购单。
- 查看每条领取对应的原始资料字节（base64 原文与 SHA-256）。

运行时状态仅用于模拟，重启供应商会回到 fixtures 的值；接入业务自己的持久状态
请使用 `.local/` 或明确的外部路径。来源管理入口 `/state` 和 `/control` 只用于
复现来源演进，不是业务写入捷径。
