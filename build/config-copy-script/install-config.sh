#!/bin/bash
set -e

USER_HOME="/home/pd0rk1n"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_SOURCE_DIR="$SCRIPT_DIR/.config"

if [ ! -d "$CONFIG_SOURCE_DIR" ]; then
  echo "Error: .config folder not found in script directory."
  exit 1
fi

echo "Copying .config to $USER_HOME/.config..."
rm -rf "$USER_HOME/.config"
cp -r "$CONFIG_SOURCE_DIR" "$USER_HOME/.config"
chown -R pd0rk1n:users "$USER_HOME/.config"

echo "Done!"
