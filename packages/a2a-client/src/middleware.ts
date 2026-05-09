import type { ContentBlock } from "@agentclientprotocol/sdk";
import { type AuditEmitter, newCorrelationId } from "@agents-js/a2a/audit";
import { parseAgentMentions, parseDispatchDirective } from "./mention-parser.ts";
import { A2AClientProvider } from "./provider.ts";
import { collectTextParts, extractLatestAgentText, extractMessageText } from "./session.ts";
import type {
  A2ASendResult,
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
} from "./types.ts";

export type AgentMentionResolver = (name: string) => Promise<AgentTargetInput | null>;

export type AgentMentionMap = Record<string, AgentTargetInput>;

export interface AgentMentionRegistry {
  resolve(name: string): Promise<AgentTargetInput | ResolvedAgentTarget | null>;
}

export interface A2AMentionResponseBlockOptions {
  agentName: string;
  agentUrl: string;
  text: string;
}

export interface A2AMentionDispatchOptions {
  agentName: string;
  promptText: string;
  sessionId: string | null;
}

export interface A2AMentionDispatchError extends A2AMentionDispatchOptions {
  error: unknown;
}

export interface A2AMentionDispatchSuccess extends A2AMentionDispatchOptions {
  /** Resolved base URL of the remote agent that produced this reply. */
  agentUrl: string;
  /** Raw A2A send result returned by the remote agent. */
  result: A2ASendResult;
}

export interface CreateA2AMentionMiddlewareOptions {
  agents?: AgentMentionMap;
  registry?: AgentMentionRegistry;
  resolveAgent?: AgentMentionResolver;
  transport?: A2ATransport;
  getPromptText?: (content: ContentBlock[]) => string;
  /**
   * Return `false` to block delegation for a specific mention.
   * Returning `true` or `undefined` allows dispatch to continue.
   */
  allowDispatch?(
    params: A2AMentionDispatchOptions,
  ): Promise<boolean | undefined> | boolean | undefined;
  onUnknownAgent?(params: A2AMentionDispatchOptions): void;
  /**
   * Fires immediately before the A2A `sendTurn` call, after the target has
   * been resolved and connected. Paired with `onDispatchSuccess`
   * (on success) or `onDispatchError` (on failure) — exactly one of those
   * terminals fires per started dispatch. Unknown-agent mentions do NOT
   * produce an `onDispatchStart`; they produce `onUnknownAgent`.
   *
   * Awaited so hosts can render "delegating to @agent" activity before
   * the wire call begins.
   */
  onDispatchStart?(params: A2AMentionDispatchOptions): Promise<void> | void;
  /**
   * Fires after a successful `sendTurn`. Mutually exclusive with
   * `onDispatchError` for the same dispatch. Awaited before the reply is
   * folded into the outgoing response blocks.
   */
  onDispatchSuccess?(params: A2AMentionDispatchSuccess): Promise<void> | void;
  /**
   * Fires when a started dispatch fails (resolution error, network error,
   * `sendTurn` rejection). Mutually exclusive with `onDispatchSuccess`.
   */
  onDispatchError?(params: A2AMentionDispatchError): Promise<void> | void;
  buildResponseBlock?(params: A2AMentionResponseBlockOptions): ContentBlock | undefined;
  /** Optional structural audit emitter. Prompt text is never recorded. */
  audit?: AuditEmitter;
}

/**
 * Collect text from ALL content blocks (including system context) into a single
 * prompt string. Hosts with structured or annotated content blocks (e.g. the
 * Obsidian plugin, which tags blocks with `hostSource`) must supply a custom
 * `getPromptText` callback that filters to user-prompt blocks only.
 */
function defaultGetPromptText(content: ContentBlock[]): string {
  return collectTextParts(content).join("\n").trim();
}

/**
 * Outer open-tag for the A2A delegation framing. Consumers (tests, host
 * integrations, alternate `buildResponseBlock` implementations) should import
 * this constant rather than hardcode the string.
 */
export const A2A_DELEGATION_RESPONSE_OPEN_TAG = "<a2a-delegation-response>";

/**
 * Outer close-tag for the A2A delegation framing. Paired with
 * `A2A_DELEGATION_RESPONSE_OPEN_TAG`.
 */
export const A2A_DELEGATION_RESPONSE_CLOSE_TAG = "</a2a-delegation-response>";

/**
 * Escape a delegated agent's response so it cannot break out of the outer
 * `<a2a-delegation-response>` markers. Rewrites any literal occurrences of the
 * open or close tags inside `innerText` with zero-width-space-obfuscated
 * equivalents (e.g. `</a2a\u200b-delegation-response>`). The receiving LLM
 * still reads the inner text as natural language — the obfuscation is visually
 * indistinguishable but lexically distinct from the outer markers, so regex /
 * substring lookups for the markers find only the single outer pair.
 */
