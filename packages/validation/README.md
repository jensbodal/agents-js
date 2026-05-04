# @agents-js/validation

> Schema validation for ACP envelopes, A2A requests/responses, runtime manifests, and JSON-RPC messages.

## Installation

```sh
bun add @agents-js/validation
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`ValidationError`** — Structured validation error with context about what failed

### Functions

- **`isACPOpenExtensionProperty`**
- **`validateJsonRpcEnvelope`**
- **`cloneValidationValue`**
- **`validateJsonSchema`**
- **`validateJsonSchemaArtifacts`**
- **`loadJsonFromSource`**
- **`runValidationCli`**
- **`buildACPFormElicitationMetadata`**
- **`isACPFormElicitationMetadata`**
- **`isACPElicitationResponseMetadata`**
- **`isACPAuthRequiredMetadata`**
- **`validateACPEnvelope`**
- **`validateACPMethod`**
- **`validateACPRequest`**
- **`validateACPResponse`**
- **`getBasicCatalog`** — Returns a lazily-constructed `Catalog` wrapping `BASIC_COMPONENTS`. Cached so repeated calls reuse the same instance.
- **`validateA2uiMessage`** — Validate a lifecycle A2UI message (CreateSurface, UpdateComponents, UpdateDataModel, DeleteSurface). Returns the typed message on success.
- **`isA2uiMessage`** — Type guard form of {validateA2uiMessage}. Useful for narrowing `unknown` values at the boundary of a transport without allocating a result object.
- **`validateA2uiComponent`** — Validate a single component entry against a catalog. Accepts the wire-format component envelope `{ component, id?, weight?, ...props }` and delegates the property-shape check to the catalog's `Comp...
- **`validateA2uiSurfaceTree`** — Validate a full component tree against a catalog. Fails fast on the first invalid component and accumulates issues from both envelope and property-level failures.
- **`isValidationMode`**
- **`resolveValidationMode`**
- **`registerRuntimeValidator`**
- **`validateRuntimeManifest`**
- **`resetRuntimeValidatorsForTest`**
- **`validateAguiEvent`** — Validate an AG-UI event against the canonical `EventSchemas` discriminated union published by `-ui/core`.
- **`isAguiEvent`** — Type guard form of {validateAguiEvent}. Useful for narrowing `unknown` values inside stream handlers without allocating a result object.
- **`validateRunAgentInput`** — Validate a `RunAgentInput` envelope — the payload AG-UI agents accept as their run entrypoint. Wraps `RunAgentInputSchema.safeParse`.
- **`zodIssuesToValidationIssues`** — Zod-version-agnostic conversion of a `ZodError` to the canonical {ValidationIssue} shape. Accepts errors from either Zod v3 or v4 without triggering structural-type incompatibility, because we only...
- **`toValidationIssues`** — Use {zodIssuesToValidationIssues} — it accepts both Zod v3 and v4 errors via duck-typing. Kept as an alias for callers that want the v4-typed signature.
- **`zodObjectWithMode`**
- **`validateA2ARequest`**
- **`validateA2AResponse`**
- **`validateAgentCard`**
- **`validateA2AMessageSendResponseResult`**

### Interfaces

- **`ACPGeneratedMethodSchemaInfo`**
- **`ACPGeneratedSchemaArtifacts`**
- **`ValidationIssue`**
- **`ValidationErrorOptions`**
- **`JsonSchemaValidationOptions`**
- **`JsonSchemaValidationArtifacts`**
- **`ACPFormElicitationMetadata`**
- **`ACPElicitationResponseMetadata`**
- **`ACPAuthRequiredMetadata`**
- **`ACPErrorObject`**
- **`ACPRequestLikeEnvelope`**
- **`ACPRequestEnvelope`**
- **`ACPResponseEnvelope`**
- **`ACPResponseValidationOptions`**
- **`ValidationOptions`**

### Types

- **`ACPMethodSide`**
- **`ACPPayloadKind`**
- **`JsonRpcRequest`**
- **`JsonRpcResponse`**
- **`JsonSource`**
- **`ValidationResult`** — Result of a non-throwing validation call. Mirrors the Zod `safeParse` shape but exposes a structured {ValidationError} on failure so consumers get the same error surface across every validator in t...
- **`ACPMethod`**
- **`ACPEnvelope`**
- **`SurfaceTree`** — A surface component tree — the `components` array of an `updateComponents` message.
- **`ValidationMode`**
- **`RuntimeManifestValidator`**

