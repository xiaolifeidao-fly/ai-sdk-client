// 最小日志：结构化、零依赖。生产可替换 pino。
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min: Level = (process.env.LOG_LEVEL as Level) || "info";

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (order[level] < order[min]) return;
  const line = { time: new Date().toISOString(), level, msg, ...meta };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};
