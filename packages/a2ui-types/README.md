# @agents-js/a2ui-types

> Thin re-export layer over [`@a2ui/web_core`](https://www.npmjs.com/package/@a2ui/web_core) plus a curated ACP component catalog for agents-js.

`@agents-js/a2ui-types` gives consumers a single, version-aligned import for
A2UI lifecycle types (`A2uiMessage`, `Catalog`, `BASIC_COMPONENTS`) and adds
an opinionated `AcpCatalog` describing the ACP-aware component APIs
(`ChatApp`, `Transcript`, `PromptInput`, `PermissionModal`, …) that agents-js
hosts and renderers know how to draw.

## Installation

```sh
npm install @agents-js/a2ui-types
```

```sh
bun add @agents-js/a2ui-types
```

## Usage

Validate a lifecycle message against the A2UI basic catalog and the ACP
catalog together:

```ts
import { AcpCatalog } from "@agents-js/a2ui-types/catalog";
import { BasicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { MessageProcessor } from "@a2ui/web_core/v0_9/message_processor";

const processor = new MessageProcessor({
  catalogs: [BasicCatalog, AcpCatalog],
});

processor.handle({
  type: "createSurface",
  surfaceId: "main",
  components: [
    { component: "ChatApp", id: "chat", weight: 1 },
  ],
});
```

Iterate over every ACP component API to register a renderer:

```ts
import { ACP_COMPONENT_APIS } from "@agents-js/a2ui-types";

for (const api of ACP_COMPONENT_APIS) {
  registerRenderer(api.name, defaultRendererFor(api));
}
```

The `/catalog` subpath exposes `AcpCatalog`, `ACP_COMPONENT_APIS`, and the
per-component `*Api` zod schemas; the bare entry point re-exports the
A2UI-host-relevant `@a2ui/web_core` surface (catalog, component,
message-processor types) so consumers do not have to depend on
`@a2ui/web_core` directly.

## Documentation

Full API reference and protocol guides: <https://agents-js.bodal.dev/>.

## License

MIT — see [LICENSE](./LICENSE).

<!-- This README is hand-maintained. -->
