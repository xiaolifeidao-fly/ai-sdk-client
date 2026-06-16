import type { Request, Response, NextFunction } from "express";
import type { AppConfig } from "../config/schema";
import { log } from "./logger";

// req 上挂的鉴权信息，供后续 handler 写日志
export interface AuthInfo {
  alias: string;
}
export function getAuth(req: Request): AuthInfo | undefined {
  return (req as any).__auth;
}

// 从请求里取 token：优先 Authorization: Bearer <token>，再 x-api-key
function extractToken(req: Request): string | null {
  const authz = req.header("authorization");
  if (authz) {
    const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (m) return m[1].trim();
    return authz.trim(); // 容错：直接给了裸 token
  }
  const apiKey = req.header("x-api-key");
  if (apiKey) return apiKey.trim();
  return null;
}

// 常量时间比较，避免 token 被计时攻击逐字符猜出
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function makeAuthMiddleware(cfg: AppConfig) {
  const { enabled, tokens } = cfg.auth;
  // token → alias 的映射，启动时建好
  const table = new Map<string, string>();
  for (const t of tokens) table.set(t.token, t.alias);

  if (enabled && table.size === 0) {
    log.warn("auth_no_tokens", {
      message: "auth.enabled=true 但没配任何 token，所有请求都会被拒绝。请在 config 的 auth.tokens 下添加。",
    });
  }
  if (!enabled) {
    log.warn("auth_disabled", { message: "auth.enabled=false，鉴权已关闭，任何人都能访问。仅本机自用时这样配。" });
  }

  return function authMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!enabled) {
      (req as any).__auth = { alias: "anonymous" } satisfies AuthInfo;
      return next();
    }

    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({
        error: { code: "missing_token", message: "missing API token (Authorization: Bearer <token> or x-api-key)" },
      });
    }

    // 常量时间逐项比较：不直接用 Map.get，避免命中/未命中耗时差异泄露信息
    let alias: string | null = null;
    for (const [tk, al] of table) {
      if (safeEqual(token, tk)) {
        alias = al;
        break;
      }
    }
    if (!alias) {
      log.warn("auth_rejected", { ip: req.ip, tokenPrefix: token.slice(0, 6) });
      return res.status(401).json({
        error: { code: "invalid_token", message: "invalid API token" },
      });
    }

    (req as any).__auth = { alias } satisfies AuthInfo;
    next();
  };
}
