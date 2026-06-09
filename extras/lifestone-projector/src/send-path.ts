/**
 * Send-path (maildrop) core for the lifestone agent-inbox (PROJECTION-SPEC.md
 * §3A, increment c). This is the PRIMARY, default shape per Jens's [Decision]
 * 2026-06-08 (dot-proxmox BL-62): lifestone is a human/local file-router INTO
 * the signed gateway `send_message` — NOT a default mirror of inbox rows.
 *
 * Pure-testable: the routing decision is a function of `(outbox file content,
 * injected sendMessage)`. It performs NO filesystem I/O itself — it returns an
 * outcome telling the thin runtime where the file should move (`pending/` on
 * delivered, `failed/` on reject/parse-failure) and what annotated content to
 * write. So it needs no gateway, no credentials, no adapter import to test; the
 * runtime composes `HttpGatewayInboxClient.sendMessage` (public via #165) + fs.
 *
 * Invariant: routing stays the signed gateway path. A parse failure or empty
 * `to` is NEVER silently sent — it lands in `failed/`. The gateway is canonical;
 * lifestone never invents a delivery.
 */

import { parseOutboxFile } from "./render.ts";

/** Mirror of `GatewayInboxClient.sendMessage` (claude-channel-adapter), structural to avoid a dep. */
export type OutboxSendFn = (args: {
  target: string;
  body: string;
  identity: string;
}) => Promise<{ ok: boolean; event_id?: string; detail?: string }>;

/** Terminal disposition for a routed outbox file. */
export type OutboxRouteOutcome =
  | { readonly kind: "parse-failed"; readonly dest: "failed"; readonly error: string }
  | {
      readonly kind: "send-failed";
      readonly dest: "failed";
      readonly target: string;
      readonly error: string;
    }
  | {
      readonly kind: "delivered";
      readonly dest: "pending";
      readonly target: string;
      readonly gatewayId?: string;
      readonly annotatedContent: string;
    };

/** Append/refresh terminal frontmatter keys on an already-rendered outbox file. */
export function annotateDelivered(content: string, gatewayId?: string): string {
  const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content.replace(/\r\n/g, "\n"));
  if (!fm) {
    // No frontmatter — prepend a minimal terminal block rather than corrupt the file.
    const gid = gatewayId ? `\ngateway_id: ${gatewayId}` : "";
    return `---\nstate: delivered${gid}\n---\n\n${content.trim()}\n`;
  }
  const headerLines = (fm[1] ?? "")
    .split("\n")
    .filter((l) => !/^(state|gateway_id):/.test(l.trim()));
  headerLines.push("state: delivered");
  if (gatewayId) headerLines.push(`gateway_id: ${gatewayId}`);
  return `---\n${headerLines.join("\n")}\n---\n${fm[2] ?? ""}`;
}

/**
 * Route one `outbox/` file's content through the gateway. Pure except the
 * injected `sendMessage`. Returns the terminal disposition; the runtime moves
 * the file accordingly and writes `annotatedContent` for the delivered case.
 */
export async function routeOutboxContent(
  content: string,
  opts: { readonly sendMessage: OutboxSendFn; readonly identity: string },
): Promise<OutboxRouteOutcome> {
  const parsed = parseOutboxFile(content);
  if (!parsed.ok) {
    return { kind: "parse-failed", dest: "failed", error: parsed.error };
  }

  let res: { ok: boolean; event_id?: string; detail?: string };
  try {
    res = await opts.sendMessage({ target: parsed.to, body: parsed.body, identity: opts.identity });
  } catch (err) {
    return {
      kind: "send-failed",
      dest: "failed",
      target: parsed.to,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok) {
    return {
      kind: "send-failed",
      dest: "failed",
      target: parsed.to,
      error: res.detail ?? "gateway send_message returned ok:false",
    };
  }

  return {
    kind: "delivered",
    dest: "pending",
    target: parsed.to,
    gatewayId: res.event_id,
    annotatedContent: annotateDelivered(content, res.event_id),
  };
}
