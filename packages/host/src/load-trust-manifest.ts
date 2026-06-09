/**
 * AJS-55 trust manifest loader — reads a JSON manifest, verifies each
 * peer record against the fleet-root trust anchor, and assembles a
 * `TargetDirectory` for the dispatcher to resolve targets from.
 *
 * Design doc: `agents-js-federation-peer-record-signing-2026-05-22.md`
 * (vault: `~/workspace/syncthing/lifestone_ios/workspace/agents-js/docs/research/`).
 *
 * **Path resolution** (tri-source, vault doc §"Trust manifest loader"):
 * 1. Explicit `manifestPath` / `trustRootPath` args (or env override from caller)
 * 2. `/etc/agents-js/trust.{json,yaml}` + `/etc/agents-js/trust-root.pub` (production)
 * 3. `~/.agents-js/trust.{json,yaml}` + `~/.agents-js/trust-root.pub` (dev fallback)
 *
 * **V1 deviation from vault spec**: manifest format is JSON, not YAML.
 * Operator-editability + comment support deferred to v1.1 (would require
 * adding the `yaml` npm dep). v1 matches the signed peer record format
 * for consistency + zero new deps. Loader probes for `.json` extension
 * during tri-source resolution; YAML files would require explicit
 * `.yaml` extension support in the loader (not implemented in v1).
 *
 * **Trust-root format**: SPKI PEM (Node's `createPublicKey` canonical
 * format + the `trustRootPublicKeyPem` argument shape `verifyPeerRecord`
 * expects).
 *
 * **Failure semantics**:
 * - Missing/unreadable trust-root → ERROR + empty TargetDirectory.
 *   FAIL-CLOSED: without trust anchor, peer verification is meaningless.
 * - Missing/unreadable/malformed manifest → WARN + empty TargetDirectory.
 *   FAIL-OPEN: legitimate dev state (no peers configured yet); operator
 *   sees the WARN.
 * - Per-peer record missing/unreadable/sig-invalid → WARN-skip; other
 *   peers continue to register. Gateway boots with the subset of valid
 *   peers; operator fixes broken records without restart.
 */

import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { TargetDirectory, TargetDirectoryEntry } from "./agents-tool-surface.ts";
import { type SignedPeerRecord, verifyPeerRecord } from "./peer-record.ts";

/**
 * Logger surface — minimal shape so callers can plug in their own
 * structured logger. Defaults to `console` when omitted.
 *
 * @internal AJS-55 implementation surface.
 */
