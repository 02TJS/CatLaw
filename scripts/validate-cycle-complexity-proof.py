#!/usr/bin/env python3
"""Fail closed when a cycle-complexity proof artifact is inconsistent."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proof", default="output/cycle-complexity-proof.json")
    parser.add_argument("--input", default="output/price-theory-input.json")
    return parser.parse_args()


args = parse_args()
proof_path = Path(args.proof)
input_path = Path(args.input)
proof = json.loads(proof_path.read_text(encoding="utf-8"))
payload = json.loads(input_path.read_text(encoding="utf-8"))

assert proof["schema"] == "cat-workshop-cycle-complexity-proof-v1"
assert proof["source"]["inputSha256"] == hashlib.sha256(input_path.read_bytes()).hexdigest()
assert proof["source"]["worldCount"] == 1000
assert proof["source"]["actionDurationMs"] == 5000
assert proof["periodicFamily"]["definition"]["prefixItemCount"] == 65
assert proof["periodicFamily"]["definition"]["periodLength"] == 59
assert proof["periodicFamily"]["periodicGrowthCertificate"]["provesExponentialInItemIndex"] is True
assert proof["periodicFamily"]["periodicGrowthCertificate"]["lowerPerPeriod"] > 1

prefix = {entry["stage"]: entry for entry in proof["realCatalog"]["prefixCertificates"]}
integer = proof["integerRegenerativePeriodMilp"]
fluid = proof["spatialCycleLp"]
assert integer["failures"] == []
assert fluid["failures"] == []
assert set(integer["stages"]) == {10, 15, 19, 20, 22}
assert set(fluid["stages"]) == {10, 15, 19, 20, 22}
assert len(integer["certificates"]) == 5000
assert len(fluid["certificates"]) == 5000

fluid_by_key = {(entry["seed"], entry["stage"]): entry for entry in fluid["certificates"]}
coverage: Counter[int] = Counter()
for entry in integer["certificates"]:
    seed, stage = entry["seed"], entry["stage"]
    coverage[stage] += 1
    assert 1 <= seed <= 1000
    assert entry["mipGap"] == 0
    assert entry["integerFeasibilityResidual"] == 0
    assert entry["exactDiscretePeriodMs"] == entry["periodSlots"] * 5000
    assert entry["totalCraftActionsPerBasket"] == int(prefix[stage]["oneBasketTechnicalActions"])
    assert sum(entry["catLoads"]) == entry["totalPhysicalActionsPerBasket"]
    assert max(entry["catLoads"]) == entry["periodSlots"]
    relaxed = fluid_by_key[(seed, stage)]["maxCatActionsPerBasket"]
    assert entry["periodSlots"] == math.ceil(relaxed - 1e-9)
assert coverage == Counter({10: 1000, 15: 1000, 19: 1000, 20: 1000, 22: 1000})

# Recompute the real-prefix reverse-topological basket counts independently.
for stage, expected in prefix.items():
    counts = [1] * stage
    index = {item["id"]: i for i, item in enumerate(payload["items"][:stage])}
    for recipe_i in range(stage - 1, -1, -1):
        for ingredient in payload["recipes"][recipe_i]["difficulty5Inputs"]:
            counts[index[ingredient["itemId"]]] += counts[recipe_i] * int(ingredient["quantity"])
    assert sum(counts) == int(expected["oneBasketTechnicalActions"])
    assert {payload["items"][i]["id"]: str(value) for i, value in enumerate(counts)} == expected["oneBasketCraftCounts"]

print(json.dumps({
    "proof": str(proof_path),
    "sha256": hashlib.sha256(proof_path.read_bytes()).hexdigest(),
    "computeHostname": proof["compute"]["hostname"],
    "integerCertificates": len(integer["certificates"]),
    "fluidCertificates": len(fluid["certificates"]),
    "coverage": dict(sorted(coverage.items())),
    "status": "valid",
}, ensure_ascii=False))
