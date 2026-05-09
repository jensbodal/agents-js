import type { ElicitationSchema } from "@agentclientprotocol/sdk";

/**
 * Host-agnostic render descriptors for structured content output.
 *
 * These describe WHAT to render semantically. Each host (browser, CLI, desktop)
 * maps these to native renderers. This is layer 3 of the host-kit model —
 * the Interaction & Rendering Contract.
 *
 * Design principles:
 * - Descriptors are data, not components — they carry content, not behavior
 * - Each descriptor has a discriminated `type` field for exhaustive matching
 * - Hosts that don't support a descriptor type fall back to text rendering
 * - The `component` type is an escape hatch for host-specific rich content
 */

/** A text block rendered as markdown */
export interface TextDescriptor {
  type: "text";
  markdown: string;
}

/** A code block with language annotation */
export interface CodeDescriptor {
  type: "code";
  language: string;
  code: string;
  /** Optional filename for display */
  filename?: string;
}

/** A file diff */
export interface DiffDescriptor {
  type: "diff";
  path: string;
  oldText: string;
  newText: string;
}

/** Terminal output */
export interface TerminalDescriptor {
  type: "terminal";
  sessionId: string;
  output: string[];
}

/** A form rendered inline (not as a modal) — for read-only display of elicitation results */
export interface FormDescriptor {
  type: "form";
  schema: ElicitationSchema;
  values?: Record<string, unknown>;
  /** If true, the form is interactive (user can edit). Otherwise read-only display. */
  interactive?: boolean;
}

/** An escape hatch for host-specific components */
export interface ComponentDescriptor {
  type: "component";
  /** Custom element tag name (e.g., "acp-chart", "acp-table") */
  tag: string;
  /** Props passed to the component */
  props: Record<string, unknown>;
  /** Optional child content */
  children?: RenderDescriptor[];
}

/** Discriminated union of all render descriptor types */
export type RenderDescriptor =
  | TextDescriptor
  | CodeDescriptor
  | DiffDescriptor
  | TerminalDescriptor
  | FormDescriptor
  | ComponentDescriptor;

/**
 * Metadata hint that can be attached to ACP session_update _meta fields
 * to suggest structured rendering for tool call outputs.
 */
export interface RenderHint {
  /** Suggested render descriptors for this content */
  descriptors?: RenderDescriptor[];
  /** If true, the host should prefer structured rendering over markdown fallback */
  preferStructured?: boolean;
}
