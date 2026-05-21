#!/bin/bash

set -e

VAULT_PLUGINS_DIR="${VAULT_PLUGINS_DIR:-$HOME/Documents/Obsidian Vault/.obsidian/plugins}"
PLUGIN_NAME="fuchouzhe-ai-for-obsidian-showcase"
TARGET_DIR="$VAULT_PLUGINS_DIR/$PLUGIN_NAME"

if [ ! -d "$VAULT_PLUGINS_DIR" ]; then
	echo "Vault plugins directory not found: $VAULT_PLUGINS_DIR"
	echo "Set VAULT_PLUGINS_DIR before running this script."
	exit 1
fi

npm run build
mkdir -p "$TARGET_DIR"
cp -f main.js manifest.json styles.css "$TARGET_DIR/"

echo "Installed to $TARGET_DIR"
