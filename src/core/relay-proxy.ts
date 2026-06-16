import type { Request, Response } from "express";
import { log } from "./logger";

// 纯透传：把客户端请求原样转发到上游模型 API，再把上游响应（含 SSE 流）原样写回。
// 服务器不解析 body、不做协议转换、不执行任何命令 —— 干活全在客户端本地。
export async function proxyRelay(opts: {
  req: Request;
  res: Response;
  baseURL: string;            // 上游前缀，可带 path（如 https://chatgpt.com/backend-api/codex）
  authHeaders: Record<string, string>; // 鉴权及上游所需的额外头
  signal: AbortSignal;
  requestId: string;
}): Promise<void> {
  const { req, res, baseURL, authHeaders, signal, requestId } = opts;

  // 路径拼接：剥掉客户端的 /v1 前缀，接到上游 baseURL 后面。
  //   sub2api:  baseURL=.../v1            + /responses        → .../v1/responses
  //   chatgpt:  baseURL=/backend-api/codex + /responses        → /backend-api/codex/responses
  const base = baseURL.replace(/\/+$/, "");
  const subPath = req.path.replace(/^\/v1(?=\/)/, "");
  const qsIdx = req.originalUrl.indexOf("?");
  const qs = qsIdx >= 0 ? req.originalUrl.slice(qsIdx) : "";
  const url = base + subPath + qs;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: req.header("accept") || "text/event-stream",
    ...authHeaders,
  };

  const body = JSON.stringify(req.body ?? {});
  log.debug("relay_forward", { requestId, url, bytes: body.length });

  const upstream = await fetch(url, { method: "POST", headers, body, signal });

  res.status(upstream.status);
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("content-type", ct);
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = (upstream.body as any).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch (e: any) {
    if (!signal.aborted) log.warn("relay_stream_error", { requestId, message: e?.message });
  } finally {
    try { res.end(); } catch {}
  }
}
