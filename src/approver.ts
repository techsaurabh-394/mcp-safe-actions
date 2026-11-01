// Copyright (c) 2026 Saurabh Pathak. MIT License.
import type { Approver } from "./register.js";

export interface WebhookApproverOptions {
  headers?: Record<string, string>;
  /** Abort the HTTP request after this long. Default 5 minutes. Counts as "not approved". */
  timeoutMs?: number;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
}

/**
 * POSTs the plan as JSON to `url` and approves ONLY if the response is HTTP 2xx with JSON `{ "approved": true }`.
 * The endpoint may hold the request open until a person clicks approve in Slack, a ticket, a dashboard, etc.
 * Any error, non-2xx status, bad JSON, timeout or other body means "not approved".
 * Note: a plain Slack *incoming* webhook cannot return an answer. Point this at a small service that can.
 */
export function webhookApprover(url: string, opts: WebhookApproverOptions = {}): Approver {
  const doFetch = opts.fetch ?? fetch;
  return async (req) => {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5 * 60_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { approved?: unknown };
    return body.approved === true;
  };
}
