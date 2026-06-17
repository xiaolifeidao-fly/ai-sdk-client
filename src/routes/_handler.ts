import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/schema";
import type { AdapterRegistry } from "../adapters/registry";
import type { ConcurrencyGate } from "../core/queue";
import type { ChatChunk, ChatRequest } from "../adapters/types";
import { streamWithRetry } from "../core/retry";
import { getAuth } from "../core/auth";
import { proxyRelay } from "../core/relay-proxy";
import { getCodexCreds } from "../core/codex-auth";
import { log } from "../core/logger";

export interface HandleCtx {
  cfg: AppConfig;
  registry: AdapterRegistry;
  gate: ConcurrencyGate;
}

export interface ProtocolBinding {
  // 把原始 body 解析+转换成内部 ChatRequest
  parse: (body: unknown) => ChatRequest;
  // 流式响应
  writeStream: (res: Response, model: string, stream: AsyncIterable<ChatChunk>) => Promise<void>;
  // 同步响应
  writeJson: (res: Response, model: string, stream: AsyncIterable<ChatChunk>) => Promise<void>;
  // 错误响应格式（OpenAI vs Anthropic 形态略有差异）
  errorBody: (status: number, code: string, message: string) => unknown;
  writeSSEHeaders: (res: Response) => void;
}

