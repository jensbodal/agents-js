---
title: Federation peer-record signing & trust manifest
diataxis: reference
outline: [2, 3]
---

# Federation peer-record signing & trust manifest

## What this covers

When two or more agents-js gateways need to issue short-lived scoped
JWTs to each other's agents without sharing a long-lived admin token,
they negotiate via a challenge-mint flow grounded in a static trust
manifest of fleet-root-signed peer records. This document is the
canonical reference for the env-var contract, manifest schema, signing
byte recipe, hot-reload semantics, and HTTP mint/redeem endpoints
introduced in AJS-55.

Audience: an operator wiring an agents-js gateway against federated
peers, or a future agent provisioning trust material on a new host.
Every type name, env var, and file path below points at a real,
exported symbol or live code path in this repository — there are no
aspirational placeholders.

This is the contract surface. The operator deployment guide
([Operator guide](#operator-guide)) describes the prod-side procedure
(key locations, rotation runbook, peer registration) and is owned by
the deployment lane.

## Two surfaces

The AJS-55 substrate has two independent surfaces wired by the
gateway HTTP layer:

1. **Static trust** — a JSON trust manifest pointing at one signed
   peer record per peer entity. Each record is signed by the fleet
   root's ed25519 private key. The gateway loads + hot-reloads this
   manifest at startup; on the request path it answers "is this
   entity in the trust manifest, with what pubkey, with what
   capabilities?" without touching disk.
2. **Challenge mint** — two HTTP endpoints that let a known peer
   prove possession of its private key against a fresh nonce and
   receive a short-lived scoped JWT. No long-lived admin token
   passes across hosts.

A peer can be in the trust manifest without ever calling the mint
endpoints (the manifest entry is also consumed by the dispatcher's
target directory). The mint endpoints reject requests for any entity
not in the trust manifest, so the static trust surface is the gating
authority for the cryptographic surface.

## Env-var contract

The gateway's MCP mount (`apps/internal-gateway/agents-mcp-mount.ts`)
parses these env vars at startup. All AJS-55 vars are independent
from the AJS-56/57 JWT signing vars (`AGENTS_MCP_JWT_SIGNING_KEY`,
`AGENTS_MCP_JWT_ISSUER`, etc.); the mint endpoints reuse the same
HS256 signing path once a peer has redeemed a challenge.

| Variable                                 | Required                       | Format                          | Notes                                                                                          |
| ---------------------------------------- | ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `AGENTS_MCP_TRUST_MANIFEST_PATH`         | both-or-neither with the next  | absolute filesystem path        | Manifest JSON file (see [Manifest schema](#manifest-schema)). When omitted, tri-source resolution searches `/etc/agents-js/trust.json` then `~/.agents-js/trust.json`. |
| `AGENTS_MCP_TRUST_ROOT_PATH`             | both-or-neither with the prev. | absolute filesystem path        | Fleet root's ed25519 **public** key in PEM form. Private key never on a federated gateway; signing happens out-of-band on the operator's ceremony host. |
| `AGENTS_MCP_CHALLENGE_RATE_LIMIT`        | optional                       | `<rate>/min:<burst>`            | Per-IP token-bucket on `/api/agents/mint/challenge`. Default `30/min:10`. Example: `60/min:20` for a higher-traffic edge.       |
| `AGENTS_MCP_DISABLE_ADMIN_MINT`          | optional                       | `"1"` to disable                | Kill-switch for the legacy admin-token mint path (`POST /admin/mint`). Operators should flip to `1` once all peers have migrated to the cryptographic mint flow. |

**Both-or-neither rule** (enforced by the env parser): setting only
one of `AGENTS_MCP_TRUST_MANIFEST_PATH` or `AGENTS_MCP_TRUST_ROOT_PATH`
throws at startup with an explicit error. Half-configured trust is a
silent-failure shape; loud failure at startup is the right surface.

When neither path is set, the mint endpoints return `503 Service Unavailable`
with `reason: "substrate-not-configured"` — the gateway boots cleanly
but federation is off. This is the v1 default for fleets not yet
running AJS-55.

## Manifest schema

The trust manifest is a JSON file with one top-level `peers` array.
Each entry is a `{ entity, record_path }` pair. The `record_path` is
resolved relative to the manifest file's directory and points at the
signed peer record JSON for that entity.

```json
{
  "peers": [
    { "entity": "lxc-prod-1",  "record_path": "./records/lxc-prod-1.json" },
    { "entity": "lxc-prod-2",  "record_path": "./records/lxc-prod-2.json" },
    { "entity": "lxc-stage-1", "record_path": "./records/lxc-stage-1.json" }
  ]
}
```

The `entity` field in the manifest MUST match the `entity` field in
the signed peer record at `record_path`. A mismatch is treated as a
per-peer load failure (WARN-skipped, see [Hot-reload semantics](#hot-reload-semantics))
rather than a manifest-level error.

### Signed peer record

Each per-peer file at `record_path` is a JSON document of shape
`SignedPeerRecord` (`packages/host/src/peer-record.ts`):

```json
{
  "entity": "lxc-prod-1",
  "pubkey": "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
  "capabilities": {
    "scopes": ["agents.send_message", "agents.get_messages"],
    "matrix": { "room": "!cJxcDspkqBHcoALJCy:matrix.q4m.dev" },
    "inbox":  { "session": "lxc-prod-1-inbox" }
  },
  "signed_at": "2026-05-22T18:30:00Z",
  "signer": "fleet-root",
  "sig": "SpyC6iYyz0ElRnH0CLjBWQff3X20dgW4BYCuM4AuLMd5Uff+DuPbeLKZt4Df+bgmtnA8klMwKMg7ECOkshqVDA=="
}
```

| Field                  | Type                                | Notes                                                                                          |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `entity`               | non-empty string                    | Stable peer identifier (typically `<hostname>` or `<hostname>-<role>`). MUST match manifest.   |
| `pubkey`               | base64-encoded **raw 32-byte** ed25519 public key | NOT SPKI PEM. Generated alongside the peer's ed25519 private key at provisioning time.        |
| `capabilities.scopes`  | `string[]`                          | Scope strings the peer is permitted to request from the mint endpoint. Subset-enforced; see [Scope-subset enforcement](#scope-subset-enforcement). |
| `capabilities.matrix.room`   | optional string             | Matrix room ID this peer is permitted to route messages into.                                  |
| `capabilities.inbox.session` | optional string             | Durable inbox session this peer is permitted to write into.                                    |
| `signed_at`            | ISO 8601 UTC string                 | Operator-ceremony timestamp. Verifier does NOT enforce time-validity at request path — rotate by redeploying a new record. v1.1 rotation protocol will add staleness + future-skew checks. |
| `signer`               | string literal `"fleet-root"`       | v1 only accepts the literal `"fleet-root"`. v1.1 intermediate-CA landing widens this to the trust manifest's allowed-signer list. |
| `sig`                  | base64-encoded ed25519 signature    | Over the canonical signed bytes (see [Signing byte recipe](#signing-byte-recipe)).             |

The `pubkey` field is enforced as raw base64-encoded 32-byte at load
time — SPKI PEM input rejects as `malformed-record`. This avoids the
algorithm-confusion failure mode where a wrapped pubkey decodes
successfully against the wrong byte recipe.

## Signing byte recipe

Peer records are signed by the fleet root's ed25519 private key over
a domain-separated canonical byte string. The recipe is:

```text
signedBytes = UTF8("agents-js:peer-record:v1") || 0x0A || UTF8(JCS(recordWithoutSig))
sig         = ed25519.sign(fleetRootPrivKey, signedBytes)
```

Where:

- `JCS` is RFC 8785 JSON Canonicalization Scheme (UTF-16 code-unit
  key sort, short-escape control chars + `\u00XX` for others,
  forward-slash NOT escaped). Implementation:
  `packages/host/src/jcs.ts`.
- `recordWithoutSig` is the unsigned peer record (all fields above
  except `sig`).
- `0x0A` is a literal newline byte. JCS escapes control chars, so
  the delimiter cannot occur naturally inside the canonical payload —
  the byte string is unambiguously parseable.
- `"agents-js:peer-record:v1"` is the domain separator. Bumping the
  `:v1` suffix is the only path forward for a wire-format change.
  The same fleet key cannot produce a signature that verifies as both
  a peer record and (for example) a challenge-mint redeem request —
  cross-domain replay is prevented at the byte level.

The verifier (`verifyPeerRecord`) reconstructs the canonical bytes
independently from the record fields and checks the signature against
the trust-root public key. The verifier is **fail-closed** and
guarantees no-throw on any input — every error mode (malformed PEM,
non-base64 sig, missing fields, JCS-unrepresentable values) returns
`{ ok: false, reason }` rather than raising. Reasons are for logs +
telemetry only; callers MUST NOT branch on `reason` to selectively
accept records.

The same byte recipe applies to challenge-mint redeem signatures
([Challenge mint flow](#challenge-mint-flow)) with a different domain
separator (`"agents-js:challenge-mint:v1"`) so a signature produced
under one cannot be replayed under the other.

## Hot-reload semantics

The trust manifest is watched at the resolved `manifestPath` via
`fs.watch`. On any change, the gateway debounces for 200 ms (the
macOS double-fire window), then reloads the manifest + every signed
peer record + re-verifies every signature. The `targetDirectory` and
`peerKeyDirectory` references handed to the dispatcher and mint flow
are **stable** — the underlying entry maps swap atomically when the
reload completes, so request-path lookups never observe a torn read.

`trust-root.pub` is **not** watched. Rotating the trust anchor is
intentionally a restart-gated procedure because a partially-rotated
trust root is a security-relevant ambiguity: the verifier would
either accept records signed by the old root or the new root,
depending on which file was loaded last, and the operator has no
way to assert "I want this gateway's trust to switch atomically as
of this instant" without bouncing the process.

### Reload cases

| Case  | Trigger                                                              | Behavior                                                              |
| ----- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **A** | Peer entry removed from the manifest (revocation)                    | Entity disappears from `targetDirectory.resolve` on next reload. Subsequent mint-redeem attempts return `unknown-entity`. No restart required. |
| **B** | A peer's record file becomes temporarily unreadable or sig-invalid   | Previous-valid entry retained; per-peer WARN log emitted. Fail-open on transient errors. |
| **C** | Manifest itself becomes unreadable or unparseable                    | Previous-valid directory retained (does NOT swap in an empty directory). Fail-open on transient errors. |

The fail-open shape in Cases B and C protects against blast-radius
from a transient file-write race (e.g. an operator's `mv` mid-edit).
A persistent failure surfaces as repeated WARN logs but does not
take down the federation surface until the gateway restarts.

### Rotation procedure (operator-visible contract)

- **Add a peer**: write the new signed record file under the manifest
  directory, append a `{entity, record_path}` entry to the manifest
  JSON, save. The watcher reloads within the debounce window; the
  peer is reachable for mint requests immediately after.
- **Remove a peer**: delete the entry from the manifest JSON (Case A).
  The peer's existing JWTs remain valid until their TTL expires; the
  mint endpoint refuses to issue new ones.
- **Re-key a peer**: replace the peer's signed record file with one
  containing the new pubkey + a fresh fleet-root sig over the new
  record. Save. The watcher reloads; subsequent mint requests must
  be signed by the new private key.
- **Rotate the trust root**: replace `trust-root.pub` with the new
  pubkey, re-sign every peer record under the new fleet key, then
  restart the gateway. There is no zero-downtime rotation path in
  v1; this is a security-mode procedure documented in the
  [Operator guide](#operator-guide).

## Challenge mint flow

The mint flow is two HTTP endpoints, both mounted under the gateway's
agents-MCP surface:

```text
POST /api/agents/mint/challenge   (no auth; rate-limited per IP)
POST /api/agents/mint/redeem      (no auth; sig-gated)
```

The flow:

1. The peer (acting as client) `POST`s to `/api/agents/mint/challenge`.
   The gateway issues a fresh 32-byte challenge string (base64-encoded)
   with a 60-second TTL.
2. The peer constructs a redeem request `{ challenge, entity, requested_scopes, sig }`
   where `sig` is an ed25519 signature over the canonical signed bytes
   for this redeem request, signed by the peer's private key (the
   counterpart to the `pubkey` in its trust-manifest record).
3. The peer `POST`s the redeem request to `/api/agents/mint/redeem`.
4. The gateway looks up the peer's pubkey + capabilities from the
   trust manifest, verifies the sig, redeems the challenge
   (single-use), enforces `requested_scopes ⊆ entity.capabilities.scopes`,
   then mints an HS256 JWT (same signing path as the AJS-56/57 admin
   mint) and returns `{ token, expires_at, cid }`.

The redeem-request signing byte recipe mirrors the peer-record recipe:

```text
signedBytes = UTF8("agents-js:challenge-mint:v1") || 0x0A || UTF8(JCS({challenge, entity, requested_scopes}))
sig         = ed25519.sign(peerPrivKey, signedBytes)
```

### Failure reasons (wire-visible)

The redeem endpoint returns a distinctive `reason` field per failure
mode so operators can diagnose without reading server logs:

| Reason               | Cause                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| `invalid-args`       | Request body missing or malformed at the shape level.                 |
| `unknown-entity`     | `entity` is not in the trust manifest (or has no capabilities).       |
| `invalid-signature`  | `sig` does not verify against the entity's pubkey.                    |
| `invalid-challenge`  | `challenge` is `not-found`, `expired`, or `already-redeemed`.         |
| `invalid-scope`      | At least one `requested_scope` is not in `entity.capabilities.scopes`. The response carries the offending scope set. |

### Scope-subset enforcement

`requested_scopes ⊆ entity.capabilities.scopes` is enforced with
**no silent downgrade**. If the peer requests a scope it is not
permitted to hold, the entire redeem fails — the JWT is not minted
and the offending scope set is returned to the caller. This matches
the AJS-56/57 admin mint behavior and prevents the "asked for too
much, got reduced silently, didn't notice" failure shape.

### Replay detection

The challenge store distinguishes `not-found` (fabricated challenge
or post-TTL) from `already-redeemed` (replay attempt) using a
recently-redeemed window equal to the challenge TTL. The wire
`reason` is `invalid-challenge` in both cases (the security-equivalent
reject), but the server-side telemetry tags the distinction so
operators can detect replay-attack signatures.

### Rate limit

The unauthenticated `/api/agents/mint/challenge` endpoint is gated by
a per-IP token-bucket limiter (default 30 tokens/min, burst 10) to
bound the unauth-flood attack surface. Tunable via
`AGENTS_MCP_CHALLENGE_RATE_LIMIT` (see [Env-var contract](#env-var-contract)).
The rate-limit response carries `Retry-After` in milliseconds.

The challenge store has a hard size cap of 10 000 pending+redeemed
entries. On overflow, `/api/agents/mint/challenge` returns `503` with
`reason: "challenge-store-full"`. The 10K cap is sized for the v1
single-fleet deployment; multi-fleet deployments should expect to
re-tune in the gateway HTTP layer.

## Admin-mint deprecation

The legacy admin-token mint path (`POST /admin/mint`, gated by
`Authorization: Admin <AGENTS_MCP_ADMIN_TOKEN>`) remains mounted in
v1 for migration. Operators should flip
`AGENTS_MCP_DISABLE_ADMIN_MINT=1` once all peers have migrated to the
cryptographic mint flow. With the kill-switch set, `/admin/mint`
returns `410 Gone` with a pointer to `/api/agents/mint/challenge` and
`/redeem`.

The cryptographic mint flow does NOT require `AGENTS_MCP_ADMIN_TOKEN`
to be set. The admin token only gates the legacy path.

## Out of scope (v1)

Explicitly deferred to v1.1 or later:

- **Intermediate CAs.** v1 accepts only `signer: "fleet-root"` in
  peer records. v1.1 will widen the trusted-signer set to a
  manifest-declared list of intermediate CAs, with delegation
  semantics.
- **Time-validity enforcement.** `signed_at` is operator-facing
  metadata only. The verifier does not enforce staleness or
  future-skew. v1.1 rotation protocol adds both.
- **Trust-root hot-rotation.** Rotating `trust-root.pub` requires a
  gateway restart in v1. v1.1 will add a two-anchor period
  (old + new accepted concurrently for a defined window).
- **Per-peer rate limits.** v1 rate-limits per source IP only.
  Per-entity rate limits land alongside the audit-emission contract
  in a later milestone.
- **Cross-fleet trust federation.** v1 assumes a single fleet root.
  v1.1+ will define how two fleet roots cross-sign or how a peer can
  be declared trustworthy by multiple fleets.

## Operator guide

This section covers the prod-side procedure for deploying the AJS-55
federation surface against our reference infrastructure
(`agents-gateway` on Proxmox LXC 189). The contract surface above is
host-agnostic; this section is the LXC189-specific operator material
— host paths, ansible role variables, gopass conventions, and the
runbooks for peer onboarding + rotation.

### Deployment topology

The reference gateway runs as a systemd service inside a Proxmox LXC
container, deployed via an `agents_gateway` ansible role in the
fleet's infra repo.

| Surface             | Value                                                  |
| ------------------- | ------------------------------------------------------ |
| Proxmox node        | `princess` (`10.0.0.2`)                                |
| Container ID        | LXC 189                                                |
| Hostname            | `agents-gateway`                                       |
| DNS                 | `agents-gateway.q4m.dev`                               |
| LXC IP              | `10.0.1.192`                                           |
| Systemd unit        | `agents-js-gateway.service`                            |
| Runtime user        | `agents:agents` (unprivileged)                         |
| Working directory   | `/opt/agents-js`                                       |
| Env file            | `/etc/agents-js-gateway.env` (root-owned, mode `0600`) |
| Listening port      | `9321` (`0.0.0.0` inside LXC)                          |
| Ansible role        | `ansible/roles/agents_gateway/` (fleet infra repo)     |

### Host-side file conventions

The trust material referenced by `AGENTS_MCP_TRUST_MANIFEST_PATH` and
`AGENTS_MCP_TRUST_ROOT_PATH` lives under
`/var/lib/agents-js-gateway/` on the LXC, provisioned by the ansible
role:

| Material                     | Host path                                                 | Ownership        | Mode   |
| ---------------------------- | --------------------------------------------------------- | ---------------- | ------ |
| Trust root public key        | `/var/lib/agents-js-gateway/trust-root.pub`               | `agents:agents`  | `0644` |
| Trust manifest JSON          | `/var/lib/agents-js-gateway/trust-manifest.json`          | `agents:agents`  | `0644` |
| Peer records directory       | `/var/lib/agents-js-gateway/peer-records/`                | `agents:agents`  | `0750` |
| Signed peer record (per peer)| `/var/lib/agents-js-gateway/peer-records/<peer>.json`     | `agents:agents`  | `0644` |

The fleet root private key is **never** present on the gateway host —
signing happens off-host (operator workstation or ceremony machine).
Only the public key + signed records flow into the gateway.

### Gopass + ansible variable conventions

Source-of-truth for trust material lives in gopass (for the public
key) and as ansible variables (for the public signed peer records,
which contain no secret material).

| Material                           | Source                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Trust root public key              | gopass: `services/agents-js/gateway/<hostname>/trust-root.pub`                                            |
| Per-peer signed records            | ansible role var: `agents_gateway_agents_mcp_peer_records["<peer-name>"]` (canonical signed JSON string) |
| Federation toggle                  | ansible role var: `agents_gateway_agents_mcp_federation_enabled` (`true` to render the four AJS-55 vars) |
| Challenge rate limit override      | ansible role var: `agents_gateway_agents_mcp_challenge_rate_limit` (default `30`)                        |
| Admin-mint disable                 | ansible role var: `agents_gateway_agents_mcp_disable_admin_mint` (default `false`)                       |

The `<hostname>` segment follows the existing JWT-signing-key
convention (`services/agents-js/gateway/<hostname>/jwt-signing-key`)
so all per-gateway material is grouped under one gopass tree per
deployment.

### Peer onboarding runbook

Adding a new peer to the trust manifest:

1. **Peer**: generate an ed25519 keypair; share the public key + the
   entity name (matches `entity` in the signed peer record) with the
   fleet operator.
2. **Operator**: construct the unsigned peer record JSON (see
   [Manifest schema](#manifest-schema)) and sign it via JCS
   canonicalization + ed25519 against the fleet root private key.
3. **Operator**: commit the signed record JSON as an ansible role
   variable under `agents_gateway_agents_mcp_peer_records["<peer>"]`
   in the inventory (`group_vars` or `host_vars` for the gateway).
4. **Operator**: run the playbook with the `peer-records` tag:
   ```bash
   ansible-playbook -i inventory/<fleet>.yml \
     playbooks/agents-gateway.yml --tags peer-records
   ```
   The role writes the JSON file to
   `/var/lib/agents-js-gateway/peer-records/<peer>.json` and appends
   the manifest entry. The gateway's trust-manifest watcher picks up
   the change within the debounce window (see
   [Hot-reload semantics](#hot-reload-semantics)).
5. **Verify**: the new peer can immediately mint challenges. Failure
   modes (manifest stale, record sig invalid, scope subset violation)
   are surfaced as wire-visible reasons documented in the contract
   section above.

### Rotation runbook

**Peer key re-key** maps onto the contract's "Re-key a peer" case:
update the ansible variable with the new signed record, re-run the
playbook with `--tags peer-records`. No restart.

**Fleet trust root rotation** is the security-mode procedure flagged
in the contract section. Steps:

1. Generate new fleet root keypair off-host.
2. Re-sign **every** peer record under the new fleet key. Old records
   become invalid in one cutover.
3. Update gopass: `gopass insert services/agents-js/gateway/<hostname>/trust-root.pub`
   with the new public key bytes.
4. Update each `agents_gateway_agents_mcp_peer_records["<peer>"]`
   ansible variable with the newly-signed record JSON.
5. Run the playbook with both `trust-root` and `peer-records` tags.
   The role restages all material atomically and triggers a service
   restart (zero-downtime rotation is not supported in v1).
6. Distribute the new fleet pubkey to any peers that verify gateway
   announcements out-of-band.

### Production deployment status

::: warning AJS-55 not yet deployed
As of this doc's publish date, the reference `agents-gateway` is
running at an HEAD that predates the AJS-55 merge; the four AJS-55
env vars are not yet rendered into the prod env file, so mint
endpoints return `503 substrate-not-configured` per the contract
above. Activation requires a code redeploy + ansible role extension
+ trust material provisioning — rollout sequencing is tracked
out-of-band in the fleet's deployment audit doc. This section will
be updated when the surface is live.
:::

### Smoke acceptance procedure

Post-deployment, the operator verifies the federation surface is
operative by:

1. **Env vars rendered**: `sudo grep AGENTS_MCP_TRUST /etc/agents-js-gateway.env`
   shows both `_PATH` vars pointing at the expected locations.
2. **Files present**: `ls -la /var/lib/agents-js-gateway/{trust-root.pub,trust-manifest.json,peer-records/}`
   matches the [Host-side file conventions](#host-side-file-conventions)
   table.
3. **Service healthy**: `systemctl is-active agents-js-gateway.service`
   reports `active`; `journalctl -u agents-js-gateway.service --since '5 min ago'`
   contains no `trust-manifest-load` errors.
4. **503 no longer returned**: `curl -X POST -H 'content-type: application/json' \
   -d '{"entity":"<known-peer>"}' http://10.0.1.192:9321/api/agents/mint/challenge`
   returns `200` with a challenge nonce (not `503 substrate-not-configured`).
5. **Hot-reload works**: drop a fresh peer record into the directory,
   wait the debounce window, repeat step 4 with the new entity name —
   should return `200`. No service restart between steps.

A failure at any step is a deploy regression; consult the contract
section's failure-reason table to map the wire-visible reason back to
a substrate state.

## Source-of-truth references

The contract surface above is grounded in these exported symbols and
live code paths:

- **Signing primitives** — `packages/host/src/peer-record.ts`
  (`signPeerRecord`, `verifyPeerRecord`, `PEER_RECORD_DOMAIN_SEPARATOR`,
  `SignedPeerRecord`, `UnsignedPeerRecord`, `VerifyPeerRecordResult`,
  `PeerRecordRejectionReason`)
- **JCS canonical encoder** — `packages/host/src/jcs.ts`
- **ed25519 wrappers** — `packages/host/src/ed25519.ts`
  (`signEd25519`, `verifyEd25519`, `bytesToBase64`, `base64ToBytes`)
- **Trust manifest loader + watcher** —
  `packages/host/src/load-trust-manifest.ts`
  (`loadTrustManifest`, `watchTrustManifest`, `ReloadableTrustManifest`,
  `PeerKeyDirectory`, `TrustManifestLoadResult`)
- **Challenge-mint store + rate limiter** —
  `packages/host/src/challenge-mint-store.ts`
  (`createChallengeMintStore`, `createIpRateLimiter`,
  `ChallengeMintStore`, `IpRateLimiter`)
- **Mint redeem flow** — `packages/host/src/mint-redeem-flow.ts`
  (`redeemMintChallenge`, `buildChallengeMintSignedBytes`,
  `CHALLENGE_MINT_DOMAIN_SEPARATOR`, `MintRedeemRequest`,
  `MintRedeemResult`)
- **Gateway HTTP wireup + env parser** —
  `apps/internal-gateway/agents-mcp-mount.ts` (env-var parsing,
  `/api/agents/mint/challenge`, `/api/agents/mint/redeem`,
  `setupAgentsMcpMount`)

Related contracts:

- [Remote gateway federation — v1 contract](./v1-contract.md) — how
  parent gateways advertise + dispatch to remote-backed harnesses.
  AJS-55 is the trust layer underneath this surface for federated
  hosts that need to issue scoped JWTs to each other.
- AJS-56/57 hosted-MCP tool surface + runtime session protocol —
  same HS256 JWT signing path the mint endpoints reuse once a
  challenge has been redeemed.
