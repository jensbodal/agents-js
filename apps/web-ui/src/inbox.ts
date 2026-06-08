/**
 * Agent inbox browser entry point.
 *
 * **Scope (AJS-85 Phase 1):** this is the AGENT INBOX browser — a read-only
 * view of durable per-session messages from the gateway's `agent-msg.db`
 * substrate. It is NOT a Matrix room transcript browser (that's DOT-499/500/501,
 * different substrate, different user queries). The two are complementary.
 *
 * v1 contract:
 *  - Auth: caller supplies JWT via URL hash (`#token=...`). Self-session-only
 *    via `inbox.read` scope (caller's identity is encoded in the JWT; the
 *    backend rejects cross-session reads with `forbidden-target` until
 *    `inbox.read_all` scope ships in a future phase).
 *  - Render: linear chronological list, client-side `from_session` filter,
 *    refresh button. No live overlay v1; no threading v1; no search v1.
 *  - Data source: `POST /api/agents/get_messages` against the gateway.
 *
 * v1 deliberately does NOT add a JWT mint UI — operators construct the URL
 * with an already-minted JWT from `/api/agents/mint/redeem`. Mint-flow UX
 * is out of scope for Phase 1.
 *
 * URL hash format:
 *   #gateway=<https://gateway.example>&token=<jwt>&target=<session>&limit=<n>
 *   - gateway: optional; defaults to same-origin
 *   - token:   REQUIRED; Bearer JWT for the gateway
 *   - target:  optional; defaults to caller's own session per backend
 *   - limit:   optional; defaults to backend's default (20)
 */
import {
  AcpInboxMessageList,
  type InboxMessageLike,
  registerAllComponents,
} from "@agents-js/ui-components";
import { type InboxBrowserConfig, isInboxConfigError, parseInboxConfig } from "./inbox-config.ts";

registerAllComponents();

const app = document.getElementById("app");
if (!app) throw new Error("Missing #app mount point");

interface GetMessagesSuccess {
  ok: true;
  messages: InboxMessageLike[];
}

interface GetMessagesFailure {
  ok: false;
  error: string;
  correlation_id?: string;
  message?: string;
}

type GetMessagesResponse = GetMessagesSuccess | GetMessagesFailure;

async function fetchInbox(config: InboxBrowserConfig): Promise<GetMessagesResponse> {
  const url = new URL("/api/agents/get_messages", config.gatewayUrl);
  const body: Record<string, unknown> = {};
  if (config.target) body.target = config.target;
  if (config.limit !== undefined) body.limit = config.limit;
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: "network-error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: "invalid-response",
      message: `HTTP ${res.status} — non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Trust the backend's discriminated shape; we narrow defensively.
  if (typeof parsed === "object" && parsed !== null && "ok" in parsed) {
    return parsed as GetMessagesResponse;
  }
  return { ok: false, error: "invalid-response", message: `HTTP ${res.status} — unexpected shape` };
}

function clearMount(): void {
  while (app.firstChild) {
    app.removeChild(app.firstChild);
  }
}

function renderConfigError(message: string): void {
  clearMount();
  const list = new AcpInboxMessageList();
  list.heading = "agents-js · inbox browser";
  list.subtitle = "configuration required";
  list.errorMessage = message;
  list.messages = [];
  app.appendChild(list);
}

async function load(config: InboxBrowserConfig, list: AcpInboxMessageList): Promise<void> {
  list.loading = true;
  list.errorMessage = "";
  const result = await fetchInbox(config);
  list.loading = false;
  if (result.ok) {
    list.messages = result.messages;
    const targetLabel = config.target ? ` · target=${config.target}` : " · self-session";
    list.subtitle = `gateway=${config.gatewayUrl}${targetLabel} · ${result.messages.length} message(s)`;
  } else {
    list.messages = [];
    // Log the typed failure at the call site (browser console for now;
    // ADR 0010 replaces this with the unified throw→log bridge post-0.6.x).
    console.error("[inbox] fetch failed", {
      error: result.error,
      message: result.message,
      correlation_id: result.correlation_id,
    });
    list.errorMessage = formatError(result);
  }
}

function formatError(failure: GetMessagesFailure): string {
  const suffix = failure.message ? `: ${failure.message}` : "";
  return `${failure.error}${suffix}`;
}

const config = parseInboxConfig(window.location.hash, window.location.origin);
if (isInboxConfigError(config)) {
  // Log the typed config error at the call site before rendering its message.
  console.error("[inbox] config error", { code: config.code, message: config.message });
  renderConfigError(config.message);
} else {
  const list = new AcpInboxMessageList();
  list.heading = "agents-js · inbox browser";
  list.subtitle = "loading…";
  list.messages = [];
  app.appendChild(list);
  list.addEventListener("acp-inbox-refresh", () => {
    void load(config, list);
  });
  void load(config, list);
}
