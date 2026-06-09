/**
 * {@link GatewayInboxClient} backed by direct HTTPS to the agents-js gateway,
 * authenticated with a short-lived JWT minted via AJS-55 challenge/redeem
 * ({@link mintGatewayJwt}). This is the production transport for an agent that
 * holds its own ed25519 identity key — no admin token, no spawned MCP server.
 *
 * The JWT is cached and re-minted lazily when it is within `refreshMarginMs`
 * of expiry. The private key is sourced through an injected
 * `getPrivateKeyPem` callback (the launcher wires it to `gopass show …`), so
 * this class never touches a secret store directly and stays unit-testable
 * with a generated keypair.
 */

import type {
  GatewayInboxClient,
  GetMessagesResult,
  InboxMessage,
  SendMessageResult,
} from "./gateway-inbox-client.ts";
import { mintGatewayJwt } from "./gateway-mint.ts";

const DEFAULT_SCOPES = ["inbox.read", "inbox.deliver", "matrix.send_message"];

export interface HttpGatewayInboxClientOptions {
  /** Gateway base URL, e.g. `https://ajs-gateway.q4m.dev`. */
  readonly baseUrl: string;
  /** Identity to mint/read/send as (JWT `sub`), e.g. `hostname-null-claude-0`. */
  readonly entity: string;
  /** Supplies the PEM PKCS#8 ed25519 key for `entity`; called only on (re)mint. */
  readonly getPrivateKeyPem: () => Promise<string>;
  /** Scopes to request. Default: inbox.read + inbox.deliver + matrix.send_message. */
  readonly scopes?: string[];
  /** Re-mint when fewer than this many ms remain on the JWT. Default 60000. */
  readonly refreshMarginMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Clock override for tests. */
  readonly now?: () => number;
}

export class HttpGatewayInboxClient implements GatewayInboxClient {
  private jwt: string | null = null;
  private expiresAtMs = 0;
  private minting: Promise<string> | null = null;
  private readonly scopes: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: HttpGatewayInboxClientOptions) {
    this.scopes = opts.scopes ?? DEFAULT_SCOPES;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Cached JWT, minting (or re-minting near expiry) as needed. */
  private async token(): Promise<string> {
    const margin = this.opts.refreshMarginMs ?? 60_000;
    if (this.jwt && this.now() < this.expiresAtMs - margin) return this.jwt;
    if (this.minting) return this.minting;
    this.minting = (async () => {
      const pem = await this.opts.getPrivateKeyPem();
      const res = await mintGatewayJwt({
        baseUrl: this.opts.baseUrl,
        entity: this.opts.entity,
        scopes: this.scopes,
        privateKeyPem: pem,
        fetchImpl: this.fetchImpl,
      });
      this.jwt = res.jwt;
      this.expiresAtMs = this.now() + res.expires_in * 1000;
      return res.jwt;
    })();
    try {
      return await this.minting;
    } finally {
      this.minting = null;
    }
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const jwt = await this.token();
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // On a 401 (authentication failed → the token is rotated/revoked/expired)
      // drop the cached JWT so the next call re-mints instead of replaying a
      // dead-but-unexpired token for up to the full refresh window. A 403 is
      // deliberately NOT cleared: it means authenticated-but-forbidden (a scope
      // or permission denial), and a re-mint requests the SAME scopes — it
      // can't lift the denial, so clearing would only burn a needless mint.
      if (res.status === 401) {
        this.jwt = null;
        this.expiresAtMs = 0;
      }
      throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return { raw: text };
    }
  }

  async getMessages(args: { identity: string; limit?: number }): Promise<GetMessagesResult> {
    const out = await this.post("/api/agents/get_messages", { limit: args.limit ?? 10 });
    return {
      ok: out.ok === true,
      // The inbox read is JWT-pinned to `entity`; echo it so the poller's
      // identity guard compares against the subject we actually minted for.
      identity: this.opts.entity,
      messages: Array.isArray(out.messages) ? (out.messages as InboxMessage[]) : [],
    };
  }

  async sendMessage(args: {
    target: string;
    body: string;
    identity: string;
  }): Promise<SendMessageResult> {
    const out = await this.post("/api/agents/send_message", {
      target: args.target,
      body: args.body,
    });
    return {
      ok: out.ok === true,
      ...(typeof out.event_id === "string" ? { event_id: out.event_id } : {}),
    };
  }

  async close(): Promise<void> {
    /* stateless HTTPS — nothing to release */
  }
}
