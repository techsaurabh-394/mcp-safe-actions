// Copyright (c) 2026 Saurabh Pathak. MIT License.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type AuditEventName = "previewed" | "approved" | "declined" | "executed" | "failed" | "rejected" | "blocked";

export interface AuditEvent {
  time: string;
  tool: string;
  event: AuditEventName;
  mode: "elicit" | "token";
  /** Short human-readable plan. Raw arguments are never logged (they may contain secrets). */
  summary?: string;
  argsHash?: string;
  detail?: string;
}

export type AuditSink = (event: AuditEvent) => void;

/** Append one JSON line per event. Logging problems never block the tool. */
export function fileAudit(file: string): AuditSink {
  return (event) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
    } catch {
      /* ignore */
    }
  };
}
