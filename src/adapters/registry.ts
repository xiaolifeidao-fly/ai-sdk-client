import type { AppConfig } from "../config/schema";
import type { ModelAdapter } from "./types";
import { CodexLocalAdapter } from "./codex-local";
import { ClaudeCodeLocalAdapter } from "./claude-code-local";

export interface RouteResolution {
  adapter: ModelAdapter;
  providerName: string;
  upstreamModel: string;
}

function matchGlob(pattern: string, input: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === input;
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
  );
  return re.test(input);
}

export class AdapterRegistry {
  private adapters = new Map<string, ModelAdapter>();
  constructor(private cfg: AppConfig) {
    for (const [name, pc] of Object.entries(cfg.providers)) {
      if (pc.type === "codex_local") this.adapters.set(name, new CodexLocalAdapter(name, pc));
      else if (pc.type === "claude_code_local")
        this.adapters.set(name, new ClaudeCodeLocalAdapter(name, pc));
    }
  }

  resolve(model: string): RouteResolution {
    for (const r of this.cfg.routes) {
      if (matchGlob(r.match, model)) {
        const adapter = this.adapters.get(r.provider);
        if (!adapter) throw new Error(`Provider not found: ${r.provider}`);
        return {
          adapter,
          providerName: r.provider,
          upstreamModel: r.rewriteTo ?? model,
        };
      }
    }
    throw Object.assign(new Error(`No route matched for model: ${model}`), {
      status: 404,
      code: "model_not_found",
    });
  }
}
