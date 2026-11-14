# 来源协议与采购控制

本项目的供应商是**本地合成来源**，不连接真实账户、设备或付费接口。采集端
(`SourceClient`) 只接受 `http://` 回环地址（`127.0.0.1`、`localhost`、`::1`），
任何真实付费地址都会在构造客户端时被拒绝。

## 来源接口

| 方法与路径 | 语义 |
| --- | --- |
| `POST /purchase` | 接受 `requestId`、`purpose`、`version`、`maxPrice`。首次受理即建立披露事实并扣费；重用相同 `requestId` 只返回同一事实，不重复扣费；改变用途或版本返回 `409`。报价高于 `maxPrice` 返回 `402` 且不建立披露。`dropResponse` 在受理后断开连接。 |
| `GET /quote` | 返回当前 `price` 与 `datasetVersion`。 |
| `GET /orders/:id` | 按请求号查单。`404` 表示来源从未受理；`200` 返回已受理事实（已收费）。 |
| `GET /results/:id` | 只有 `ready` 可取，未就绪返回 `409`。 |
| `GET /inventory`、`GET /state` | 本地目录与来源状态。 |
| `GET /health` | 存活检查。 |
| `POST /control` | 只接受 `price`、`datasetVersion`、`pending`、`dropResponse`、`complete`。未知字段返回 `400`；不能直接改写 `orders`。 |

`/state`、`/control` 是本地来源模拟设施，不是采集业务的写入接口。

## 采购单与领取

采购单（`AcquisitionEngine.defineOrder`）包含：

- `purpose`：授权用途。披露结果只能在同一用途下复用。
- `version`：可接受资料版本。来源当前 `datasetVersion` 不符时领取失败。
- `budget`：预算，整数最小货币单位。**只约束本采购单**；不读取、不借用其他采购单的额度。
- `deadline`：截止时间。过后不再发送；已发送的披露继续核销。

每条领取（line）有稳定、唯一的 `requestId`，重试永远复用同一个请求号。

## 费用阶段与对账口径

| 阶段 | 含义 | 计入 |
| --- | --- | --- |
| `planned` | 已排队，未预占 | 不占额度 |
| `reserved` | 已按报价预占 | `reserved` |
| `sending` | 已持久化发送标记，请求可能已离开进程 | `reserved`（并显示为 `unknownAmount`） |
| `unknown` | 发送失败或响应丢失，查单未成功 | `reserved`（并显示为 `unknownAmount`） |
| `charged_waiting` | 来源已收费，结果尚不可取 | `actual` |
| `charged` | 已收费，等待取回原文 | `actual` |
| `ready` | 已取得原始资料 | `actual` |
| `released` | 未发送或查单确认从未受理，额度已归还 | `released` |
| `failed` | 预算不足、版本不符或来源拒绝 | 不扣费 |

采购单明细的恒等式：`committed = reserved + actual`，`available = budget - committed`。
报告同时列出 `released`（释放）、`unknownAmount`（未知费用）和 `overage`
（来源最终报价超过本单预算、且无法再预占的差额）。每条领取带有 `requestId`、
`disclosureId`、报价、`maxPrice` 与完整尝试记录。

## 关键行为

1. **发送前预占**：先按 `/quote` 报价预占，再以该报价作为 `maxPrice` 发送。
   来源最终报价若低于预占，差额释放；若高于预占，先从**本单**剩余预算补足，
   补不足的部分记为 `overage` 并保留证据。
2. **响应丢失**：任何发送异常、无响应或格式异常都先记为 `unknown`，再调用
   `GET /orders/:requestId` 查单。已受理则核销并继续取结果；`404` 才释放。
   **绝不**因为“没拿到响应”就换请求号重买。
3. **结果未就绪**：已收费但 `GET /results` 返回 `409` 时保持 `charged_waiting`，
   继续按同一请求号轮询，不产生新购买。
4. **重启恢复**：发送标记和请求号在 HTTP 请求发出前已 fsync 落盘。启动时
   `recover()` 只对 `sending`/`unknown` 查单、对 `charged*` 取结果，从不 POST 新购买。
5. **取消**：未发送的排队领取立即释放；已发送未确认的先查单；已收费的披露
   保留扣费并继续取回原文，不做“假设退款”。
6. **复用**：同一 `entityKey` 的披露，只有在**用途相同、版本相同、结果已取得且未过期**
   时才可复用；内容相同但用途不同必须重新购买。复用不增加实际扣费。
7. **人工处理**：`resolveUnknown` 只接受 `unknown`/`sending` 状态的领取，
   要求 `operator` 与 `evidence`，可选结果原文；处理动作写入 `line.manual_resolution`
   审计事件。`outcome=requery` 仅重试查单。

## 持久化

账本默认位于 `.local/ledger.json`（可用 `LEDGER_PATH` 覆盖）。每次状态变更都
以“临时文件 + fsync + 原子 rename”写入，且事务串行化；被拒绝的变更（如预算不足）
不会写盘，也不会消耗额度。账本 schema 损坏时启动失败，而不是当成空账本覆盖。
