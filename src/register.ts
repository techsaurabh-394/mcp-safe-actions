// Copyright (c) 2026 Saurabh Pathak. MIT License.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AuditSink } from "./audit.js";
import { ApprovalStore, hashArgs } from "./store.js";

export interface ApprovalRequest {
  tool: string;
  summary: string;
  details: string[];
  argsHash: string;
}
export type Approver = (req: ApprovalRequest) => boolean | Promise<boolean>;

export type ConfirmMode = "auto" | "elicit" | "token" | "channel";

export interface Preview {
  /** One clear sentence a person can approve, e.g. "Delete report.pdf (1.2 MB)". */
  summary: string;
  /** Optional extra lines shown under the summary. */
  details?: string[];
}

/** What the server looked up about the target of a call, e.g. { label: "Pay now", role: "button", url: "https://shop/checkout" }. */
export type ResolvedContext = Record<string, unknown>;

/** Gate on what the target IS, not on the tool name. If any string value in `fields` (default: all) matches `pattern`, `autoApprove` is skipped and a human decides. */
export interface ContextGate {
  pattern: RegExp;
  fields?: string[];
}

export interface ConfirmedToolConfig<Shape extends z.ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: Shape;
  /** Must not change anything. Describe exactly what execute() will do. */
  preview: (args: z.infer<z.ZodObject<Shape>>) => Preview | Promise<Preview>;
  /** Runs only after the user approved. */
  execute: (args: z.infer<z.ZodObject<Shape>>) => CallToolResult | Promise<CallToolResult>;
  /** "destructive" (default) deletes or overwrites; "write" changes things without destroying them. */
  risk?: "destructive" | "write";
  /**
   * auto  (default): ask the user through MCP elicitation if the client supports it, otherwise use a one-time token.
   * elicit: require elicitation. Clients without it get a refusal and nothing changes.
   * token : always use the two-step token flow.
   * channel: ask an out-of-band `approver` (webhook, Slack bot, ...) instead of the client. For headless servers. Requires `approver`.
   * Note: `autoApprove` is ignored in "elicit" mode, because that mode means a human must always decide.
   */
  mode?: ConfirmMode;
  store?: ApprovalStore;
  audit?: AuditSink;
  annotations?: ToolAnnotations;
  /** How long to wait for the human to answer the approval prompt. Default 5 minutes. A timeout counts as "not approved". */
  approvalTimeoutMs?: number;
  /**
   * Optional policy: return exactly `true` to run a LOW-RISK call without asking a human
   * (e.g. a file under ./tmp). Anything else, including a thrown error, falls back to the normal
   * approval flow (fail closed). Keep it strict: it is a bypass of the human gate. It runs after
   * preview(), and the decision is logged as "auto-approved".
   */
  /**
   * Approval channel for `mode: "channel"`. Receives the plan and must resolve to exactly `true` to approve.
   * A rejection, a throw, a timeout or any other value means "not approved" (fail closed).
   */
  approver?: Approver;
  /**
   * Optional lookup run before the policy: resolve what the call actually targets (e.g. the label of the element
   * behind click(element_id)). Must return a plain object. If it throws, times out or returns anything else, the
   * `autoApprove` bypass is skipped and a human decides (fail closed). The result is passed to `autoApprove`
   * as a third argument and shown to the human in the approval prompt.
   */
  resolve?: (args: z.infer<z.ZodObject<Shape>>) => ResolvedContext | Promise<ResolvedContext>;
  /** Used with `resolve`: if the resolved context matches, `autoApprove` is skipped. Runs before `autoApprove`. */
  gate?: ContextGate;
  autoApprove?: (args: z.infer<z.ZodObject<Shape>>, plan: Preview, context?: ResolvedContext) => boolean | Promise<boolean>;
}

export function isPlainObject(v: unknown): v is ResolvedContext {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True if any selected string value matches the gate pattern. Global/sticky flags are stripped so results never depend on lastIndex. */
export function contextMatchesGate(ctx: ResolvedContext, gate: ContextGate): boolean {
  const re = new RegExp(gate.pattern.source, gate.pattern.flags.replace(/[gy]/g, ""));
  const keys = gate.fields ?? Object.keys(ctx);
  return keys.some((k) => typeof ctx[k] === "string" && re.test(ctx[k] as string));
}

const text = (t: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true } : {}),
});

