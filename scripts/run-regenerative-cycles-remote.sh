#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/zhdd/home/tjshen/260801_CatLaw2-price-theorem1}"
SEED_COUNT="${2:-200}"
SHARD_SIZE="${3:-10}"
WORKERS="${4:-20}"
MAX_WINDOW_MS="${5:-600000}"
OUTPUT_DIR="$ROOT/output/regenerative-cycles-${SEED_COUNT}"

if (( SEED_COUNT <= 0 || SHARD_SIZE <= 0 || SEED_COUNT % SHARD_SIZE != 0 )); then
  echo "SEED_COUNT must be positive and divisible by SHARD_SIZE" >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR"
export ROOT SHARD_SIZE MAX_WINDOW_MS OUTPUT_DIR
SHARDS=$((SEED_COUNT / SHARD_SIZE))
seq 0 $((SHARDS - 1)) | xargs -P "$WORKERS" -I '{}' bash -c '
  shard="$1"
  start=$((shard * SHARD_SIZE + 1))
  output="$OUTPUT_DIR/shard-$(printf "%04d" "$shard").json"
  cd "$ROOT"
  node --import tsx scripts/measure-regenerative-cycles.mts \
    "--seed-start=$start" "--seed-count=$SHARD_SIZE" \
    "--max-window-ms=$MAX_WINDOW_MS" "--output=$output"
' _ '{}'

echo "output_dir=$OUTPUT_DIR"
