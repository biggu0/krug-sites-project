#!/usr/bin/env bash
set -euo pipefail

archive="${1:-./dist/site-package.tar.gz}"
plugin_packager="${CODEX_SITES_PACKAGE_SCRIPT:-/Users/guoqing/.codex/plugins/cache/openai-bundled/sites/0.1.37/scripts/package-site.sh}"

if [ ! -x "$plugin_packager" ]; then
  echo "Sites packaging helper not found: $plugin_packager" >&2
  echo "Set CODEX_SITES_PACKAGE_SCRIPT to the package-site.sh helper path." >&2
  exit 1
fi

exec "$plugin_packager" . "$archive"
