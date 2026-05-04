#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

DOMAIN=${DOCS_TUNNEL_DOMAIN:-agents-js.bodal.dev}
PORT=${DOCS_TUNNEL_PORT:-5173}
CONFIG_PATH="$REPO_ROOT/.cloudflared-${DOMAIN}.yaml"
USER_CONFIG_PATH="$HOME/.cloudflared/config.yaml"
EFFECTIVE_ACCESS_AUD=""
EFFECTIVE_ACCESS_AUD_SOURCE=""
DISCOVERED_ACCESS_AUD=""
DISCOVERED_ACCESS_POLICY_ID=""
DISCOVERY_ATTEMPTED=0
DISCOVERY_ERROR=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/docs-tunnel.sh serve
  ./scripts/docs-tunnel.sh doctor
  ./scripts/docs-tunnel.sh config
  ./scripts/docs-tunnel.sh setup
  ./scripts/docs-tunnel.sh tunnel

Environment:
  DOCS_TUNNEL_DOMAIN   Public docs hostname (default: agents-js.bodal.dev)
  DOCS_TUNNEL_PORT     Local VitePress port (default: 5173)
  DOCS_CF_ACCESS_AUD   Optional override for the Cloudflare Access audience
  DOCS_TUNNEL_ALLOW_PRODUCTION_TUNNEL=1  Explicitly allow a local connector on the production hostname
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

assert_port_free() {
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT is already in use. Set DOCS_TUNNEL_PORT to a free port before starting the docs tunnel workflow." >&2
    exit 1
  fi
}

resolve_tunnel_id() {
  local tunnel_id
  tunnel_id=$(cloudflared tunnel list | awk -v domain="$DOMAIN" '$2 == domain { print $1; exit }')
  if [[ -z "$tunnel_id" ]]; then
    echo "Unable to resolve Cloudflare tunnel ID for $DOMAIN." >&2
    exit 1
  fi
  printf '%s\n' "$tunnel_id"
}

discovery_failure_message() {
  echo "Access audience discovery failed; authenticate with cloudflared or set DOCS_CF_ACCESS_AUD" >&2
}

discover_access_identity() {
  local token
  local parsed

  if [[ "$DISCOVERY_ATTEMPTED" -eq 1 ]]; then
    [[ -n "$DISCOVERED_ACCESS_AUD" ]] && return 0
    return 1
  fi

  DISCOVERY_ATTEMPTED=1
  require_command cloudflared
  require_command python3

  if ! token=$(cloudflared access token "https://$DOMAIN/" 2>/dev/null); then
    DISCOVERY_ERROR="cloudflared access token failed"
    return 1
  fi

  if ! parsed=$(python3 - "$token" <<'PY'
import base64
import json
import sys

token = sys.argv[1].strip()
parts = token.split(".")
if len(parts) < 2:
    raise SystemExit("malformed token")

payload = parts[1] + ("=" * (-len(parts[1]) % 4))
claims = json.loads(base64.urlsafe_b64decode(payload))
aud = claims.get("aud")

if isinstance(aud, str):
    effective_aud = aud
elif isinstance(aud, list):
    if len(aud) != 1 or not isinstance(aud[0], str):
        raise SystemExit("multiple audiences")
    effective_aud = aud[0]
else:
    raise SystemExit("missing aud")

policy_id = claims.get("policy_id", "")
if not isinstance(policy_id, str):
    policy_id = ""

print(effective_aud)
print(policy_id)
PY
  ); then
    DISCOVERY_ERROR="could not decode a single audience from the access token"
    return 1
  fi

  DISCOVERED_ACCESS_AUD=$(printf '%s\n' "$parsed" | sed -n '1p')
  DISCOVERED_ACCESS_POLICY_ID=$(printf '%s\n' "$parsed" | sed -n '2p')
  return 0
}

resolve_effective_access_audience() {
  if [[ -n "${DOCS_CF_ACCESS_AUD:-}" ]]; then
    EFFECTIVE_ACCESS_AUD=$DOCS_CF_ACCESS_AUD
    EFFECTIVE_ACCESS_AUD_SOURCE="override"
    return 0
  fi

  if ! discover_access_identity; then
    discovery_failure_message
    return 1
  fi

  EFFECTIVE_ACCESS_AUD=$DISCOVERED_ACCESS_AUD
  EFFECTIVE_ACCESS_AUD_SOURCE="discovered"
  return 0
}

ensure_tunnel() {
  require_command cloudflared
  if ! cloudflared tunnel list | awk '{ print $2 }' | grep -Fxq "$DOMAIN"; then
    echo "Creating Cloudflare tunnel $DOMAIN..." >&2
    cloudflared tunnel create "$DOMAIN" >&2
  fi
}

ensure_dns_route() {
  echo "Ensuring DNS route for $DOMAIN..." >&2
  cloudflared tunnel route dns --overwrite-dns "$DOMAIN" "$DOMAIN" >&2
}

