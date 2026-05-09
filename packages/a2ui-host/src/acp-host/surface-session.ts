import type {
  A2uiClientAction,
  A2uiMessage,
  ActionListener,
  ComponentApi,
} from "@agents-js/a2ui-types";
import { AcpCatalog, type Catalog, MessageProcessor } from "@agents-js/a2ui-types";
import type { Logger } from "@agents-js/acp-host";
import { getBasicCatalog } from "@agents-js/validation";
import type { HostSurfaceAdapter } from "./host-surface-adapter.ts";

export interface SurfaceSessionOptions {
  adapter: HostSurfaceAdapter;
  log: Logger;
  catalogs?: Catalog<ComponentApi>[];
  actionHandler?: ActionListener;
  emitActionsAsSurfaceEvents?: boolean;
  emitSurfaceEvent?: (surfaceId: string, event: unknown) => void;
}

function defaultCatalogs(): Catalog<ComponentApi>[] {
  return [getBasicCatalog(), AcpCatalog];
}

export class SurfaceSession {
  private readonly adapter: HostSurfaceAdapter;
  private readonly log: Logger;
  private readonly processor: MessageProcessor<ComponentApi>;
  private closed = false;

  constructor(options: SurfaceSessionOptions) {
    this.adapter = options.adapter;
    this.log = options.log;
    const catalogs = options.catalogs ?? defaultCatalogs();
    const handler = this.resolveActionHandler(options);
    this.processor = new MessageProcessor<ComponentApi>(catalogs, handler);
  }

  private resolveActionHandler(opts: SurfaceSessionOptions): ActionListener | undefined {
    if (opts.actionHandler) {
      return opts.actionHandler;
    }
    const emit = opts.emitSurfaceEvent;
    if (opts.emitActionsAsSurfaceEvents === false || !emit) {
      return undefined;
    }
    return (action: A2uiClientAction) => {
      if (this.closed) return;
      try {
        emit(action.surfaceId, action);
      } catch (error) {
        this.log.error("SurfaceSession default actionHandler emit failed", {
          surfaceId: action.surfaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  get surfaceIds(): ReadonlySet<string> {
    return new Set(this.processor.model.surfacesMap.keys());
  }

  async apply(message: A2uiMessage): Promise<void> {
    if (this.closed) {
      this.log.warn("SurfaceSession.apply called after close; dropping message", {
        version: message.version,
      });
      return;
    }

    try {
      this.processor.processMessages([message]);
    } catch (error) {
      this.log.error("A2UI processor failed to apply message", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.adapter.handleSurfaceMessage(message);
    } catch (error) {
      this.log.error("HostSurfaceAdapter.handleSurfaceMessage failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const stillOpen = Array.from(this.processor.model.surfacesMap.keys());

    try {
      this.processor.model.dispose();
    } catch (error) {
      this.log.warn("SurfaceGroupModel.dispose failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.adapter.handleSurfaceClosed) {
      for (const id of stillOpen) {
        try {
          await this.adapter.handleSurfaceClosed(id);
        } catch (error) {
          this.log.error("HostSurfaceAdapter.handleSurfaceClosed failed", {
            surfaceId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
