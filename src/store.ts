// Copyright (c) 2026 Saurabh Pathak. MIT License.
import { createHash, randomBytes } from "node:crypto";

/** JSON with sorted keys, so the same arguments always hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

export interface StoreOptions {
  /** How long a token stays valid. Default 5 minutes. */
  ttlMs?: number;
  /** Most tokens kept at once; the oldest is dropped first. Default 100. */
  maxPending?: number;
  /** Clock, replaceable in tests. */
  now?: () => number;
}

interface Pending {
  tool: string;
  argsHash: string;
  expiresAt: number;
}

export type ConsumeResult = { ok: true } | { ok: false; reason: "unknown" | "expired" | "mismatch" };

/** One-time approval tokens, each bound to one tool and one exact set of arguments. */
export class ApprovalStore {
  private readonly pending = new Map<string, Pending>();
  readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;

  constructor(opts: StoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxPending = opts.maxPending ?? 100;
    this.now = opts.now ?? Date.now;
  }

  issue(tool: string, args: unknown): { token: string; expiresAt: number } {
    this.prune();
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const token = `approve_${randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { tool, argsHash: hashArgs(args), expiresAt });
    return { token, expiresAt };
  }

  /** Valid only once, only for the same tool and arguments, only before it expires. */
  consume(token: string, tool: string, args: unknown): ConsumeResult {
    const entry = this.pending.get(token);
    if (!entry) return { ok: false, reason: "unknown" };
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(token);
      return { ok: false, reason: "expired" };
    }
    if (entry.tool !== tool || entry.argsHash !== hashArgs(args)) return { ok: false, reason: "mismatch" };
    this.pending.delete(token);
    return { ok: true };
  }

  size(): number {
    this.prune();
    return this.pending.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [token, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(token);
  }
}