write_config() {
  local tunnel_id=$1
  local credentials_file

  credentials_file="$HOME/.cloudflared/${tunnel_id}.json"
  if [[ ! -f "$credentials_file" ]]; then
    echo "Missing Cloudflare credentials file: $credentials_file" >&2
    exit 1
  fi

  cat >"$CONFIG_PATH" <<EOF
tunnel: $DOMAIN
credentials-file: $credentials_file

ingress:
  - hostname: $DOMAIN
    service: http://127.0.0.1:$PORT
    originRequest:
      access:
        required: true
        teamName: "bodal"
        audTag:
          - "$EFFECTIVE_ACCESS_AUD"
  - service: http_status:404
EOF

  printf '%s\n' "$CONFIG_PATH"
}

write_existing_config() {
  require_command cloudflared
  resolve_effective_access_audience
  write_config "$(resolve_tunnel_id)"
}

setup_config() {
  ensure_tunnel
  ensure_dns_route
  resolve_effective_access_audience
  write_config "$(resolve_tunnel_id)"
}

inspect_config_aud_tags() {
  local config_path=$1

  require_command python3
  python3 - "$config_path" "$DOMAIN" <<'PY'
from pathlib import Path
import sys

config_path = Path(sys.argv[1]).expanduser()
domain = sys.argv[2]

if not config_path.is_file():
    print("missing")
    raise SystemExit(0)

lines = config_path.read_text().splitlines()
status = "unmatched"
aud_tags = []
in_matching_block = False
block_indent = None
collecting_aud = False
aud_indent = None

for raw_line in lines:
    line = raw_line.rstrip()
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        continue

    indent = len(line) - len(line.lstrip(" "))

    if stripped.startswith("- hostname:"):
        candidate = stripped.split(":", 1)[1].strip().strip('"').strip("'")
        in_matching_block = candidate == domain
        block_indent = indent
        collecting_aud = False
        aud_indent = None
        if in_matching_block:
            status = "matched"
        continue

    if in_matching_block and stripped.startswith("- ") and indent <= block_indent:
        in_matching_block = False
        collecting_aud = False
        aud_indent = None

    if not in_matching_block:
        continue

    if stripped == "audTag:":
        collecting_aud = True
        aud_indent = indent
        continue

    if collecting_aud:
        if stripped.startswith("- ") and indent > aud_indent:
            aud_tags.append(stripped[2:].strip().strip('"').strip("'"))
            continue
        if indent <= aud_indent:
            collecting_aud = False

print(status)
for value in aud_tags:
    print(value)
PY
}

