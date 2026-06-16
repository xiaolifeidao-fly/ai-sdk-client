# ai-sdk-client

HTTP relay for Anthropic + OpenAI SDKs. 双协议入口（OpenAI / Anthropic），统一并发控制 + 流式透传 + 优雅关闭。

## 快速开始

```bash
cp .env.example .env   # 填上 API key
npm install
npm run dev            # tsx watch
# 或
npm run build && npm start
```

默认监听 `http://0.0.0.0:8787`。

## 暴露的端点

| 路径 | 协议 | 用途 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容 | cc switch / codex 客户端 |
| `POST /v1/messages` | Anthropic 兼容 | Claude 客户端 |
| `GET /healthz` | - | 存活检查 |
| `GET /readyz` | - | 就绪检查，含队列状态 |

两个入口都支持 `stream: true`（SSE）和同步 JSON。

## 路由规则

`config.yaml` 里的 `routes` 按顺序匹配客户端发来的 `model` 字段，命中即用对应 provider。支持 `*` 通配。可用 `rewriteTo` 改写上游真实 model 名。

```yaml
routes:
  - match: "claude-*"
    provider: anthropic_main
  - match: "gpt-4o"
    provider: openai_main
    rewriteTo: "gpt-4o-2024-08-06"
```

## 并发与超时

- `concurrency.global`: 全局并发上限（默认 32）
- `concurrency.queueMaxSize`: 队列长度上限，满了直接 503
- `server.queueWaitTimeoutMs`: 排队等待最长时间
- `server.streamIdleTimeoutMs`: SSE 相邻 chunk 间隔上限，防上游卡死
- `server.requestTimeoutMs`: 单请求总超时

## 重试

默认对 429 / 5xx / 网络错误做指数退避（jitter）。**流式响应一旦开始输出，后续错误不再重试**——避免客户端收到部分 chunk 后再重发。

## 取消传播

客户端断开（`req.close`）会触发 `AbortController.abort`，向下传到 SDK 调用，最终释放并发槽。**不会出现僵尸请求占住槽位**。

## 优雅关闭

收到 `SIGTERM` / `SIGINT` 后：
1. `/readyz` 立刻返回 503
2. 停止 accept 新连接
3. 等待存量请求完成（最长 `shutdownTimeoutMs`）
4. 退出

## 已知限制（首版）

- tool_use 在 OpenAI ↔ Anthropic 协议间未做完整字段映射，只在同协议内透传
- 多模态（image / audio content blocks）未做协议间转换
- 暂无鉴权层（按规划跳过）
- 暂无 metrics / tracing（按规划跳过）

## cc switch 接入

cc switch 配置一个新的"中转站"，base URL 指向 `http://你的机器:8787`，API key 随便填（首版无鉴权），model 列表写真实 model 名（如 `claude-sonnet-4-5`、`gpt-4o`）即可。
