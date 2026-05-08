# @agents-js/validation

> Wire-format schema validation for ACP envelopes, A2A requests/responses, A2UI lifecycle messages, AG-UI events, JSON-RPC 2.0 envelopes, agent cards, and runtime manifests.

`@agents-js/validation` is the wire-format schema gateway for the agents-js
project. It wraps the canonical schemas published by `@agentclientprotocol/sdk`,
`@a2a-js/sdk`, `@agents-js/a2ui-types`, and `@agents-js/agui-types`, and
exposes a uniform `ValidationResult` shape (with structured `ValidationError`
issues) across every protocol and transport boundary.

## Installation

```sh
npm install @agents-js/validation
```

```sh
bun add @agents-js/validation
```

## Usage

Validate an inbound JSON-RPC envelope before dispatching it:

```ts
import { validateJsonRpcEnvelope, ValidationError } from "@agents-js/validation";

const payload: unknown = JSON.parse(rawBody);

try {
  const request = validateJsonRpcEnvelope(payload, "request", { mode: "strict" });
  // request is now typed and guaranteed to match the JSON-RPC 2.0 request shape.
  await dispatch(request);
} catch (err) {
  if (err instanceof ValidationError) {
    console.error("rejected envelope", err.issues);
  }
  throw err;
}
```

Type-guard a streaming AG-UI event without throwing:

```ts
import { isAguiEvent } from "@agents-js/validation";

for await (const chunk of stream) {
  if (isAguiEvent(chunk)) {
    forward(chunk);
  }
}
```

### `agents-validate` CLI

The package ships an `agents-validate` binary for ad-hoc schema checks against
files or URLs. Output is a JSON document with `ok: true|false`; non-zero exit
on failure.

```sh
# Validate an ACP request envelope from a local file.
npx agents-validate --source ./fixtures/session-new.json --target acp-request

# Validate an A2A agent card served over HTTP, in lenient mode.
npx agents-validate \
  --source https://example.com/.well-known/agent.json \
  --target agent-card \
  --mode loose

# Validate an ACP response — `--method` is required so the right schema is selected.
npx agents-validate \
  --source ./fixtures/session-new-response.json \
  --target acp-response \
  --method session/new
```

Run `npx agents-validate --help` for the full list of `--target` values
(`jsonrpc-request`, `jsonrpc-response`, `a2a-request`, `a2a-response`,
`acp-envelope`, `acp-request`, `acp-response`, `agent-card`,
`runtime-manifest`).

## Documentation

Full API reference and protocol guides: <https://agents-js.bodal.dev/>.

## License

MIT — see [LICENSE](./LICENSE).

<!-- This README is hand-maintained. -->
