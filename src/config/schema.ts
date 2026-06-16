import { z } from "zod";

export const ProviderConfigSchema = z.object({
  // relay = 纯透传：把请求原样转发到上游订阅 API，服务器不解析/不执行。
  // codex_local / claude_code_local = 在服务器本机跑 agent（会执行命令、写文件）。
  type: z.enum(["codex_local", "claude_code_local", "relay"]),
  // 可选：不配时服务能正常启动，但实际请求该 provider 会在上游返 401
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  // 仅 type=relay 用：上游鉴权方式
  //   codex_chatgpt = 用本机 codex 订阅登录态（~/.codex/auth.json）直连 ChatGPT 后端（默认）
  //   api_key       = 用 apiKey 作 Bearer（如转发到 sub2api 之类）
  authMode: z.enum(["codex_chatgpt", "api_key"]).optional(),
  // codex_chatgpt 模式的 auth.json 路径，不填走 ~/.codex/auth.json
  authFile: z.string().optional(),
  // 仅作用于该 provider 的并发上限；不填走全局
  concurrency: z.number().int().positive().optional(),
  queueMaxSize: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  // 仅 codex_local 用：本机 codex CLI 的工作目录、沙箱、审批策略等
  codex: z
    .object({
      // 自定义 codex 可执行路径，不填走 PATH
      codexPathOverride: z.string().optional(),
      workingDirectory: z.string().optional(),
      sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
      approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]).optional(),
      // 跳过 git 仓库检查（在非 git 目录跑 codex 时需要）
      skipGitRepoCheck: z.boolean().optional(),
      // 透传额外 --config key=value 给 CLI
      extraConfig: z.record(z.unknown()).optional(),
      // 默认推理强度（快速模式 = minimal）。客户端请求里显式指定 reasoning_effort 时优先用客户端的
      defaultReasoningEffort: z
        .enum(["minimal", "low", "medium", "high", "xhigh"])
        .optional(),
    })
    .optional(),
  // 仅 claude_code_local 用
  claudeCode: z
    .object({
      cwd: z.string().optional(),
      permissionMode: z
        .enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
        .optional(),
      additionalDirectories: z.array(z.string()).optional(),
      allowedTools: z.array(z.string()).optional(),
      disallowedTools: z.array(z.string()).optional(),
      // 默认走 claude_code preset；置 [] 关掉所有工具，纯文本对话
      toolsPreset: z.enum(["claude_code", "none"]).optional(),
      // 自定义 system prompt 覆盖默认
      systemPrompt: z.string().optional(),
      maxTurns: z.number().int().positive().optional(),
    })
    .optional(),
});

export const ModelRouteSchema = z.object({
  // 客户端请求的 model 名（支持通配，如 "claude-*"）
  match: z.string().min(1),
  provider: z.string().min(1),
  // 可选：转发到上游时改写成的 model 名
  rewriteTo: z.string().optional(),
});

// 单个访问凭据：token + 别名（别名仅用于日志/审计，区分是谁在用）
export const AuthTokenSchema = z.object({
  token: z.string().min(1),
  alias: z.string().min(1),
});

export const AuthConfigSchema = z.object({
  // 关掉后不校验任何 token（仅本机自用时用）；多人共享务必开
  enabled: z.boolean().default(true),
  // 接受 token 的请求头：Authorization: Bearer <token> 和 x-api-key 都支持
  tokens: z.array(AuthTokenSchema).default([]),
});

export const AppConfigSchema = z.object({
  server: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().positive().default(8787),
    // 整体请求超时（包含排队 + 上游）
    requestTimeoutMs: z.number().int().positive().default(600_000),
    // 排队等待最长时间
    queueWaitTimeoutMs: z.number().int().positive().default(30_000),
    // SSE 相邻 chunk 最大间隔
    streamIdleTimeoutMs: z.number().int().positive().default(60_000),
    // 优雅关闭时最长等待
    shutdownTimeoutMs: z.number().int().positive().default(30_000),
    // 请求体大小
    bodyLimit: z.string().default("4mb"),
  }),
  concurrency: z.object({
    // 全局并发上限
    global: z.number().int().positive().default(32),
    // 队列长度上限，满了直接 429
    queueMaxSize: z.number().int().positive().default(256),
  }),
  retry: z.object({
    maxAttempts: z.number().int().min(1).default(3),
    baseDelayMs: z.number().int().positive().default(500),
    maxDelayMs: z.number().int().positive().default(8_000),
  }),
  // 访问鉴权：不配则默认 enabled=true 但 tokens 为空 → 所有请求被拒，提醒你配 token
  auth: AuthConfigSchema.default({ enabled: true, tokens: [] }),
  // 调度：默认走纯中转 relay；带 agentHeader 头时才改走服务器 agent 执行。
  // 不配 dispatch → 保持老行为（全部按 routes 走 agent，不开纯中转）。
  dispatch: z
    .object({
      // 默认请求走哪个 provider（必须是 type=relay 的那个）
      relayProvider: z.string().min(1),
      // 带这个请求头（值任意非空，如 "1"）时改走服务器 agent 执行（按 routes 解析 model）
      agentHeader: z.string().default("x-codex-agent"),
    })
    .optional(),
  providers: z.record(z.string(), ProviderConfigSchema),
  // 顺序匹配，命中即用
  routes: z.array(ModelRouteSchema).min(1),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type AuthToken = z.infer<typeof AuthTokenSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelRoute = z.infer<typeof ModelRouteSchema>;
