#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/zhdd/home/tjshen/260801_CatLaw2/analysis-runs/current-0.14.4}"
RUN_ID="${2:-baseline-current-hash}"
WORKERS="${3:-96}"
SEED_COUNT="${4:-1000}"
SHARD_SIZE="${5:-10}"
PROFILE="${6:-baseline-current-workspace}"
DIAGNOSTIC_INTERVENTION="${7:-none}"
STARTER_LAW_PROFILE="${8:-baseline}"
PARENT_ROOT="$(cd "$ROOT/../.." && pwd)"
TSX="$PARENT_ROOT/node_modules/.bin/tsx"
if [[ ! -x "$TSX" && -x "$ROOT/node_modules/.bin/tsx" ]]; then
  TSX="$ROOT/node_modules/.bin/tsx"
fi
SHARD_DIR="$ROOT/output/$RUN_ID/shards"
RESULT="$ROOT/output/$RUN_ID/aggregate.json"

if (( SEED_COUNT <= 0 || SHARD_SIZE <= 0 || SEED_COUNT % SHARD_SIZE != 0 )); then
  echo "SEED_COUNT must be positive and divisible by SHARD_SIZE" >&2
  exit 2
fi
if [[ ! -x "$TSX" ]]; then
  echo "tsx runtime not found at $TSX" >&2
  exit 2
fi

mkdir -p "$SHARD_DIR"
SHARDS=$((SEED_COUNT / SHARD_SIZE))
export ROOT TSX SHARD_DIR SHARD_SIZE PROFILE DIAGNOSTIC_INTERVENTION STARTER_LAW_PROFILE
seq 0 $((SHARDS - 1)) | xargs -P "$WORKERS" -I '{}' bash -c '
  index="$1"
  start=$((index * SHARD_SIZE + 1))
  output="$SHARD_DIR/shard-$(printf "%04d" "$index").json"
  "$TSX" "$ROOT/scripts/simulation-analysis-worker.mts" \
    "--seed-start=$start" "--seed-count=$SHARD_SIZE" "--output=$output" \
    "--profile=$PROFILE" "--diagnostic-intervention=$DIAGNOSTIC_INTERVENTION" \
    "--starter-law-profile=$STARTER_LAW_PROFILE"
' _ '{}'

"$TSX" "$ROOT/scripts/aggregate-simulation-analysis.mts" \
  "--input-dir=$SHARD_DIR" "--output=$RESULT" \
  "--seed-start=1" "--seed-count=$SEED_COUNT"
printf 'aggregate=%s\n' "$RESULT"
