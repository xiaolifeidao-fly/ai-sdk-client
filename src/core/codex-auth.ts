import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger";

// 本机 codex ChatGPT 订阅登录态（~/.codex/auth.json）→ 直连 ChatGPT 后端所需的鉴权。
// 服务器不跑 agent，只拿这套 token 把模型能力中转出去。

// codex 的 OAuth client_id（与 auth.json 里 id_token 的 aud 一致，刷新时要用）
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
// access_token 剩余有效期低于这个阈值就提前刷新
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface CodexCreds {
  accessToken: string;
  accountId: string;
}

function defaultAuthPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

// 解析 JWT 的 exp（秒）。解不出来返回 0（按"需要刷新"处理）
function jwtExpMs(token: string): number {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// 简单的进程内串行化：避免并发请求同时触发刷新、互相覆盖 auth.json
let refreshChain: Promise<void> = Promise.resolve();

async function refreshTokens(path: string, auth: CodexAuthFile): Promise<CodexAuthFile> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) throw new Error("auth.json 缺 refresh_token，无法刷新；请在服务器重新 codex login");

  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email offline_access",
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`刷新 codex token 失败 ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = (await resp.json()) as any;

  const next: CodexAuthFile = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: data.access_token ?? auth.tokens?.access_token,
      id_token: data.id_token ?? auth.tokens?.id_token,
      // 刷新接口可能轮换 refresh_token，有就更新
      refresh_token: data.refresh_token ?? auth.tokens?.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };
  // 原子写回：先写临时文件再 rename，避免写一半被读到
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await (await import("node:fs/promises")).rename(tmp, path);
  log.info("codex_token_refreshed", { path });
  return next;
}

// 取可用的订阅鉴权：必要时自动刷新并写回 auth.json
export async function getCodexCreds(authFile?: string): Promise<CodexCreds> {
  const path = authFile?.replace(/^~(?=$|\/)/, homedir()) ?? defaultAuthPath();

  let auth: CodexAuthFile;
  try {
    auth = JSON.parse(await readFile(path, "utf8"));
  } catch (e: any) {
    throw new Error(`读不到 codex 登录态 ${path}: ${e?.message}（服务器需先 codex login）`);
  }

  if (auth.auth_mode && auth.auth_mode !== "chatgpt") {
    throw new Error(`auth.json auth_mode=${auth.auth_mode}，不是 chatgpt 订阅登录`);
  }

  let access = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!access || !accountId) throw new Error("auth.json 缺 access_token / account_id");

  // 过期或临近过期 → 串行刷新一次
  if (jwtExpMs(access) - Date.now() < REFRESH_SKEW_MS) {
    refreshChain = refreshChain.then(
      async () => {
        // 链上轮到自己时再读一遍：可能已被前一个请求刷过了
        const cur: CodexAuthFile = JSON.parse(await readFile(path, "utf8"));
        const curAccess = cur.tokens?.access_token ?? "";
        if (jwtExpMs(curAccess) - Date.now() >= REFRESH_SKEW_MS) {
          auth = cur;
          return;
        }
        auth = await refreshTokens(path, cur);
      },
      () => {}
    );
    await refreshChain;
    access = auth.tokens?.access_token;
    if (!access) throw new Error("刷新后仍无 access_token");
  }

  return { accessToken: access, accountId: accountId! };
}
