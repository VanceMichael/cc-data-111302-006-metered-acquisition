# 来源协议

POST /purchase 接受 requestId、purpose、version、maxPrice。供应商首次受理即建立披露事实并扣费，重用相同 requestId 只返回同一事实；改变用途或版本返回409。pending 时显示 charged_waiting，否则可领取。dropResponse 在受理后断开连接。GET /orders/:id 查单；GET /results/:id 只有ready可取。取消本地需求不等于供应商退款。POST /control 可改变报价、资料版本、响应丢失和准备状态。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