export function escapeA2ADelegationInnerText(innerText: string): string {
  // Fast path: the common case is that LLM responses don't contain the tag
  // substring at all. The literal `a2a-delegation-response` is the shared
  // suffix of both the open and close tag, so one short-circuiting scan
  // covers both and avoids allocating when no match exists.
  if (!innerText.includes("a2a-delegation-response")) return innerText;
  // The obfuscator inserts a zero-width space between "a2a" and "-delegation"
  // so the resulting string is no longer a syntactic match for the outer tag.
  // Order matters: rewrite the close tag first, then the open tag, to avoid
  // double-escaping a nested pair.
  const OBFUSCATED_OPEN = "<a2a\u200b-delegation-response>";
  const OBFUSCATED_CLOSE = "</a2a\u200b-delegation-response>";
  return innerText
    .split(A2A_DELEGATION_RESPONSE_CLOSE_TAG)
    .join(OBFUSCATED_CLOSE)
    .split(A2A_DELEGATION_RESPONSE_OPEN_TAG)
    .join(OBFUSCATED_OPEN);
}

/**
 * Declarative template for the delegation framing prompt. Consumers (tests,
 * host integrations, alternate `buildResponseBlock` implementations) should
 * import this rather than rebuild the literal string structure, so any change
 * to the framing shape funnels through one place.
 *
 * The four string fields are concatenated by `buildA2ADelegationFramingText`
 * with blank-line separators between sections, in this order:
 *
 *   {introLine}
 *   (blank)
 *   {openTag}
 *   {innerText}     (escaped via `escapeA2ADelegationInnerText`)
 *   {closeTag}
 *   (blank)
 *   {outroLine}
 *
 * Both `introLine` and `outroLine` are builders rather than raw strings so
 * they can interpolate the per-dispatch agent identity.
 */
export interface A2ADelegationFramingTemplate {
  introLine: (params: { agentName: string; agentUrl: string }) => string;
  openTag: string;
  closeTag: string;
  outroLine: (params: { agentName: string }) => string;
}

/**
 * Canonical framing template used by `defaultBuildResponseBlock`. Exported so
 * the framing-contract regression test can assert against the exact strings,
 * and so downstream consumers that emit equivalent framed blocks from another
 * code path can reuse the same shape rather than drift.
 *
 * The wording here is load-bearing — see
 * `packages/a2a-client/tests/middleware-framing.test.ts`. Treat phrase
 * changes ("authoritative answer", "Do not re-investigate") as prompt-shape
 * changes and land them with deliberate review.
 */
export const A2A_DELEGATION_FRAMING_TEMPLATE: A2ADelegationFramingTemplate = {
  introLine: ({ agentName, agentUrl }) =>
    `The remote agent @${agentName} (via ${agentUrl}) was invoked to answer the user's @${agentName} mention and responded with:`,
  openTag: A2A_DELEGATION_RESPONSE_OPEN_TAG,
  closeTag: A2A_DELEGATION_RESPONSE_CLOSE_TAG,
  outroLine: ({ agentName }) =>
    `Treat this as the authoritative answer from @${agentName} and incorporate it into your response to the user. Do not re-investigate what @${agentName} means — it has already been invoked and the response above is its reply.`,
};

/**
 * Build the framing prompt that wraps a remote agent's response so the
 * receiving LLM recognizes it as "the answer from `@agentName`" rather than
 * ambient context. Without this framing, Claude tends to ignore annotation
 * metadata and code-explore the raw `@mention` in the user prompt instead of
 * using the delegated answer.
 *
 * The wording of this prompt is load-bearing — see
 * `packages/a2a-client/tests/middleware-framing.test.ts` for the contract.
 * The template itself lives in `A2A_DELEGATION_FRAMING_TEMPLATE`.
 *
 * `innerText` is passed through `escapeA2ADelegationInnerText` before
 * interpolation so an adversarial agent cannot emit the outer close-tag and
 * break out of the framing.
 */
export function buildA2ADelegationFramingText(params: {
  agentName: string;
  agentUrl: string;
  innerText: string;
}): string {
  const { agentName, agentUrl, innerText } = params;
  const safeInner = escapeA2ADelegationInnerText(innerText);
  const template = A2A_DELEGATION_FRAMING_TEMPLATE;
  return [
    template.introLine({ agentName, agentUrl }),
    "",
    template.openTag,
    safeInner,
    template.closeTag,
    "",
    template.outroLine({ agentName }),
  ].join("\n");
}

function defaultBuildResponseBlock({
  agentName,
  agentUrl,
  text,
}: A2AMentionResponseBlockOptions): ContentBlock {
  const framed = buildA2ADelegationFramingText({
    agentName,
    agentUrl,
    innerText: text,
  });

  return {
    type: "text",
    text: framed,
    annotations: {
      audience: ["assistant" as const],
      _meta: {
        source: "a2a-delegation",
        agentName,
        agentUrl,
      },
    },
  } as ContentBlock;
}

