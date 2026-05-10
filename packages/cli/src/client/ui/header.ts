import type { A2ASessionState } from "@agents-js/a2a-client";
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";

export interface ClientHeader {
  root: BoxRenderable;
  update(state: A2ASessionState): void;
}

/**
 * Compact label for the current mode. Empty string when no mode has
 * been reported by the harness (renders as no badge — keeps the
 * header tidy for harnesses that don't surface modes).
 */
function formatModeBadge(state: A2ASessionState): string {
  return state.currentMode ? `[mode: ${state.currentMode.modeId}]` : "";
}

/**
 * Compact label for token-budget telemetry. The SDK gives us a
 * structured `Cost = { amount, currency }`; we render it as
 * "12345/200000 · $0.18" when present, "12345/200000" when not.
 * Empty string when no usage has been reported.
 */
function formatUsageBadge(state: A2ASessionState): string {
  const u = state.lastUsage;
  if (!u) return "";
  const ratio = `${u.used}/${u.size}`;
  if (!u.cost) return ratio;
  // ISO 4217 codes default to USD-style symbol mapping; for anything
  // we don't know, render the code suffix (e.g. "0.18 EUR").
  const sym = u.cost.currency === "USD" ? "$" : "";
  const code = sym ? "" : ` ${u.cost.currency}`;
  return `${ratio} · ${sym}${u.cost.amount.toFixed(2)}${code}`;
}

export function createClientHeader(renderer: CliRenderer): ClientHeader {
  const title = new TextRenderable(renderer, {
    id: "client-header-title",
    content: "agents-js client",
    fg: "#e0af68",
  });
  // Right-side badges are space-separated and appear/disappear as the
  // harness reports mode/usage. Order: mode first, then usage, then
  // status. Status is always last so its color is the rightmost
  // signal (typical TUI pattern).
  const badges = new TextRenderable(renderer, {
    id: "client-header-badges",
    content: "",
    fg: "#9aa5ce",
  });
  const status = new TextRenderable(renderer, {
    id: "client-header-status",
    content: "[idle]",
    fg: "#7aa2f7",
  });

  const root = new BoxRenderable(renderer, {
    id: "client-header-root",
    width: "100%",
    height: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
  });

  // Group badges + status into a right-side cluster so they stay
  // glued together. Without this, `justifyContent: "space-between"`
  // on the parent spreads three children across the full width and
  // badges lands in the middle rather than right-adjacent to status.
  // Tests that look up `client-header-status` should use
  // `findDescendantById` (recursive) rather than `getRenderable`
  // (direct-children-only) — `right` is on that path.
  const right = new BoxRenderable(renderer, {
    id: "client-header-right",
    flexDirection: "row",
  });
  right.add(badges);
  right.add(status);

  root.add(title);
  root.add(right);

  return {
    root,
    update(state) {
      const targetLabel = state.target?.card.name ?? state.target?.baseUrl ?? "no target";
      title.content = `agents-js client — ${targetLabel}`;

      const modeBadge = formatModeBadge(state);
      const usageBadge = formatUsageBadge(state);
      const badgeParts = [modeBadge, usageBadge].filter((b) => b.length > 0);
      // Trailing space when a badge is present so it doesn't run into
      // the status field on its right.
      badges.content = badgeParts.length > 0 ? `${badgeParts.join(" ")} ` : "";

      if (state.status === "error" && state.lastError) {
        const truncated =
          state.lastError.length > 60 ? `${state.lastError.slice(0, 57)}...` : state.lastError;
        status.content = `[error] ${truncated}`;
      } else {
        status.content = `[${state.status}]`;
      }
      status.fg =
        state.status === "error"
          ? "#f7768e"
          : state.status === "connected" || state.status === "completed"
            ? "#9ece6a"
            : "#7aa2f7";
    },
  };
}
