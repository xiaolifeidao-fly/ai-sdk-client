import PQueue from "p-queue";
import type { AppConfig } from "../config/schema";

export interface SubQueueStats {
  size: number;
  pending: number;
  concurrency: number;
  queueMaxSize: number;
}

export interface QueueStats {
  global: SubQueueStats;
  providers: Record<string, SubQueueStats>;
}

interface SubQueue {
  q: PQueue;
  maxSize: number;
}

/**
 * 两层闸门：
 *   global —— 进程总并发上限，防止单机被打爆
 *   per-provider —— 每个上游独立队列，一家限流不连累别家
 *
 * acquire 流程：先抢 provider 槽位，再抢 global 槽位；任一满了就 503，
 * 任一超时就 503。release 反向释放两个槽位。
 */
export class ConcurrencyGate {
  private global: SubQueue;
  private providers = new Map<string, SubQueue>();

  constructor(cfg: AppConfig) {
    this.global = {
      q: new PQueue({ concurrency: cfg.concurrency.global }),
      maxSize: cfg.concurrency.queueMaxSize,
    };
    for (const [name, pc] of Object.entries(cfg.providers)) {
      this.providers.set(name, {
        q: new PQueue({ concurrency: pc.concurrency ?? cfg.concurrency.global }),
        maxSize: pc.queueMaxSize ?? cfg.concurrency.queueMaxSize,
      });
    }
  }

  stats(): QueueStats {
    const out: QueueStats = {
      global: snapshot(this.global),
      providers: {},
    };
    for (const [name, sub] of this.providers) out.providers[name] = snapshot(sub);
    return out;
  }

  async acquire(
    providerName: string,
    waitTimeoutMs: number,
    signal: AbortSignal
  ): Promise<() => void> {
    const sub = this.providers.get(providerName);
    if (!sub) {
      throw mkErr(500, "unknown_provider", `provider not found: ${providerName}`);
    }

    // 任何一层提前满 → 直接拒
    if (sub.q.size >= sub.maxSize) {
      throw mkErr(503, "queue_full", `provider ${providerName} queue full`);
    }
    if (this.global.q.size >= this.global.maxSize) {
      throw mkErr(503, "queue_full", "global queue full");
    }

    const releaseProvider = await acquireOne(sub, providerName, waitTimeoutMs, signal);
    let releaseGlobal: (() => void) | null = null;
    try {
      releaseGlobal = await acquireOne(this.global, "global", waitTimeoutMs, signal);
    } catch (e) {
      releaseProvider();
      throw e;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGlobal!();
      releaseProvider();
    };
  }

  async onIdle(): Promise<void> {
    await Promise.all([
      this.global.q.onIdle(),
      ...[...this.providers.values()].map((s) => s.q.onIdle()),
    ]);
  }
}

function snapshot(s: SubQueue): SubQueueStats {
  return {
    size: s.q.size,
    pending: s.q.pending,
    concurrency: s.q.concurrency,
    queueMaxSize: s.maxSize,
  };
}

function mkErr(status: number, code: string, message: string) {
  const e: any = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

async function acquireOne(
  sub: SubQueue,
  label: string,
  waitTimeoutMs: number,
  signal: AbortSignal
): Promise<() => void> {
  let release!: () => void;
  let onAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => (onAcquired = resolve));

  sub.q
    .add(
      () =>
        new Promise<void>((resolveTask) => {
          release = resolveTask;
          onAcquired();
        }),
      { signal }
    )
    .catch(() => onAcquired());

  try {
    await Promise.race([
      acquired,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(mkErr(503, "queue_wait_timeout", `${label} queue wait timeout`)),
          waitTimeoutMs
        ).unref()
      ),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  } catch (e) {
    if (typeof release === "function") release();
    throw e;
  }

  return () => release();
}
