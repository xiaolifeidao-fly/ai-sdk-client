import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import dotenv from "dotenv";
import { AppConfigSchema, type AppConfig } from "./schema";

dotenv.config();

// 把 ${ENV_VAR} 占位符替换成 process.env 里的值
function expandEnv(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => {
      // 缺失 env var 时返回空串而不是抛错；具体字段是否必填交给 zod schema 判
      return process.env[k] ?? "";
    });
  }
  if (Array.isArray(obj)) return obj.map(expandEnv);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = expandEnv(v);
    return out;
  }
  return obj;
}

export function loadConfig(configPath?: string): AppConfig {
  const file =
    configPath ??
    process.env.CONFIG_PATH ??
    path.resolve(process.cwd(), "config.yaml");

  if (!fs.existsSync(file)) {
    throw new Error(`Config file not found: ${file}`);
  }
  const raw = yaml.load(fs.readFileSync(file, "utf8"));
  const expanded = expandEnv(raw);
  const parsed = AppConfigSchema.safeParse(expanded);
  if (!parsed.success) {
    throw new Error(
      `Invalid config: ${JSON.stringify(parsed.error.format(), null, 2)}`
    );
  }
  // 校验每个 route 的 provider 存在
  for (const r of parsed.data.routes) {
    if (!parsed.data.providers[r.provider]) {
      throw new Error(
        `Route "${r.match}" references unknown provider "${r.provider}"`
      );
    }
  }
  return parsed.data;
}
