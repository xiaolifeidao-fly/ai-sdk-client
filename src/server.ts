import express from "express";
import http from "node:http";
import { loadConfig } from "./config";
import { AdapterRegistry } from "./adapters/registry";
import { ConcurrencyGate } from "./core/queue";
import { makeAuthMiddleware } from "./core/auth";
import { chatRouter } from "./routes/v1-chat";
import { responsesRouter } from "./routes/v1-responses";
import { messagesRouter } from "./routes/v1-messages";
import { healthRouter } from "./routes/health";
import { log } from "./core/logger";

function main() {
  const cfg = loadConfig();
  const registry = new AdapterRegistry(cfg);
  const gate = new ConcurrencyGate(cfg);

  let shuttingDown = false;
  const isShuttingDown = () => shuttingDown;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: cfg.server.bodyLimit }));

  // 请求总超时（保险：socket 级别）
  app.use((req, res, next) => {
    res.setTimeout(cfg.server.requestTimeoutMs, () => {
      if (!res.headersSent) {
        res.status(504).json({ error: { code: "request_timeout", message: "request timeout" } });
      } else {
        try { res.end(); } catch {}
      }
    });
    next();
  });

  app.use(healthRouter(gate, isShuttingDown));

  // 鉴权闸门：health 之后挂，业务路由都要带合法 token
  app.use(makeAuthMiddleware(cfg));

  app.use(chatRouter({ cfg, registry, gate }));
  app.use(responsesRouter({ cfg, registry, gate }));
  app.use(messagesRouter({ cfg, registry, gate }));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "route not found" } });
  });

  // 全局错误兜底
  app.use(((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error("unhandled_error", { message: err?.message, stack: err?.stack });
    if (res.headersSent) {
      try { res.end(); } catch {}
      return;
    }
    res.status(err?.status ?? 500).json({
      error: { code: err?.code ?? "internal_error", message: err?.message ?? "internal error" },
    });
  }) as express.ErrorRequestHandler);

  const server = http.createServer(app);
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  server.requestTimeout = 0; // 走我们自己的 res.setTimeout

  server.listen(cfg.server.port, cfg.server.host, () => {
    log.info("server_listen", {
      host: cfg.server.host,
      port: cfg.server.port,
      concurrency: cfg.concurrency.global,
      queueMaxSize: cfg.concurrency.queueMaxSize,
    });
  });

  // 优雅关闭
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown_start", { signal: sig });
    server.close((err) => {
      if (err) log.error("server_close_error", { message: err.message });
    });
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        log.warn("shutdown_timeout_force_exit");
        resolve();
      }, cfg.server.shutdownTimeoutMs).unref()
    );
    await Promise.race([gate.onIdle(), timeout]);
    log.info("shutdown_done");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    log.error("unhandled_rejection", { reason: String(reason) });
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaught_exception", { message: err.message, stack: err.stack });
  });
}

main();
