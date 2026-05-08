# @agents-js/agui-types

> AG-UI core re-exports plus first-party adapters for the agents-js streaming model — text messages, tool calls, reasoning, run lifecycle, and custom events.

`@agents-js/agui-types` re-exports the canonical AG-UI event schemas from
[`@ag-ui/core`](https://www.npmjs.com/package/@ag-ui/core) and adds the
stateful builder agents-js gateways and runtimes use to emit AG-UI event
streams without re-implementing the open-message / tool-call dedup
bookkeeping every time. It also pins the AG-UI core schema version it was
built against (`AGUI_CORE_VERSION`) so consumers can assert protocol
compatibility at startup.

## Installation

```sh
npm install @agents-js/agui-types
```

```sh
bun add @agents-js/agui-types
```

## Usage

Build an AG-UI event stream for a single agent run:

```ts
import { createAguiEventStream } from "@agents-js/agui-types";

const stream = createAguiEventStream();

for (const event of stream.textMessageStart({ messageId: "m1", role: "assistant" })) {
  yield event;
}

let acc = "";
for (const chunk of llmTokenStream) {
  acc += chunk;
  for (const event of stream.textMessageContent({ messageId: "m1", text: acc, previousText: acc.slice(0, -chunk.length) })) {
    yield event;
  }
}

for (const event of stream.textMessageEnd({ messageId: "m1" })) {
  yield event;
}

for (const event of stream.runFinished({ runId: "r1" })) {
  yield event;
}
```

Translate a single agents-js signal into the canonical AG-UI shape:

```ts
import { AGUI_CORE_VERSION, toAguiToolCallStart } from "@agents-js/agui-types";

console.log(`emitting events compatible with ag-ui core ${AGUI_CORE_VERSION}`);

const event = toAguiToolCallStart({
  toolCallId: "tc-7",
  toolCallName: "fetch_context",
  parentMessageId: "m1",
});
transport.send(event);
```

## Documentation

Full API reference and protocol guides: <https://agents-js.bodal.dev/>.

## License

MIT — see [LICENSE](./LICENSE).

<!-- This README is hand-maintained. -->