export function formatPlan(p: Preview): string {
  return [p.summary, ...(p.details ?? []).map((d) => `  - ${d}`)].join("\n");
}

function clientCanElicit(server: McpServer): boolean {
  const e = server.server.getClientCapabilities()?.elicitation as { form?: unknown; url?: unknown } | undefined;
  if (!e) return false;
  return e.form !== undefined || e.url === undefined; // `elicitation: {}` means form mode
}

/**
 * Register a tool that never changes anything until a person approves.
 * The model cannot approve its own action when the client supports elicitation.
 */
export function registerConfirmedTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  cfg: ConfirmedToolConfig<Shape>
): { store: ApprovalStore } {
  if ("confirm_token" in cfg.inputSchema) {
    throw new Error('"confirm_token" is reserved by mcp-safe-actions. Rename that input.');
  }
  if (cfg.gate && !cfg.resolve) {
    throw new Error("`gate` needs a `resolve` function to look up the target first.");
  }
  if (cfg.mode === "channel" && !cfg.approver) {
    throw new Error('mode "channel" needs an `approver` (see webhookApprover).');
  }
  const store = cfg.store ?? new ApprovalStore();
  const risk = cfg.risk ?? "destructive";
  const mode: ConfirmMode = cfg.mode ?? "auto";
  const emit = (event: Parameters<AuditSink>[0]["event"], m: "elicit" | "token" | "policy" | "channel", extra: { summary?: string; argsHash?: string; detail?: string } = {}) =>
    cfg.audit?.({ time: new Date().toISOString(), tool: cfg.name, event, mode: m, ...extra });

  const shape = {
    ...cfg.inputSchema,
    confirm_token: z
      .string()
      .optional()
      .describe("Only for clients without approval prompts: the one-time token from the preview step. Never invent one."),
  };

  const description =
    `${cfg.description}\n\n` +
    (risk === "destructive" ? "DESTRUCTIVE: " : "CHANGES DATA: ") +
    "the user must approve before anything happens. Describe the action to the user and wait for their answer.";

  const annotations: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: risk === "destructive",
    idempotentHint: false,
    ...cfg.annotations,
  };

  const run = async (args: z.infer<z.ZodObject<Shape>>, m: "elicit" | "token" | "policy" | "channel", summary: string, argsHash: string): Promise<CallToolResult> => {
    try {
      const result = await cfg.execute(args);
      emit("executed", m, { summary, argsHash });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit("failed", m, { summary, argsHash, detail: msg });
      return text(`The action was approved but failed: ${msg}`, true);
    }
  };

  server.registerTool(
    cfg.name,
    { title: cfg.title, description, inputSchema: shape as unknown as Shape, annotations },
    (async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
      const { confirm_token, ...rest } = rawArgs as Record<string, unknown> & { confirm_token?: string };
      const args = rest as z.infer<z.ZodObject<Shape>>;
      const argsHash = hashArgs(rest);

      let plan: Preview;
      try {
        plan = await cfg.preview(args);
      } catch (e) {
        return text(`Could not prepare the action, so nothing was changed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      const canElicit = clientCanElicit(server);

      // Optional context lookup. Anything but a plain object means "unknown target", which is never auto-approved.
      let context: ResolvedContext | undefined;
      let contextOk = true;
      if (cfg.resolve) {
        try {
          const r = await cfg.resolve(args);
          if (isPlainObject(r)) context = r;
          else contextOk = false;
        } catch {
          contextOk = false;
        }
        if (context) {
          const lines = Object.entries(context).filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean").map(([k, v]) => `target ${k}: ${String(v)}`);
          plan = { ...plan, details: [...(plan.details ?? []), ...lines] };
        } else {
          plan = { ...plan, details: [...(plan.details ?? []), "target: could not be identified"] };
        }
      }
      let gated = !contextOk;
      if (!gated && cfg.gate && context) {
        try {
          gated = contextMatchesGate(context, cfg.gate);
        } catch {
          gated = true;
        }
      }

      // Optional low-risk policy. Only an exact `true` skips the human; a throw or any other value asks as usual.
      if (cfg.autoApprove && mode !== "elicit" && mode !== "channel" && !gated) {
        let auto = false;
        try {
          auto = (await cfg.autoApprove(args, plan, context)) === true;
        } catch {
          auto = false; // fail closed
        }
        if (auto) {
          emit("auto-approved", "policy", { summary: plan.summary, argsHash });
          return run(args, "policy", plan.summary, argsHash);
        }
      }

      if (mode === "channel") {
        emit("previewed", "channel", { summary: plan.summary, argsHash });
        let ok = false;
        try {
          const timeoutMs = cfg.approvalTimeoutMs ?? 5 * 60_000;
          ok =
            (await Promise.race([
              Promise.resolve(cfg.approver!({ tool: cfg.name, summary: plan.summary, details: plan.details ?? [], argsHash })),
              new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error("approval timed out")), timeoutMs).unref()),
            ])) === true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          emit("failed", "channel", { summary: plan.summary, argsHash, detail: `approval channel failed: ${msg}` });
          return text(`The approval channel failed, so nothing was changed: ${msg}`, true); // fail closed
        }
        if (ok) {
          emit("approved", "channel", { summary: plan.summary, argsHash });
          return run(args, "channel", plan.summary, argsHash);
        }
        emit("declined", "channel", { summary: plan.summary, argsHash });
        return text("The approver did not approve this action, so nothing was changed. Do not retry unless the user asks again.");
      }

      if (mode === "elicit" && !canElicit) {
        emit("blocked", "elicit", { summary: plan.summary, argsHash });
        return text(
          "This action needs the user's explicit approval, but this client cannot show approval prompts (MCP elicitation). Nothing was changed.",
          true
        );
      }

      if (canElicit && mode !== "token") {
        emit("previewed", "elicit", { summary: plan.summary, argsHash });
        let answer;
        try {
          answer = await server.server.elicitInput(
            {
              message: `${formatPlan(plan)}\n\nApprove this action?`,
              requestedSchema: {
                type: "object",
                properties: { approve: { type: "boolean", title: "Approve", description: "Tick to approve this action" } },
                required: ["approve"],
              },
            },
            { timeout: cfg.approvalTimeoutMs ?? 5 * 60_000 }
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          emit("failed", "elicit", { summary: plan.summary, argsHash, detail: `approval prompt failed: ${msg}` });
          return text(`The approval prompt failed, so nothing was changed: ${msg}`, true); // fail closed
        }
        if (answer.action === "accept" && answer.content?.approve === true) {
          emit("approved", "elicit", { summary: plan.summary, argsHash });
          return run(args, "elicit", plan.summary, argsHash);
        }
        emit("declined", "elicit", { summary: plan.summary, argsHash });
        return text("The user did not approve this action, so nothing was changed. Do not retry unless the user asks again.");
      }

      // Token flow for clients without elicitation (or mode "token").
      if (!confirm_token) {
        const { token, expiresAt } = store.issue(cfg.name, rest);
        emit("previewed", "token", { summary: plan.summary, argsHash });
        const mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
        return text(
          `NOTHING HAS BEEN CHANGED YET. Planned action:\n${formatPlan(plan)}\n\n` +
            `Show this plan to the user and ask whether to go ahead. Only if they say yes, call ${cfg.name} again with exactly the same arguments plus ` +
            `confirm_token="${token}". The token works once and expires in about ${mins} minutes.`
        );
      }
      const check = store.consume(confirm_token, cfg.name, rest);
      if (!check.ok) {
        emit("rejected", "token", { summary: plan.summary, argsHash, detail: check.reason });
        const why = { unknown: "that token is not valid", expired: "that token has expired", mismatch: "the arguments differ from the ones that were previewed" }[check.reason];
        return text(`Not approved: ${why}. Nothing was changed. Call ${cfg.name} again without a token to get a fresh preview.`, true);
      }
      emit("approved", "token", { summary: plan.summary, argsHash });
      return run(args, "token", plan.summary, argsHash);
    }) as never
  );

  return { store };
}
