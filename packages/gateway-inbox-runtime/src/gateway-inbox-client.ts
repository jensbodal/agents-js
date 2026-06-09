/** Structured Matrix-origin envelope (DOT-502 section 2/7). Optional per row. */
export interface MatrixOrigin {
  readonly event_id?: string;
  readonly room_id?: string;
  readonly sender?: string;
  readonly origin_server_ts?: number;
  readonly reply_to_event_id?: string;
}

/**
 * One durable-inbox row. `kind` discriminates bridge-fanout rows
 * (`"matrix_room_mention"`) from native sends (`"agents_message"`); absent
 * `kind` is treated as `"agents_message"` for compatibility.
 */
export interface InboxMessage {
  readonly message_id: string;
  readonly created_at?: string | number;
  readonly body: string;
  readonly kind?: string;
  readonly idempotency_key?: string | null;
  readonly matrix_origin?: MatrixOrigin;
  /** Fallback author when `matrix_origin.sender` is absent on native sends. */
  readonly sender?: string;
}

/** Result of {@link GatewayInboxClient.getMessages}. */
export interface GetMessagesResult {
  readonly ok: boolean;
  /** Identity whose inbox was read, echoed for the poller's identity guard. */
  readonly identity: string;
  readonly messages: InboxMessage[];
}

/** Result of {@link GatewayInboxClient.sendMessage}. */
export interface SendMessageResult {
  readonly ok: boolean;
  readonly event_id?: string;
  readonly detail?: string;
}

/** Transport-agnostic durable-inbox client. The poller depends only on this. */
export interface GatewayInboxClient {
  /** Read the caller identity's own inbox. */
  getMessages(args: { identity: string; limit?: number }): Promise<GetMessagesResult>;
  /** Send a message to `target` as `identity`. */
  sendMessage(args: { target: string; body: string; identity: string }): Promise<SendMessageResult>;
  /** Release transport resources. */
  close(): Promise<void>;
}