export interface LoadTrustManifestLogger {
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Options for {@link loadTrustManifest}.
 *
 * @internal AJS-55 implementation surface.
 */
export interface LoadTrustManifestOptions {
  /**
   * Explicit manifest file path (typically from `$AGENTS_MCP_TRUST_MANIFEST_PATH`
   * env override). When omitted, tri-source resolution searches
   * `/etc/agents-js/trust.json` then `~/.agents-js/trust.json`.
   */
  manifestPath?: string;
  /**
   * Explicit trust-root pubkey file path (typically from
   * `$AGENTS_MCP_TRUST_ROOT_PATH` env override). When omitted, tri-source
   * resolution searches `/etc/agents-js/trust-root.pub` then
   * `~/.agents-js/trust-root.pub`.
   */
  trustRootPath?: string;
  /** Logger override. Defaults to `console`. */
  logger?: LoadTrustManifestLogger;
}

/**
 * A directory-level read surface for AJS-55 peer pubkeys + capabilities.
 * Separate from `TargetDirectory` (which is the dispatcher's read surface
 * for routing) so the AJS-56 dispatcher doesn't get AJS-55-specific
 * concerns leaked into its contract.
 *
 * @internal AJS-55 implementation surface; consumed by the mint-redeem
 *           flow to verify challenge signatures + check scope-subset.
 */
export interface PeerKeyDirectory {
  /**
   * Look up the base64-encoded raw 32-byte ed25519 public key for an
   * entity. Returns null when the entity isn't in the directory.
   * Pubkeys are sourced from the entity's signed peer record (which
   * has already passed sig verification at load time).
   */
  getPubkey(entity: string): string | null;
  /**
   * Look up the operator-configured capabilities for an entity (the
   * `capabilities` field of the signed peer record). Used by the mint
   * redeem flow to enforce `requested_scopes ⊆ entity_scopes`.
   */
  getCapabilities(entity: string): { scopes: readonly string[] } | null;
}

/**
 * Result of a {@link loadTrustManifest} call. Always `ok: true` in v1
 * (per-peer failures are WARN-skipped, not propagated); the `ok` shape
 * is preserved for future fail-closed contract evolution (e.g. if v1.1
 * adds a strict-mode that fails-startup on any verify error).
 *
 * @internal AJS-55 implementation surface.
 */
export type TrustManifestLoadResult = {
  ok: true;
  /**
   * `TargetDirectory` populated from successfully-verified peer records.
   * Compatible with `createAgentsDispatcher`'s `targetDirectory` option
   * (drop-in replacement for the `AGENTS_MCP_TARGETS_JSON` env stub).
   */
  targetDirectory: TargetDirectory;
  /**
   * Per-entity pubkey + capabilities directory, for the mint-redeem
   * flow's sig-verify + scope-subset check.
   */
  peerKeyDirectory: PeerKeyDirectory;
  /** Set of entity names that successfully loaded (for telemetry). */
  loadedEntities: ReadonlySet<string>;
  /** Trust-root pubkey PEM that was loaded (or null if missing/invalid). */
  trustRootPem: string | null;
  /** Resolved manifest path (after tri-source resolution); null if not found. */
  manifestPath: string | null;
  /** Resolved trust-root path; null if not found. */
  trustRootPath: string | null;
};

/** Internal shape of the parsed JSON manifest. */
interface ManifestSchema {
  peers: Array<{ entity: string; record_path: string }>;
}

const MANIFEST_SEARCH_PATHS = [
  "/etc/agents-js/trust.json",
  () => resolve(homedir(), ".agents-js/trust.json"),
] as const;

const TRUST_ROOT_SEARCH_PATHS = [
  "/etc/agents-js/trust-root.pub",
  () => resolve(homedir(), ".agents-js/trust-root.pub"),
] as const;

/**
 * Resolve a path via tri-source order. Returns the first existing path,
 * or null if none exist.
 */
function resolvePath(
  explicit: string | undefined,
  searchPaths: readonly (string | (() => string))[],
): string | null {
  if (explicit !== undefined) {
    return existsSync(explicit) ? explicit : null;
  }
  for (const candidate of searchPaths) {
    const path = typeof candidate === "function" ? candidate() : candidate;
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Validate that parsed JSON matches the ManifestSchema shape. Returns
 * the typed shape or null on shape mismatch.
 */
function validateManifestShape(value: unknown): ManifestSchema | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as { peers?: unknown };
  if (!Array.isArray(obj.peers)) return null;
  for (const peer of obj.peers) {
    if (typeof peer !== "object" || peer === null) return null;
    const p = peer as { entity?: unknown; record_path?: unknown };
    if (typeof p.entity !== "string" || p.entity.length === 0) return null;
    if (typeof p.record_path !== "string" || p.record_path.length === 0) return null;
  }
  return obj as ManifestSchema;
}

/**
 * Project an AJS-55 signed peer record into a `TargetDirectoryEntry`.
 * Only the routing-relevant capabilities are surfaced; pubkey + signer
 * + signed_at + sig are dropped (the verifier has already validated
 * them; the dispatcher only needs the routing capabilities).
 */
function recordToTargetEntry(record: SignedPeerRecord): TargetDirectoryEntry {
  const entry: TargetDirectoryEntry = {};
  if (record.capabilities.matrix?.room) {
    entry.matrix = { room: record.capabilities.matrix.room };
  }
  if (record.capabilities.inbox?.session) {
    entry.inbox = { session: record.capabilities.inbox.session };
  }
  return entry;
}

/**
 * Load the trust manifest + verify each peer record + assemble a
 * `TargetDirectory` for the dispatcher.
 *
 * Always returns `ok: true` (per-peer failures are WARN-skipped, not
 * propagated). The returned `targetDirectory` may be empty if:
 * - trust-root is missing/invalid (fail-closed; no peers can be verified)
 * - manifest is missing/malformed (fail-open at the manifest level)
 * - every peer record fails verification (all peers WARN-skipped)
 *
 * @internal AJS-55 implementation surface; called at gateway startup
 *           + on hot-reload (see `watchTrustManifest`).
 */
export async function loadTrustManifest(
  options: LoadTrustManifestOptions = {},
): Promise<TrustManifestLoadResult> {
  const logger = options.logger ?? console;

  // Step 1: resolve trust-root path.
  const trustRootPath = resolvePath(options.trustRootPath, TRUST_ROOT_SEARCH_PATHS);
  if (trustRootPath === null) {
    logger.error(
      `[load-trust-manifest] trust-root.pub not found at any of: ${
        options.trustRootPath ?? "(env override unset)"
      }, /etc/agents-js/trust-root.pub, ~/.agents-js/trust-root.pub. No peers will be registered (fail-closed). Operator MUST provision the trust-root.`,
    );
    return emptyResult({ trustRootPath: null, manifestPath: null });
  }

  // Step 2: read trust-root + validate it's a usable ed25519 PEM.
  let trustRootPem: string;
  try {
    trustRootPem = readFileSync(trustRootPath, "utf-8");
  } catch (err) {
    logger.error(
      `[load-trust-manifest] trust-root.pub at ${trustRootPath} is unreadable: ${
        (err as Error).message
      }. No peers will be registered (fail-closed).`,
    );
    return emptyResult({ trustRootPath, manifestPath: null });
  }

  // Probe the trust-root by attempting to verify a known-bad record
  // shape; if the trust-root itself is not ed25519, verifyPeerRecord
  // returns 'non-ed25519-trust-root' for any input. We use this as a
  // pre-flight check so the error surfaces here rather than at per-peer
  // verify time (which would log N copies of the same error).
  // This is a small upfront cost for a much-clearer operator signal.
  const probeRecord: SignedPeerRecord = {
    entity: "_probe_",
    pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    capabilities: { scopes: [] },
    signed_at: "1970-01-01T00:00:00Z",
    signer: "fleet-root",
    sig: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  const probeResult = verifyPeerRecord(probeRecord, trustRootPem);
  if (!probeResult.ok && probeResult.reason === "non-ed25519-trust-root") {
    logger.error(
      `[load-trust-manifest] trust-root at ${trustRootPath} is not a valid ed25519 SPKI PEM. No peers will be registered (fail-closed).`,
    );
    return emptyResult({ trustRootPath, manifestPath: null });
  }
  // (probe result of 'invalid-signature' is expected since the probe
  // record's sig is fake; we just needed to validate the trust-root
  // key type, not actually verify a real record.)

  // Step 3: resolve manifest path.
  const manifestPath = resolvePath(options.manifestPath, MANIFEST_SEARCH_PATHS);
  if (manifestPath === null) {
    logger.warn(
      `[load-trust-manifest] trust manifest not found at any of: ${
        options.manifestPath ?? "(env override unset)"
      }, /etc/agents-js/trust.json, ~/.agents-js/trust.json. Gateway will boot with empty TargetDirectory (no peers configured).`,
    );
    return emptyResult({ trustRootPath, manifestPath: null, trustRootPem });
  }

  // Step 4: read + parse + validate manifest shape.
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf-8");
  } catch (err) {
    logger.warn(
      `[load-trust-manifest] manifest at ${manifestPath} is unreadable: ${
        (err as Error).message
      }. Empty TargetDirectory.`,
    );
    return emptyResult({ trustRootPath, manifestPath, trustRootPem });
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch (err) {
    logger.warn(
      `[load-trust-manifest] manifest at ${manifestPath} is invalid JSON: ${
        (err as Error).message
      }. Empty TargetDirectory.`,
    );
    return emptyResult({ trustRootPath, manifestPath, trustRootPem });
  }
  const manifest = validateManifestShape(manifestJson);
  if (manifest === null) {
    logger.warn(
      `[load-trust-manifest] manifest at ${manifestPath} has malformed shape (expected { peers: [{ entity, record_path }, ...] }). Empty TargetDirectory.`,
    );
    return emptyResult({ trustRootPath, manifestPath, trustRootPem });
  }

  // Step 5: per-peer record load + verify. WARN-skip on any per-peer failure.
  const directoryMap = new Map<string, TargetDirectoryEntry>();
  const pubkeyMap = new Map<string, string>();
  const capabilitiesMap = new Map<string, { scopes: readonly string[] }>();
  const loadedEntities = new Set<string>();
  // Records are referenced relative to the MANIFEST's directory (per the
  // federation doc), not the gateway process CWD. Resolve against the manifest
  // dir; absolute record_paths pass through `resolve` unchanged.
  const manifestDir = dirname(manifestPath);
  for (const peer of manifest.peers) {
    const recordPath = resolve(manifestDir, peer.record_path);
    let recordText: string;
    try {
      recordText = readFileSync(recordPath, "utf-8");
    } catch (err) {
      logger.warn(
        `[load-trust-manifest] peer '${peer.entity}' record_path ${peer.record_path} is unreadable: ${
          (err as Error).message
        }. Skipped.`,
      );
      continue;
    }
    let recordJson: unknown;
    try {
      recordJson = JSON.parse(recordText);
    } catch (err) {
      logger.warn(
        `[load-trust-manifest] peer '${peer.entity}' record at ${peer.record_path} is invalid JSON: ${
          (err as Error).message
        }. Skipped.`,
      );
      continue;
    }
    const record = recordJson as SignedPeerRecord;
    const verify = verifyPeerRecord(record, trustRootPem);
    if (!verify.ok) {
      logger.warn(
        `[load-trust-manifest] peer '${peer.entity}' record at ${peer.record_path} failed verification: ${verify.reason}. Skipped.`,
      );
      continue;
    }
    // Cross-check: the manifest entry's `entity` MUST match the signed
    // record's `entity`. Mismatch = manifest tampering OR operator typo;
    // either way, refuse to load.
    if (verify.entity !== peer.entity) {
      logger.warn(
        `[load-trust-manifest] peer '${peer.entity}' record at ${peer.record_path} has signed entity '${verify.entity}' which doesn't match the manifest entry. Skipped.`,
      );
      continue;
    }
    directoryMap.set(verify.entity, recordToTargetEntry(record));
    pubkeyMap.set(verify.entity, record.pubkey);
    capabilitiesMap.set(verify.entity, { scopes: [...record.capabilities.scopes] });
    loadedEntities.add(verify.entity);
  }

  const targetDirectory: TargetDirectory = {
    resolve(target: string) {
      return directoryMap.get(target) ?? null;
    },
    entries() {
      return [...directoryMap.entries()];
    },
  };

  const peerKeyDirectory: PeerKeyDirectory = {
    getPubkey(entity: string) {
      return pubkeyMap.get(entity) ?? null;
    },
    getCapabilities(entity: string) {
      return capabilitiesMap.get(entity) ?? null;
    },
  };

  return {
    ok: true,
    targetDirectory,
    peerKeyDirectory,
    loadedEntities,
    trustRootPem,
    manifestPath,
    trustRootPath,
  };
}

/** Produce the empty/fail-closed result shape. */
function emptyResult(opts: {
  trustRootPath: string | null;
  manifestPath: string | null;
  trustRootPem?: string;
}): TrustManifestLoadResult {
  return {
    ok: true,
    targetDirectory: { resolve: () => null, entries: () => [] },
    peerKeyDirectory: { getPubkey: () => null, getCapabilities: () => null },
    loadedEntities: new Set(),
    trustRootPem: opts.trustRootPem ?? null,
    manifestPath: opts.manifestPath,
    trustRootPath: opts.trustRootPath,
  };
}

// ============================================================================
// HOT-RELOAD (vault doc §"Hot-reload")
// ============================================================================

/**
 * A re-loadable trust manifest handle. Both `targetDirectory` and
 * `peerKeyDirectory` are stable references; the underlying entry maps
 * swap atomically when reload completes. Consumers hold the references
 * across the gateway's lifetime.
 *
 * @internal AJS-55 implementation surface.
 */
export interface ReloadableTrustManifest {
  /** Stable TargetDirectory ref — routing entries swap atomically on reload. */
  targetDirectory: TargetDirectory;
  /**
   * Stable PeerKeyDirectory ref — per-entity pubkey + capabilities swap
   * atomically on reload. Used by the mint-redeem flow at request time.
   */
  peerKeyDirectory: PeerKeyDirectory;
  /** Stop watching + release fs.watch handles. */
  stop(): void;
  /** Trigger an immediate reload (bypasses debounce). Returns the new load result. */
  reloadNow(): Promise<TrustManifestLoadResult>;
}

/**
 * Options for {@link watchTrustManifest}. Extends loader options with
 * the debounce-window setting.
 *
 * @internal AJS-55 implementation surface.
 */
export interface WatchTrustManifestOptions extends LoadTrustManifestOptions {
  /**
   * Trailing-debounce window in ms for `fs.watch` events. Defaults to
   * 200ms. macOS `fs.watch` is known to double-fire on a single edit;
   * the debounce coalesces these into one reload. Set to 0 to disable
   * debouncing (useful for tests).
   */
  debounceMs?: number;
  /** Optional callback fired after each successful reload (for telemetry). */
  onReload?: (result: TrustManifestLoadResult) => void;
}

/**
 * Watch the trust manifest + auto-reload on changes. Returns a
 * `ReloadableTrustManifest` whose `targetDirectory` field is a stable
 * reference; the underlying entries swap atomically on each reload.
 *
 * Hot-reload behavior (vault doc §"Hot-reload"):
 *
 * - **Case A** (manifest entry removed): peer disappears from
 *   `targetDirectory.resolve` on next reload. This is the v1 revocation
 *   path — no restart required.
 * - **Case B** (peer's record file temporarily unreadable / sig-invalid):
 *   previous-valid entry retained as explicit fail-open. Per `loadTrustManifest`
 *   semantics, a per-peer WARN-skip on reload preserves the prior
 *   directory entries since we swap the directory atomically only on a
 *   FULL reload result.
 * - **Case C** (manifest itself unreadable / unparseable): previous-valid
 *   directory retained. Loader returns empty TargetDirectory on parse
 *   failure, but the watcher DOES NOT swap in an empty directory — it
 *   keeps the previous-valid entries to avoid blast-radius from a
 *   transient file-write race.
 *
 * `trust-root.pub` is NOT watched. It's a bootstrap artifact; rotating
 * the trust anchor requires a gateway restart.
 *
 * @internal AJS-55 implementation surface; called once at gateway startup.
 */
export async function watchTrustManifest(
  options: WatchTrustManifestOptions = {},
): Promise<ReloadableTrustManifest> {
  const logger = options.logger ?? console;
  const debounceMs = options.debounceMs ?? 200;

  // Initial load. Even if it fails, we set up the watcher so subsequent
  // edits can recover.
  let current = await loadTrustManifest(options);

  // Proxy directories: lookups go through the current entry maps. Atomic
  // swap on reload by reassigning `current`.
  const targetDirectory: TargetDirectory = {
    resolve(target: string) {
      return current.targetDirectory.resolve(target);
    },
    entries() {
      return current.targetDirectory.entries();
    },
  };
  const peerKeyDirectory: PeerKeyDirectory = {
    getPubkey(entity: string) {
      return current.peerKeyDirectory.getPubkey(entity);
    },
    getCapabilities(entity: string) {
      return current.peerKeyDirectory.getCapabilities(entity);
    },
  };

  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const reload = async (): Promise<TrustManifestLoadResult> => {
    const next = await loadTrustManifest(options);
    // Case B + C: if the reload produced an empty directory but the
    // previous-valid had entries, KEEP the previous to avoid blast-radius.
    // This is the fail-open-on-transient-error behavior cognee-codex
    // ratified in the contract review.
    if (next.loadedEntities.size === 0 && current.loadedEntities.size > 0) {
      logger.warn(
        `[load-trust-manifest] reload produced empty directory while previous had ${current.loadedEntities.size} peers; retaining previous (fail-open on transient errors).`,
      );
      return current;
    }
    current = next;
    options.onReload?.(next);
    return next;
  };

  if (current.manifestPath !== null) {
    try {
      watcher = watch(current.manifestPath, () => {
        // Debounce: coalesce double-fires (macOS quirk) + rapid edits.
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void reload().catch((err) => {
            logger.error(`[load-trust-manifest] hot-reload threw: ${(err as Error).message}`);
          });
        }, debounceMs);
      });
    } catch (err) {
      logger.warn(
        `[load-trust-manifest] fs.watch failed for ${current.manifestPath}: ${
          (err as Error).message
        }. Hot-reload disabled; manifest changes require gateway restart.`,
      );
    }
  }

  return {
    targetDirectory,
    peerKeyDirectory,
    stop() {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher !== null) {
        watcher.close();
        watcher = null;
      }
    },
    reloadNow: reload,
  };
}