print_aud_list() {
  local label=$1
  shift || true

  if [[ "$#" -eq 0 ]]; then
    echo "$label: (none)"
    return
  fi

  echo "$label:"
  while (($# > 0)); do
    echo "  - $1"
    shift
  done
}

run_doctor() {
  local discovered_status="available"
  local repo_config_lines=()
  local user_config_lines=()
  local repo_config_status
  local user_config_status
  local repo_config_auds=()
  local user_config_auds=()
  local verdict="OK"
  local verdict_level=0
  local exit_code=0
  local messages=()
  local config_value
  local repo_matches_discovered=0
  local user_matches_discovered=0

  raise_verdict() {
    local next_verdict=$1
    local next_level=$2

    if ((next_level > verdict_level)); then
      verdict=$next_verdict
      verdict_level=$next_level
    fi
  }

  if ! discover_access_identity; then
    discovered_status="unavailable"
  fi

  if ! resolve_effective_access_audience; then
    EFFECTIVE_ACCESS_AUD=""
    EFFECTIVE_ACCESS_AUD_SOURCE=""
  fi

  mapfile -t repo_config_lines < <(inspect_config_aud_tags "$CONFIG_PATH")
  mapfile -t user_config_lines < <(inspect_config_aud_tags "$USER_CONFIG_PATH")

  repo_config_status=${repo_config_lines[0]:-missing}
  user_config_status=${user_config_lines[0]:-missing}
  if ((${#repo_config_lines[@]} > 1)); then
    repo_config_auds=("${repo_config_lines[@]:1}")
  fi
  if ((${#user_config_lines[@]} > 1)); then
    user_config_auds=("${user_config_lines[@]:1}")
  fi

  if [[ "$discovered_status" == "unavailable" ]]; then
    if [[ -n "${DOCS_CF_ACCESS_AUD:-}" ]]; then
      raise_verdict "WARN" 1
      messages+=("discovery unavailable; override is in force")
    else
      raise_verdict "ERROR" 2
      exit_code=1
      messages+=("Access audience discovery failed; authenticate with cloudflared or set DOCS_CF_ACCESS_AUD")
    fi
  fi

  if [[ -n "${DOCS_CF_ACCESS_AUD:-}" && -n "$DISCOVERED_ACCESS_AUD" && "$DOCS_CF_ACCESS_AUD" != "$DISCOVERED_ACCESS_AUD" ]]; then
    raise_verdict "WARN" 1
    messages+=("override is in force and differs from the discovered JWT aud")
  fi

  if [[ -n "$DISCOVERED_ACCESS_AUD" && -n "$EFFECTIVE_ACCESS_AUD" && -z "${DOCS_CF_ACCESS_AUD:-}" && "$EFFECTIVE_ACCESS_AUD" != "$DISCOVERED_ACCESS_AUD" ]]; then
    raise_verdict "ERROR" 2
    exit_code=1
    messages+=("effective audience does not match the discovered JWT aud")
  fi

  if [[ "$repo_config_status" == "matched" && ${#repo_config_auds[@]} -eq 0 ]]; then
    raise_verdict "WARN" 1
    messages+=("repo-local generated config has no audTag for $DOMAIN")
  fi

  if [[ "$user_config_status" == "matched" && ${#user_config_auds[@]} -eq 0 ]]; then
    raise_verdict "WARN" 1
    messages+=("user-level Cloudflare config has no audTag for $DOMAIN")
  fi

  if [[ -n "$DISCOVERED_ACCESS_AUD" ]]; then
    for config_value in "${repo_config_auds[@]}"; do
      if [[ "$config_value" == "$DISCOVERED_ACCESS_AUD" ]]; then
        repo_matches_discovered=1
      fi
      if [[ -n "$DISCOVERED_ACCESS_POLICY_ID" && "$config_value" == "$DISCOVERED_ACCESS_POLICY_ID" ]]; then
        raise_verdict "WARN" 1
        messages+=("repo-local generated config audTag matches the token policy_id, not the JWT aud")
        break
      fi
    done

    for config_value in "${user_config_auds[@]}"; do
      if [[ "$config_value" == "$DISCOVERED_ACCESS_AUD" ]]; then
        user_matches_discovered=1
      fi
      if [[ -n "$DISCOVERED_ACCESS_POLICY_ID" && "$config_value" == "$DISCOVERED_ACCESS_POLICY_ID" ]]; then
        raise_verdict "WARN" 1
        messages+=("user-level Cloudflare config audTag matches the token policy_id, not the JWT aud")
        break
      fi
    done

    if [[ "$repo_config_status" == "matched" && ${#repo_config_auds[@]} -gt 0 && "$repo_matches_discovered" -eq 0 ]]; then
      raise_verdict "WARN" 1
      messages+=("repo-local generated config audTag does not match the discovered JWT aud")
    fi

    if [[ "$user_config_status" == "matched" && ${#user_config_auds[@]} -gt 0 && "$user_matches_discovered" -eq 0 ]]; then
      raise_verdict "WARN" 1
      messages+=("user-level Cloudflare config audTag does not match the discovered JWT aud")
    fi
  fi

  echo "Domain: $DOMAIN"
  if [[ -n "$EFFECTIVE_ACCESS_AUD" ]]; then
    echo "Effective audience: $EFFECTIVE_ACCESS_AUD"
    echo "Effective audience source: $EFFECTIVE_ACCESS_AUD_SOURCE"
  else
    echo "Effective audience: (unresolved)"
    echo "Effective audience source: (unresolved)"
  fi

  if [[ -n "$DISCOVERED_ACCESS_AUD" ]]; then
    echo "Discovered token aud: $DISCOVERED_ACCESS_AUD"
  else
    echo "Discovered token aud: (unavailable)"
  fi

  if [[ -n "$DISCOVERED_ACCESS_POLICY_ID" ]]; then
    echo "Discovered token policy_id: $DISCOVERED_ACCESS_POLICY_ID"
  else
    echo "Discovered token policy_id: (unavailable)"
  fi

  print_aud_list "Repo-local config audTag (${CONFIG_PATH})" "${repo_config_auds[@]}"
  print_aud_list "User-level config audTag (${USER_CONFIG_PATH})" "${user_config_auds[@]}"

  echo "Verdict: $verdict"
  if ((${#messages[@]} > 0)); then
    for message in "${messages[@]}"; do
      echo "- $message"
    done
  fi

  return "$exit_code"
}

serve_docs() {
  require_command bun
  assert_port_free

  cd "$REPO_ROOT"
  export DOCS_TUNNEL_HMR_CLIENT_PORT=${DOCS_TUNNEL_HMR_CLIENT_PORT:-443}
  bun run docs:api
  exec bunx vitepress dev docs --open --strictPort --port "$PORT" --host 127.0.0.1
}

run_tunnel() {
  if [[ "$DOMAIN" == "agents-js.bodal.dev" && "${DOCS_TUNNEL_ALLOW_PRODUCTION_TUNNEL:-}" != "1" ]]; then
    echo "Refusing to attach a local cloudflared connector to production hostname $DOMAIN by default." >&2
    echo "Production docs are expected to run through the Portainer cloudflared sidecar." >&2
    echo "Set DOCS_TUNNEL_ALLOW_PRODUCTION_TUNNEL=1 only for an intentional local override." >&2
    exit 1
  fi
  local config_path
  config_path=$(setup_config)
  echo "Running Cloudflare tunnel for $DOMAIN on local port $PORT..." >&2
  exec cloudflared tunnel --config "$config_path" run "$DOMAIN"
}

MODE=${1:-help}

case "$MODE" in
  serve)
    serve_docs
    ;;
  doctor)
    run_doctor
    ;;
  config)
    write_existing_config
    ;;
  setup)
    setup_config
    ;;
  tunnel)
    run_tunnel
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage >&2
    exit 1
    ;;
esac