### Constants

- **`acpGeneratedSchemaArtifacts`**
- **`ACP_OPEN_EXTENSION_PROPERTIES`** — ACP open-extension properties.
- **`jsonRpcRequestSchema`** — JSON-RPC 2.0 request envelope
- **`jsonRpcResponseSchema`** — JSON-RPC 2.0 response envelope
- **`ACP_ELICITATION_METADATA_KEY`**
- **`ACP_ELICITATION_RESPONSE_METADATA_KEY`**
- **`ACP_AUTH_REQUIRED_METADATA_KEY`**
- **`ACP_METHOD_WHITELIST`**
- **`BASIC_CATALOG_ID`** — Stable id for the built-in basic catalog (used when no catalog is supplied).
- **`VALIDATION_MODES`**
- **`a2aValidationSchemas`**

### Exports

- **`type ValidationErrorOptions`**
- **`type ValidationIssue`**

## Scope

`@agents-js/validation` is the project's **wire-format schema gateway**. It
validates payloads that cross a transport boundary (stdio, HTTP, SSE) against
the canonical schemas published by their respective protocol type packages.

### What lives here

- **ACP** — request/response/notification envelopes, method whitelist, JSON
  Schema artifacts generated from the ACP meta-schema (see
  `scripts/generate-acp-schema.ts`).
- **A2A** — request/response, agent card, message-send result, push
  notification config.
- **A2UI** — lifecycle messages and per-component validation against a
  catalog (basic catalog provided; consumers may pass their own).
- **AG-UI** — events and `RunAgentInput` envelopes.
- **JSON-RPC 2.0** — request/response envelopes used as the transport
  layer for ACP and other JSON-RPC peers.
- **Runtime manifest** — pluggable validators registered at startup.
- **Generic JSON Schema** — Ajv-backed validation for arbitrary
  user-supplied schemas (used by elicitation forms, etc.).
- **Validation modes** — strict/lenient/off resolution shared by all
  validators.

### Cross-package dependencies (and why)

This package wraps schemas owned by other packages rather than redefining
them. Every cross-package dep is a *schema provider*:

| Dep                       | Why                                                             |
| ------------------------- | --------------------------------------------------------------- |
| `@agentclientprotocol/sdk`| Source of ACP request/response Zod schemas.                     |
| `@a2a-js/sdk`             | Source of A2A schemas (agent card, message send, etc.).         |
| `@agents-js/a2ui-types`   | Source of `A2uiMessageSchema`, `BASIC_COMPONENTS`, `Catalog`.   |
| `@agents-js/agui-types`   | Source of `EventSchemas` and `RunAgentInputSchema`.             |
| `ajv` / `ajv-formats`     | JSON Schema validation engine (for non-Zod schemas).            |
| `zod`                     | Validation engine used by all of the above type packages.       |

If a future protocol/UI surface ships its own Zod schemas in a sibling
package, the validator wrapper belongs here and that package becomes a new
schema-provider dep.

### What does NOT belong here

- **Domain validation** — business rules, policy/permission grammar,
  authorization checks. Those live in `@agents-js/policy` and the
  consuming application layer. This package only checks "does the bytes
  match the wire schema?".
- **Type definitions** — protocol types are owned by their respective
  `*-types` / SDK packages; this package re-exports a few convenience
  type aliases but does not author new type vocabulary.
- **Schema authoring** — the ACP JSON Schema artifacts here are *generated*
  from `@agentclientprotocol/sdk`; they are not hand-edited.
- **Transport / IO** — the only IO surface is `loader.ts` (a `node:fs`
  helper for the `agents-validate` CLI), exported under a separate
  `/loader` subpath so browser bundlers can drop it.

### Public entry points

- `@agents-js/validation` — all validators, schemas, error types
  (browser-safe).
- `@agents-js/validation/loader` — Node-only JSON loading helper for the
  CLI; uses `node:fs/promises`.
- `agents-validate` — CLI binary that wraps the validators for ad-hoc
  schema checks.


## Dependencies

- `@a2a-js/sdk`
- `@agents-js/a2ui-types`
- `@agents-js/agui-types`
- `@agentclientprotocol/sdk`
- `ajv`
- `ajv-formats`
- `zod`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
