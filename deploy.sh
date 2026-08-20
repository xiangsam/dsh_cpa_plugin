#!/bin/sh
# Deploys this plugin as a real (non-symlinked) copy into a dsh profile's
# node_modules. See README.md "Install" for why this can't just be
# `dsh plugin add` / pnpm's file: symlink.
set -e

PROFILE="${1:-web}"
DEST="$HOME/.dsh/profiles/$PROFILE/node_modules/dsh-cpa-plugin"
SRC="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST/lib"
cp "$SRC/package.json" "$DEST/package.json"
cp "$SRC/lib/index.js" "$DEST/lib/index.js"
cp "$SRC/lib/client.js" "$DEST/lib/client.js"

echo "deployed dsh-cpa-plugin -> $DEST"
echo "restart 'dsh $PROFILE' (or dsh --profile $PROFILE ...) for changes to take effect — hmr is off by default for this profile."