export function makeHandler(ctx: HandleCtx, binding: ProtocolBinding) {
  return async function handle(req: Request, res: Response) {
    const requestId = (req.header("x-request-id") || randomUUID()).slice(0, 64);
    res.setHeader("x-request-id", requestId);

    const ac = new AbortController();
    // 用 res.on("close") 而不是 req.on("close")：req 是 Readable 流，body 解析完后
    // 也会 emit close，会被误判成客户端断开。res.close 在响应发完或连接异常关闭时
    // 才触发；用 writableEnded 区分正常结束 vs 客户端提前断开。
    const onClose = () => {
      if (res.writableEnded) return;
      if (!ac.signal.aborted) ac.abort(new Error("client_closed"));
    };
    res.on("close", onClose);

    let release: (() => void) | null = null;
    let sseStarted = false;

    const sendError = (status: number, code: string, message: string) => {
      if (sseStarted) {
        // 已经开始流，无法改 status；写一个 SSE error 事件然后结束
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`);
        } catch {}
        try { res.end(); } catch {}
        return;
      }
      if (res.headersSent) {
        try { res.end(); } catch {}
        return;
      }
      res.status(status).json(binding.errorBody(status, code, message));
    };

    try {
      // 0. 调度：默认走纯中转 relay；带 agentHeader 头才走服务器 agent 执行。
      //    不配 dispatch → 跳过，走老的 agent 流程。
      const dispatch = ctx.cfg.dispatch;
      if (dispatch) {
        const agentTriggered = !!req.header(dispatch.agentHeader);
        if (!agentTriggered) {
          const providerName = dispatch.relayProvider;
          const pc = ctx.cfg.providers[providerName];
          if (!pc || pc.type !== "relay" || !pc.baseURL) {
            return sendError(500, "relay_misconfigured", `relayProvider "${providerName}" 不存在或缺 baseURL`);
          }

          // 解析上游鉴权头：默认用本机 codex 订阅登录态直连 ChatGPT 后端
          const authMode = pc.authMode ?? "codex_chatgpt";
          let authHeaders: Record<string, string>;
          try {
            if (authMode === "codex_chatgpt") {
              const creds = await getCodexCreds(pc.authFile);
              // 单账号多人共享：session_id 必须带上用户身份，否则两个客户端发了相同的
              // x-request-id 时会落进上游同一个 session，被后端并成一段对话（串话）。
              // 加 alias 前缀后，不同用户的 session_id 必然不同，上游层面互不可见。
              const alias = getAuth(req)?.alias ?? "anon";
              const sessionId = `${alias}-${requestId}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128);
              authHeaders = {
                authorization: `Bearer ${creds.accessToken}`,
                "chatgpt-account-id": creds.accountId,
                "openai-beta": "responses=experimental",
                originator: "codex_cli_rs",
                "user-agent": "codex_cli_rs",
                session_id: sessionId,
              };
            } else {
              authHeaders = pc.apiKey ? { authorization: `Bearer ${pc.apiKey}` } : {};
            }
          } catch (e: any) {
            return sendError(502, "relay_auth_failed", e?.message ?? "relay auth failed");
          }

          release = await ctx.gate.acquire(providerName, ctx.cfg.server.queueWaitTimeoutMs, ac.signal);
          log.info("request_start", {
            requestId,
            alias: getAuth(req)?.alias,
            mode: "relay",
            authMode,
            provider: providerName,
            path: req.path,
            queue: ctx.gate.stats(),
          });
          await proxyRelay({ req, res, baseURL: pc.baseURL, authHeaders, signal: ac.signal, requestId });
          log.info("request_done", { requestId, mode: "relay" });
          return;
        }
      }

      // 1. 解析请求体
      let internal: ChatRequest;
      try {
        internal = binding.parse(req.body);
      } catch (e: any) {
        return sendError(400, "invalid_request", e?.message ?? "invalid request body");
      }

      // 2. 解析路由
      const route = ctx.registry.resolve(internal.model);
      const upstreamReq: ChatRequest = { ...internal, model: route.upstreamModel };

      // 3. 获取并发槽（先 provider 后 global）
      release = await ctx.gate.acquire(
        route.providerName,
        ctx.cfg.server.queueWaitTimeoutMs,
        ac.signal
      );

      log.info("request_start", {
        requestId,
        alias: getAuth(req)?.alias,
        clientModel: internal.model,
        upstreamModel: route.upstreamModel,
        provider: route.providerName,
        stream: internal.stream,
        queue: ctx.gate.stats(),
      });

      // 4. 调用 adapter（带流式重试）
      const upstreamStream = streamWithRetry(ctx.cfg.retry, ac.signal, () =>
        route.adapter.chatStream(upstreamReq, { signal: ac.signal, requestId })
      );

      // 5. 写响应（注意 stream idle 守护）
      if (internal.stream) {
        binding.writeSSEHeaders(res);
        sseStarted = true;
        await pipeWithIdleGuard(
          upstreamStream,
          ctx.cfg.server.streamIdleTimeoutMs,
          ac,
          (s) => binding.writeStream(res, internal.model, s)
        );
      } else {
        await binding.writeJson(res, internal.model, upstreamStream);
      }

      log.info("request_done", { requestId });
    } catch (e: any) {
      const status = e?.status ?? 500;
      const code = e?.code ?? "internal_error";
      const message = e?.message ?? "internal error";
      log.warn("request_error", { requestId, status, code, message });
      sendError(status, code, message);
    } finally {
      res.off("close", onClose);
      if (release) release();
    }
  };
}

// SSE 相邻 chunk 间隔守护：超过 idleMs 没新 chunk → 抛错并 abort
async function pipeWithIdleGuard<T>(
  src: AsyncIterable<T>,
  idleMs: number,
  ac: AbortController,
  consume: (s: AsyncIterable<T>) => Promise<void>
) {
  const iter = (src as any)[Symbol.asyncIterator]() as AsyncIterator<T>;

  async function* guarded(): AsyncIterable<T> {
    while (true) {
      let timer: NodeJS.Timeout | null = null;
      try {
        const result = await Promise.race([
          iter.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const e: any = new Error("Stream idle timeout");
              e.status = 504;
              e.code = "stream_idle_timeout";
              if (!ac.signal.aborted) ac.abort(e);
              reject(e);
            }, idleMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (result.done) return;
        yield result.value;
      } catch (e) {
        if (timer) clearTimeout(timer);
        // 尝试 cleanup 底层 iterator
        try { await iter.return?.(undefined as any); } catch {}
        throw e;
      }
    }
  }

  await consume(guarded());
}
