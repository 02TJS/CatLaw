#!/usr/bin/env python3
"""Solve the Cat Workshop technical-value and spatial steady-state models.

The script intentionally keeps three quantities separate:
1. recipe work W_i (technology only),
2. minimum delivered action cost (technology + a particular cat graph), and
3. steady-state LP shadow values (technology + graph + an explicit demand vector).

No tax, credit, bounty, catalog markup, or hard-coded freight fee enters the LP.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import socket
import time
from collections import defaultdict, deque
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from statistics import fmean, median
from typing import Any, Iterable

import numpy as np
import scipy
from scipy.optimize import linprog
from scipy.sparse import coo_matrix


PAYLOAD: dict[str, Any] | None = None
WORK_BY_DIFFICULTY: dict[int, list[int]] = {}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="output/price-theory-input.json")
    parser.add_argument("--output", default="output/price-theory-results.json")
    parser.add_argument("--workers", type=int, default=max(1, min(32, os.cpu_count() or 1)))
    parser.add_argument("--stages", default="10,15")
    return parser.parse_args()


def input_list(recipe: dict[str, Any], difficulty: int) -> list[dict[str, Any]]:
    return recipe["difficulty5Inputs"] if difficulty == 5 else recipe["baseInputs"]


def calculate_work(payload: dict[str, Any], difficulty: int) -> list[int]:
    recipes = {recipe["output"]: recipe for recipe in payload["recipes"]}
    memo: dict[str, int] = {}
    visiting: set[str] = set()

    def visit(item_id: str) -> int:
        if item_id in memo:
            return memo[item_id]
        if item_id in visiting:
            raise ValueError(f"recipe cycle at {item_id}")
        visiting.add(item_id)
        recipe = recipes[item_id]
        inputs = input_list(recipe, difficulty)
        value = 1 + sum(int(entry["quantity"]) * visit(entry["itemId"]) for entry in inputs)
        visiting.remove(item_id)
        memo[item_id] = value
        return value

    return [visit(item["id"]) for item in payload["items"]]


def all_pairs_distances(seed: dict[str, Any]) -> list[list[int]]:
    count = len(seed["cats"])
    adjacency: list[list[int]] = [[] for _ in range(count)]
    for source, target in seed["directedEdges"]:
        adjacency[source].append(target)
    result: list[list[int]] = []
    for source in range(count):
        distances = [10**9] * count
        distances[source] = 0
        queue: deque[int] = deque([source])
        while queue:
            node = queue.popleft()
            for target in adjacency[node]:
                if distances[target] > distances[node] + 1:
                    distances[target] = distances[node] + 1
                    queue.append(target)
        result.append(distances)
    return result


def minimum_delivered_costs(payload: dict[str, Any], seed: dict[str, Any], difficulty: int, stage: int) -> list[list[float]]:
    """Exact uncongested action cost to deliver one item to every cat.

    Because the recipe graph is a DAG and all actions have unit cost, induction
    over recipe order plus shortest paths solves the corresponding min-cost
    hypergraph problem exactly.
    """
    count = len(seed["cats"])
    distances = all_pairs_distances(seed)
    delivered: list[list[float]] = []
    for recipe in payload["recipes"][:stage]:
        inputs = input_list(recipe, difficulty)
        if not inputs:
            sources = [cat["catIndex"] for cat in seed["cats"] if recipe["output"] in cat["resourceItemIds"]]
            delivered.append([
                min((1 + distances[source][target] for source in sources), default=math.inf)
                for target in range(count)
            ])
            continue
        craft_cost = [
            1 + sum(int(entry["quantity"]) * delivered[next(
                item["index"] for item in payload["items"] if item["id"] == entry["itemId"]
            )][node] for entry in inputs)
            for node in range(count)
        ]
        delivered.append([
            min(craft_cost[source] + distances[source][target] for source in range(count))
            for target in range(count)
        ])
    return delivered


def add_entry(rows: list[int], cols: list[int], data: list[float], row: int, col: int, value: float) -> None:
    rows.append(row)
    cols.append(col)
    data.append(float(value))


def solve_throughput(payload: dict[str, Any], seed: dict[str, Any], stage: int, mode: str) -> dict[str, Any]:
    difficulty = 5
    cats = seed["cats"]
    cat_count = len(cats)
    recipes = payload["recipes"][:stage]
    items = payload["items"][:stage]
    item_index = {item["id"]: index for index, item in enumerate(items)}
    work = WORK_BY_DIFFICULTY[difficulty][:stage]
    demand = np.array([1.0 if mode == "equal-pieces" else 1.0 / value for value in work], dtype=float)

    craft_variables: list[tuple[int, int]] = []
    for cat_index, cat in enumerate(cats):
        for recipe_index, recipe in enumerate(recipes):
            if input_list(recipe, difficulty) or recipe["output"] in cat["resourceItemIds"]:
                craft_variables.append((cat_index, recipe_index))
    transport_variables = [
        (source, target, item_i)
        for source, target in seed["directedEdges"]
        for item_i in range(stage)
    ]
    absorption_variables = [(cat_index, item_i) for cat_index in range(cat_count) for item_i in range(stage)]

    craft_offset = 0
    transport_offset = len(craft_variables)
    absorption_offset = transport_offset + len(transport_variables)
    lambda_index = absorption_offset + len(absorption_variables)
    variable_count = lambda_index + 1

    capacity_rows = cat_count
    balance_offset = 0
    demand_offset = cat_count * stage
    equality_rows = demand_offset + stage
    ub_r: list[int] = []
    ub_c: list[int] = []
    ub_d: list[float] = []
    eq_r: list[int] = []
    eq_c: list[int] = []
    eq_d: list[float] = []

    for local_index, (cat_index, recipe_index) in enumerate(craft_variables):
        variable = craft_offset + local_index
        recipe = recipes[recipe_index]
        add_entry(ub_r, ub_c, ub_d, cat_index, variable, 1)
        add_entry(eq_r, eq_c, eq_d, balance_offset + cat_index * stage + recipe_index, variable, 1)
        for ingredient in input_list(recipe, difficulty):
            add_entry(
                eq_r, eq_c, eq_d,
                balance_offset + cat_index * stage + item_index[ingredient["itemId"]],
                variable, -int(ingredient["quantity"]),
            )

    for local_index, (source, target, item_i) in enumerate(transport_variables):
        variable = transport_offset + local_index
        add_entry(ub_r, ub_c, ub_d, source, variable, 1)
        add_entry(eq_r, eq_c, eq_d, balance_offset + source * stage + item_i, variable, -1)
        add_entry(eq_r, eq_c, eq_d, balance_offset + target * stage + item_i, variable, 1)

    for local_index, (cat_index, item_i) in enumerate(absorption_variables):
        variable = absorption_offset + local_index
        add_entry(eq_r, eq_c, eq_d, balance_offset + cat_index * stage + item_i, variable, -1)
        add_entry(eq_r, eq_c, eq_d, demand_offset + item_i, variable, 1)

    for item_i, weight in enumerate(demand):
        add_entry(eq_r, eq_c, eq_d, demand_offset + item_i, lambda_index, -weight)

    a_ub = coo_matrix((ub_d, (ub_r, ub_c)), shape=(capacity_rows, variable_count)).tocsr()
    a_eq = coo_matrix((eq_d, (eq_r, eq_c)), shape=(equality_rows, variable_count)).tocsr()
    b_ub = np.ones(capacity_rows)
    b_eq = np.zeros(equality_rows)
    objective = np.zeros(variable_count)
    objective[lambda_index] = -1
    result = linprog(objective, A_ub=a_ub, b_ub=b_ub, A_eq=a_eq, b_eq=b_eq, bounds=(0, None), method="highs")
    if not result.success:
        return {"seed": seed["seed"], "stage": stage, "mode": mode, "success": False, "message": result.message}

    capacity_marginals = np.asarray(result.ineqlin.marginals)
    equality_marginals = np.asarray(result.eqlin.marginals)
    lower_marginals = np.asarray(result.lower.marginals)
    capacity_slack = np.asarray(result.ineqlin.residual)
    equality_residual = np.asarray(result.eqlin.residual)
    stationarity = objective - a_ub.T @ capacity_marginals - a_eq.T @ equality_marginals
    demand_marginals = equality_marginals[demand_offset:demand_offset + stage]
    normalization = float(np.dot(demand, demand_marginals))
    dual_objective = float(np.dot(b_ub, capacity_marginals) + np.dot(b_eq, equality_marginals))
    x = np.asarray(result.x)
    rents = -capacity_marginals
    target_shares = demand * demand_marginals
    top_targets = sorted(
        ({"itemId": items[index]["id"], "share": float(target_shares[index]), "demandMarginal": float(demand_marginals[index])} for index in range(stage)),
        key=lambda entry: (-entry["share"], entry["itemId"]),
    )[:5]
    top_cats = sorted(
        ({"catIndex": index, "rent": float(rents[index]), "slack": float(capacity_slack[index])} for index in range(cat_count)),
        key=lambda entry: (-entry["rent"], entry["catIndex"]),
    )[:5]
    return {
        "seed": seed["seed"],
        "stage": stage,
        "mode": mode,
        "success": True,
        "lambdaPerActionCycle": float(x[lambda_index]),
        "lambdaPerMinute": float(x[lambda_index] * 12),
        "primalMinObjective": float(result.fun),
        "dualMinObjective": dual_objective,
        "dualityGap": abs(float(result.fun) - dual_objective),
        "maxEqualityResidual": float(np.max(np.abs(equality_residual))),
        "maxCapacityViolation": float(np.max(np.maximum(-capacity_slack, 0))),
        "maxStationarityResidual": float(np.max(np.abs(stationarity - lower_marginals))),
        "maxComplementarityResidual": float(max(
            np.max(np.abs(x * lower_marginals)),
            np.max(np.abs(capacity_slack * capacity_marginals)),
        )),
        "demandDualNormalization": normalization,
        "capacityRentSum": float(np.sum(rents)),
        "bindingCatCount": int(np.sum(capacity_slack <= 1e-8)),
        "topTargetShadowShares": top_targets,
        "topCatCapacityRents": top_cats,
    }


def init_worker(payload: dict[str, Any], work: dict[int, list[int]]) -> None:
    global PAYLOAD, WORK_BY_DIFFICULTY
    PAYLOAD = payload
    WORK_BY_DIFFICULTY = work


def solve_job(job: tuple[int, int, str]) -> dict[str, Any]:
    seed_index, stage, mode = job
    assert PAYLOAD is not None
    return solve_throughput(PAYLOAD, PAYLOAD["seeds"][seed_index], stage, mode)


def quantiles(values: Iterable[float]) -> dict[str, float]:
    array = np.asarray(list(values), dtype=float)
    return {
        "min": float(np.min(array)),
        "p05": float(np.quantile(array, 0.05)),
        "median": float(np.median(array)),
        "mean": float(np.mean(array)),
        "p95": float(np.quantile(array, 0.95)),
        "max": float(np.max(array)),
    }


def main() -> None:
    started = time.perf_counter()
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    stages = [int(value) for value in args.stages.split(",") if value.strip()]
    work = {difficulty: calculate_work(payload, difficulty) for difficulty in range(1, 6)}

    # Uncongested spatial delivery costs are deterministic and cheap enough to
    # compute before the LP pool. We retain per-item distributions, not every
    # node-level matrix.
    delivery_samples: dict[tuple[int, int], list[float]] = defaultdict(list)
    for seed in payload["seeds"]:
        delivered = minimum_delivered_costs(payload, seed, 5, max(stages))
        for item_i, costs in enumerate(delivered):
            delivery_samples[(max(stages), item_i)].append(min(costs))

    jobs = [
        (seed_index, stage, mode)
        for seed_index in range(len(payload["seeds"]))
        for stage in stages
        for mode in ("equal-pieces", "equal-work")
    ]
    with ProcessPoolExecutor(max_workers=args.workers, initializer=init_worker, initargs=(payload, work)) as pool:
        lp_results = list(pool.map(solve_job, jobs, chunksize=4))

    failures = [entry for entry in lp_results if not entry["success"]]
    successful = [entry for entry in lp_results if entry["success"]]
    aggregates: list[dict[str, Any]] = []
    for stage in stages:
        for mode in ("equal-pieces", "equal-work"):
            group = [entry for entry in successful if entry["stage"] == stage and entry["mode"] == mode]
            aggregates.append({
                "stage": stage,
                "mode": mode,
                "count": len(group),
                "lambdaPerMinute": quantiles(entry["lambdaPerMinute"] for entry in group),
                "bindingCatCount": quantiles(entry["bindingCatCount"] for entry in group),
                "capacityRentSum": quantiles(entry["capacityRentSum"] for entry in group),
                "maxDualityGap": max(entry["dualityGap"] for entry in group),
                "maxPrimalResidual": max(max(entry["maxEqualityResidual"], entry["maxCapacityViolation"]) for entry in group),
                "maxKktResidual": max(max(entry["maxStationarityResidual"], entry["maxComplementarityResidual"]) for entry in group),
                "maxDemandNormalizationError": max(abs(entry["demandDualNormalization"] - 1) for entry in group),
            })

    item_rows = []
    for index, item in enumerate(payload["items"]):
        row = {
            **item,
            "workDifficulty1to4": work[1][index],
            "workDifficulty5": work[5][index],
            "theoryPriceIfOneCoinPerActionDifficulty1to4": work[1][index],
            "theoryPriceIfOneCoinPerActionDifficulty5": work[5][index],
            "currentToTheoryRatioDifficulty5": item["currentCatalogPriceCoins"] / work[5][index],
        }
        if index < max(stages):
            row["minimumDeliveredActionsDifficulty5InitialWorlds"] = quantiles(delivery_samples[(max(stages), index)])
        item_rows.append(row)

    output = {
        "schema": 1,
        "source": str(input_path),
        "seedCount": len(payload["seeds"]),
        "workers": args.workers,
        "computeEnvironment": {
            "hostname": socket.gethostname(),
            "platform": platform.platform(),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "logicalCpuCount": os.cpu_count(),
            "elapsedSeconds": time.perf_counter() - started,
        },
        "actionDurationMs": payload["actionDurationMs"],
        "normalization": {
            "relativeTheory": "v_i = c W_i",
            "reportedCoinExample": "c = 1 coin per action is an external numeraire, not a theorem",
            "taxCreditBountyMarkupIncluded": False,
        },
        "items": item_rows,
        "lpAggregates": aggregates,
        "lpFailures": failures,
        "lpCertificates": successful,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "seeds": len(payload["seeds"]),
        "jobs": len(jobs),
        "failures": len(failures),
        "workers": args.workers,
        "maxDualityGap": max((entry["dualityGap"] for entry in successful), default=None),
        "maxKktResidual": max((max(entry["maxStationarityResidual"], entry["maxComplementarityResidual"]) for entry in successful), default=None),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
