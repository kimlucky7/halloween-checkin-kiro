#!/usr/bin/env bash
# Builds two upload files from chatgpt-skill/ and chatgpt-plugin/:
#   chatgpt-skill/dist/halloween-checkin-skill.zip   – the skill alone (Skills → Upload)
#   chatgpt-skill/dist/halloween-checkin-plugin.zip  – plugin.json + mcp.json + skills/ (Plugins → Upload)
# Set HC_MCP_URL to package the plugin for your own deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=chatgpt-skill/dist
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"
rm -f "$OUT/halloween-checkin-skill.zip" "$OUT/halloween-checkin-plugin.zip"
(cd chatgpt-skill && zip -qr "../$OUT/halloween-checkin-skill.zip" halloween-checkin -x '*/__pycache__/*' '*.DS_Store')
P="$STAGE/halloween-checkin"
mkdir -p "$P/skills"
DEFAULT_SITE=https://halloween-checkin.a512884335.workers.dev
if [ -n "${HC_MCP_URL:-}" ]; then
  case "$HC_MCP_URL" in
    https://*/mcp) ;;
    *) echo "HC_MCP_URL must look like https://<your-site>/mcp" >&2; exit 1 ;;
  esac
  SITE=${HC_MCP_URL%/mcp}
  # MCP endpoint and the plugin's homepage/website both point at your deployment.
  sed "s#${DEFAULT_SITE}/mcp#${HC_MCP_URL}#" chatgpt-plugin/mcp.json > "$P/mcp.json"
  sed "s#${DEFAULT_SITE}#${SITE}#g" chatgpt-plugin/plugin.json > "$P/plugin.json"
else
  cp chatgpt-plugin/mcp.json chatgpt-plugin/plugin.json "$P/"
fi
cp -R chatgpt-skill/halloween-checkin "$P/skills/"
find "$P" -name '__pycache__' -prune -exec rm -rf {} + -o -name '.DS_Store' -delete
(cd "$P" && zip -qr "$OLDPWD/$OUT/halloween-checkin-plugin.zip" .)
echo "$OUT/halloween-checkin-skill.zip"
echo "$OUT/halloween-checkin-plugin.zip"