function isResolvedAgentTarget(
  target: AgentTargetInput | ResolvedAgentTarget,
): target is ResolvedAgentTarget {
  return "baseUrl" in target;
}

export function extractA2AResponseText(result: A2ASendResult): string {
  if (result.kind === "message") {
    return extractMessageText(result);
  }
  return extractLatestAgentText(result);
}

export function createA2AMentionMiddleware(
  options: CreateA2AMentionMiddlewareOptions = {},
): (content: ContentBlock[], sessionId: string | null) => Promise<ContentBlock[] | undefined> {
  const provider = new A2AClientProvider(options.transport);
  const getPromptText = options.getPromptText ?? defaultGetPromptText;
  const buildResponseBlock = options.buildResponseBlock ?? defaultBuildResponseBlock;

  async function resolveAgentTarget(
    name: string,
  ): Promise<AgentTargetInput | ResolvedAgentTarget | null> {
    if (options.registry) {
      return await options.registry.resolve(name);
    }

    if (options.resolveAgent) {
      return await options.resolveAgent(name);
    }

    return options.agents?.[name] ?? null;
  }

  return async (
    content: ContentBlock[],
    sessionId: string | null,
  ): Promise<ContentBlock[] | undefined> => {
    const promptText = getPromptText(content).trim();
    if (!promptText) {
      return undefined;
    }

    if (parseDispatchDirective(promptText)) {
      return undefined;
    }

    const mentions = parseAgentMentions(promptText);
    if (mentions.length === 0) {
      return undefined;
    }

    const uniqueNames = [...new Set(mentions.map((mention) => mention.agentName))];
    const dispatchableNames: string[] = [];

    for (const agentName of uniqueNames) {
      const dispatchOptions: A2AMentionDispatchOptions = {
        agentName,
        promptText,
        sessionId,
      };

      const allowed = await options.allowDispatch?.(dispatchOptions);
      if (allowed === false) {
        options.audit?.record({
          kind: "mention-dispatch-blocked",
          correlationId: newCorrelationId(),
          agentName,
          ...(sessionId ? { sessionId } : {}),
          reason: "policy",
        });
        continue;
      }
      dispatchableNames.push(agentName);
    }

    if (dispatchableNames.length === 0) {
      return undefined;
    }

    const results = await Promise.allSettled(
      dispatchableNames.map(async (agentName) => {
        const correlationId = newCorrelationId();
        const startedAtMs = Date.now();
        options.audit?.record({
          kind: "mention-dispatch-started",
          correlationId,
          agentName,
          ...(sessionId ? { sessionId } : {}),
        });

        try {
          const resolvedTarget = await resolveAgentTarget(agentName);
          if (!resolvedTarget) {
            options.audit?.record({
              kind: "mention-dispatch-unknown",
              correlationId,
              agentName,
              ...(sessionId ? { sessionId } : {}),
            });
            options.onUnknownAgent?.({
              agentName,
              promptText,
              sessionId,
            });
            return null;
          }

          const target = isResolvedAgentTarget(resolvedTarget)
            ? resolvedTarget
            : await provider.connect(resolvedTarget);

          await options.onDispatchStart?.({
            agentName,
            promptText,
            sessionId,
          });

          const result = await provider.sendTurn(target, promptText, {
            contextId: sessionId ?? undefined,
            stream: false,
            blocking: true,
          });

          await options.onDispatchSuccess?.({
            agentName,
            agentUrl: target.baseUrl,
            promptText,
            sessionId,
            result,
          });

          options.audit?.record({
            kind: "mention-dispatch-succeeded",
            correlationId,
            agentName,
            agentUrl: target.baseUrl,
            ...(sessionId ? { sessionId } : {}),
            durationMs: Date.now() - startedAtMs,
          });

          return {
            agentName,
            agentUrl: target.baseUrl,
            text: extractA2AResponseText(result),
          };
        } catch (error) {
          options.audit?.record({
            kind: "mention-dispatch-failed",
            correlationId,
            agentName,
            ...(sessionId ? { sessionId } : {}),
            errorCategory: error instanceof Error ? error.name : "unknown",
            durationMs: Date.now() - startedAtMs,
          });
          throw error;
        }
      }),
    );

    const responseBlocks: ContentBlock[] = [];
    for (const [index, result] of results.entries()) {
      const agentName = dispatchableNames[index];
      if (!agentName) {
        continue;
      }

      if (result.status === "fulfilled") {
        if (!result.value) {
          continue;
        }
        const block = buildResponseBlock(result.value);
        if (block) {
          responseBlocks.push(block);
        }
      } else {
        await options.onDispatchError?.({
          agentName,
          promptText,
          sessionId,
          error: result.reason,
        });
      }
    }

    if (responseBlocks.length === 0) {
      return undefined;
    }

    return [...responseBlocks, ...content];
  };
}
