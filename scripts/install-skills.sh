#!/usr/bin/env bash
# Installs the qa-* skills into ~/.claude/skills (symlinks by default, --copy to copy).
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../skills" && pwd)"
dest="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
mode="link"
[ "${1:-}" = "--copy" ] && mode="copy"

mkdir -p "$dest"
for dir in "$src"/*/; do
  name="$(basename "$dir")"
  target="$dest/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skip   $name (a real directory already exists at $target; remove it first to replace)"
    continue
  fi
  rm -f "$target"
  if [ "$mode" = "copy" ]; then
    cp -r "${dir%/}" "$target"
  else
    ln -s "${dir%/}" "$target"
  fi
  echo "$mode   $name -> $target"
done
echo "Done. Restart Claude Code to load the skills."
