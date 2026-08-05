#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <candidate-name>..." >&2
  exit 2
fi

host_root="/zhdd/home/tjshen"
runner="$host_root/260801_CatLaw2-price-minimal2/scripts/run-simulation-analysis-remote.sh"
workers=$((96 / $#))
if (( workers < 1 )); then workers=1; fi

pids=()
names=()
for name in "$@"; do
  root="$host_root/260801_CatLaw2-price-$name"
  log="$root/output/screen-200.log"
  mkdir -p "$root/output"
  bash "$runner" "$root" screen-200 "$workers" 200 5 "price-$name" none > "$log" 2>&1 &
  pids+=("$!")
  names+=("$name")
done

failed=0
for index in "${!pids[@]}"; do
  if ! wait "${pids[$index]}"; then
    echo "candidate failed: ${names[$index]}" >&2
    failed=1
  fi
done

for name in "${names[@]}"; do
  result="$host_root/260801_CatLaw2-price-$name/output/screen-200/aggregate.json"
  node -e '
    const fs = require("fs");
    const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(JSON.stringify({
      candidate: process.argv[2],
      stage10Stable: result.summary.stage10Stable,
      stage15Reached: result.summary.stage15Reached,
      stage15Stable: result.summary.stage15Stable,
      failureKinds: result.summary.stage15FailureKinds,
      materialFailures: result.summary.stage15MaterialFailures,
      stalledContracts: result.summary.stage15StalledContractItems,
    }) + "\n");
  ' "$result" "$name"
done

exit "$failed"
