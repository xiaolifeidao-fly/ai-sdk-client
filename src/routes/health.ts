import { Router } from "express";
import type { ConcurrencyGate } from "../core/queue";

export function healthRouter(gate: ConcurrencyGate, isShuttingDown: () => boolean) {
  const r = Router();
  r.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  r.get("/readyz", (_req, res) => {
    if (isShuttingDown()) return res.status(503).json({ ok: false, reason: "shutting_down" });
    res.json({ ok: true, queue: gate.stats() });
  });
  return r;
}
