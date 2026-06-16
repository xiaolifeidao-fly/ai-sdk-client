import type { AppConfig } from "../config/schema";

function isRetryable(err: any): boolean {
  if (!err) return false;
  const status = err.status ?? err.statusCode;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // 网络层错误
  const code = err.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
  return false;
}

export async function withRetry<T>(
  cfg: AppConfig["retry"],
  signal: AbortSignal,
  fn: (attempt: number) => Promise<T>
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (signal.aborted) throw signal.reason;
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= cfg.maxAttempts || !isRetryable(err)) throw err;
      const delay = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * delay * 0.2;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay + jitter);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(signal.reason);
        }, { once: true });
      });
    }
  }
  throw lastErr;
}

/**
 * 流式重试：只在第一个 chunk 产出前重试；一旦下游收到任何字节，错误直接抛出。
 */
export async function* streamWithRetry<T>(
  cfg: AppConfig["retry"],
  signal: AbortSignal,
  makeStream: (attempt: number) => AsyncIterable<T>
): AsyncIterable<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (signal.aborted) throw signal.reason;
    let yielded = false;
    try {
      for await (const c of makeStream(attempt)) {
        yielded = true;
        yield c;
      }
      return;
    } catch (err) {
      lastErr = err;
      if (yielded || attempt >= cfg.maxAttempts || !isRetryable(err)) throw err;
      const delay = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * delay * 0.2;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay + jitter);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(signal.reason);
        }, { once: true });
      });
    }
  }
  throw lastErr;
}
