#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <candidate-name> <floor-lines> [explicit]" >&2
  exit 2
fi

root="/zhdd/home/tjshen"
base="$root/260801_CatLaw2-price-search"
candidate="$root/260801_CatLaw2-price-$1"
floor_lines="$2"
mode="${3:-floors}"
if [[ "$floor_lines" == "-" ]]; then
  floor_lines=""
fi

if [[ -e "$candidate" ]]; then
  echo "candidate already exists: $candidate" >&2
  exit 3
fi

mkdir -p "$candidate"
cp -a "$base"/. "$candidate"/

catalog="$candidate/src/game/catalog.ts"
temporary="$candidate/src/game/catalog.ts.price-candidate"
awk -v floor_lines="$floor_lines" -v mode="$mode" '
  mode == "explicit" && /^export const BASE_PRICE_TIER_PREMIUMS =/ {
    print "export const BASE_PRICE_TIER_PREMIUMS = [0, 0, 0, 0, 0, 0, 0, 0, 0] as const;"
    next
  }
  /^export const BASE_PRICE_FLOORS:/ {
    print "export const BASE_PRICE_FLOORS: Readonly<Record<string, number>> = Object.freeze({"
    if (length(floor_lines) > 0) print floor_lines
    print "});"
    replacing = 1
    next
  }
  replacing && /^\}\);/ {
    replacing = 0
    next
  }
  mode == "explicit" && /^const MINIMUM_RECIPE_MARKUP =/ {
    print "const MINIMUM_RECIPE_MARKUP = 0;"
    next
  }
  !replacing { print }
' "$catalog" > "$temporary"
mv "$temporary" "$catalog"

echo "$candidate"
sed -n '10,32p' "$catalog"
