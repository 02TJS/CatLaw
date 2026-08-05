#!/usr/bin/env python3
"""Certified cycle-complexity analysis for Cat Workshop.

This program does not mutate the game.  It separates three objects:

1. intrinsic technical work for a regenerative basket,
2. an omniscient steady-state spatial cycle optimum, and
3. the asymptotic growth of a documented infinite recipe family.

The infinite family has the real 65-item catalog as an exact prefix.  Starting
at item 66, it periodically replays the 59 non-resource recipe templates.  A
template preserves every input multiplicity and every topological index lag:
an original input at index j of recipe i becomes input n-(i-j) when the
template is replayed at new index n.  This introduces no new action or recipe
mechanism and makes the extension rule independent of computed outcomes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import socket
import time
from concurrent.futures import ProcessPoolExecutor
from fractions import Fraction
from pathlib import Path
from statistics import median
from typing import Any, Iterable

import numpy as np
import scipy
from scipy.optimize import Bounds, LinearConstraint, linprog, milp
from scipy.sparse import coo_matrix


PAYLOAD: dict[str, Any] | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="output/price-theory-input.json")
    parser.add_argument("--output", default="output/cycle-complexity-proof.json")
    parser.add_argument("--stages", default="10,15,19,22")
    parser.add_argument("--seed-limit", type=int, default=1000)
    parser.add_argument("--integer-stages", default="10,15,19,22")
    parser.add_argument("--integer-seed-limit", type=int, default=200)
    parser.add_argument("--mip-time-limit-seconds", type=float, default=120.0)
    parser.add_argument("--extension-items", type=int, default=2425)
    parser.add_argument("--power-iterations", type=int, default=32)
    parser.add_argument("--workers", type=int, default=max(1, min(32, os.cpu_count() or 1)))
    return parser.parse_args()


def sha256_json(value: Any) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


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


def recipe_inputs(recipe: dict[str, Any]) -> list[dict[str, Any]]:
    return recipe["difficulty5Inputs"]


def calculate_prefix_metrics(payload: dict[str, Any]) -> tuple[list[int], list[int]]:
    item_index = {item["id"]: index for index, item in enumerate(payload["items"])}
    depths: list[int] = []
    single_work: list[int] = []
    for index, recipe in enumerate(payload["recipes"]):
        inputs = recipe_inputs(recipe)
        if not inputs:
            depths.append(0)
            single_work.append(1)
            continue
        input_indices = [item_index[entry["itemId"]] for entry in inputs]
        if any(input_index >= index for input_index in input_indices):
            raise ValueError(f"catalog is not topological at {recipe['output']}")
        depths.append(1 + max(depths[input_index] for input_index in input_indices))
        single_work.append(1 + sum(
            int(entry["quantity"]) * single_work[item_index[entry["itemId"]]]
            for entry in inputs
        ))
    return depths, single_work


def regenerative_basket_counts(payload: dict[str, Any], through: int, units_per_item: int = 1) -> list[int]:
    """Exact minimum craft counts with nonnegative final inventory.

    Every target item must appear ``units_per_item`` times as gross output.  A
    reverse topological substitution then adds every input consumed by those
    gross crafts.  Because all coefficients and objective weights are positive,
    the resulting vector is the unique componentwise-minimal integer solution.
    """
    item_index = {item["id"]: index for index, item in enumerate(payload["items"][:through])}
    counts = [units_per_item] * through
    for recipe_index in range(through - 1, -1, -1):
        recipe = payload["recipes"][recipe_index]
        for entry in recipe_inputs(recipe):
            input_index = item_index[entry["itemId"]]
            counts[input_index] += counts[recipe_index] * int(entry["quantity"])
    return counts


def build_periodic_family(payload: dict[str, Any], total_items: int, power_iterations: int) -> dict[str, Any]:
    recipes = payload["recipes"]
    items = payload["items"]
    if len(items) != 65 or len(recipes) != 65:
        raise ValueError("the periodic proof family is anchored to the verified 65-item catalog")
    index_by_id = {item["id"]: index for index, item in enumerate(items)}
    template_indices = list(range(6, 65))
    templates: list[dict[str, Any]] = []
    maximum_lag = 0
    maximum_input_units = 0
    for template_index in template_indices:
        recipe = recipes[template_index]
        terms = []
        for entry in recipe_inputs(recipe):
            input_index = index_by_id[entry["itemId"]]
            lag = template_index - input_index
            if lag <= 0:
                raise ValueError("extension template has a non-positive dependency lag")
            quantity = int(entry["quantity"])
            maximum_lag = max(maximum_lag, lag)
            terms.append({"lag": lag, "quantity": quantity, "sourceItemId": entry["itemId"]})
        maximum_input_units = max(maximum_input_units, sum(term["quantity"] for term in terms))
        templates.append({
            "sourceIndex": template_index + 1,
            "sourceItemId": recipe["output"],
            "terms": terms,
            "siteRequirements": recipe["siteRequirements"],
        })

    prefix_depths, prefix_work = calculate_prefix_metrics(payload)
    depths = list(prefix_depths)
    work = list(prefix_work)
    family_terms: list[list[tuple[int, int]]] = [
        [
            (index_by_id[entry["itemId"]], int(entry["quantity"]))
            for entry in recipe_inputs(recipe)
        ]
        for recipe in recipes
    ]
    for new_index in range(65, total_items):
        template = templates[(new_index - 65) % len(templates)]
        terms = [(new_index - term["lag"], term["quantity"]) for term in template["terms"]]
        if any(input_index < 0 or input_index >= new_index for input_index, _ in terms):
            raise ValueError(f"invalid periodic dependency at extension index {new_index + 1}")
        family_terms.append(terms)
        depths.append(1 + max(depths[input_index] for input_index, _ in terms))
        work.append(1 + sum(quantity * work[input_index] for input_index, quantity in terms))

    def transition(vector: list[int], template: dict[str, Any]) -> list[int]:
        head = sum(term["quantity"] * vector[term["lag"] - 1] for term in template["terms"])
        return [head, *vector[:-1]]

    def apply_period(vector: list[int]) -> list[int]:
        current = vector
        for template in templates:
            current = transition(current, template)
        return current

    positive_vector = [1] * maximum_lag
    for _ in range(power_iterations):
        positive_vector = apply_period(positive_vector)
    next_vector = apply_period(positive_vector)
    ratios = [Fraction(after, before) for after, before in zip(next_vector, positive_vector, strict=True)]
    lower = min(ratios)
    upper = max(ratios)
    vector_digest = hashlib.sha256(
        ",".join(str(value) for value in positive_vector).encode("ascii")
    ).hexdigest()

    checkpoints = sorted(set(
        [65, 66, 124, 183, 242, total_items]
        + [min(total_items, 65 + 59 * periods) for periods in (1, 2, 4, 8, 16, 24, 32, 40)]
    ))
    cumulative_basket_work: list[int] = []
    running_basket_work = 0
    for value in work:
        running_basket_work += value
        cumulative_basket_work.append(running_basket_work)
    sample_rows = [{
        "itemCount": checkpoint,
        "depth": depths[checkpoint - 1],
        "singleItemWork": str(work[checkpoint - 1]),
        "singleItemWorkDigits": len(str(work[checkpoint - 1])),
        "prefixRegenerativeBasketWork": str(cumulative_basket_work[checkpoint - 1]),
        "prefixRegenerativeBasketWorkDigits": len(str(cumulative_basket_work[checkpoint - 1])),
        "logWork": math.log(work[checkpoint - 1]),
    } for checkpoint in checkpoints if 0 < checkpoint <= total_items]

    depth_increments = []
    for endpoint in range(65 + len(templates), total_items + 1, len(templates)):
        depth_increments.append(depths[endpoint - 1] - depths[endpoint - len(templates) - 1])

    return {
        "definition": {
            "prefixItemCount": 65,
            "periodLength": len(templates),
            "firstExtendedItemIndex": 66,
            "mapping": "At extension index n, replay template r=7+((n-66) mod 59); original dependency lag delta is preserved as input n-delta with unchanged quantity.",
            "baseResourcesRemainFixed": True,
            "newActionKinds": 0,
            "templatesSha256": sha256_json(templates),
        },
        "templates": templates,
        "bounds": {
            "maximumDependencyLag": maximum_lag,
            "maximumInputUnitsPerRecipe": maximum_input_units,
            "depthLowerBound": f"d_n >= floor((n-65)/{maximum_lag}) + minPrefixDepth",
            "depthUpperBound": "d_n <= n-1",
            "workUpperRecurrence": f"w_n <= 1 + {maximum_input_units} * max_previous_work",
        },
        "periodicGrowthCertificate": {
            "method": "Collatz-Wielandt bounds for the nonnegative one-period monodromy operator",
            "powerVectorIterations": power_iterations,
            "positiveVectorSha256": vector_digest,
            "lowerPerPeriodExact": f"{lower.numerator}/{lower.denominator}",
            "upperPerPeriodExact": f"{upper.numerator}/{upper.denominator}",
            "lowerPerPeriod": float(lower),
            "upperPerPeriod": float(upper),
            "lowerPerTemplate": float(lower) ** (1 / len(templates)),
            "upperPerTemplate": float(upper) ** (1 / len(templates)),
            "provesExponentialInItemIndex": lower > 1,
            "provesExpThetaInDependencyDepth": lower > 1 and maximum_lag > 0,
        },
        "depthPeriodIncrements": {
            "count": len(depth_increments),
            "tail": depth_increments[-20:],
            "min": min(depth_increments) if depth_increments else None,
            "max": max(depth_increments) if depth_increments else None,
        },
        "sampleRows": sample_rows,
        "lastItem": {
            "itemCount": total_items,
            "depth": depths[-1],
            "singleItemWork": str(work[-1]),
            "singleItemWorkDigits": len(str(work[-1])),
            "prefixRegenerativeBasketWork": str(cumulative_basket_work[-1]),
            "prefixRegenerativeBasketWorkDigits": len(str(cumulative_basket_work[-1])),
        },
    }


def add_entry(rows: list[int], cols: list[int], data: list[float], row: int, col: int, value: float) -> None:
    rows.append(row)
    cols.append(col)
    data.append(float(value))


def solve_spatial_cycle(payload: dict[str, Any], seed: dict[str, Any], stage: int) -> dict[str, Any]:
    """Solve the exact fractional steady-state basket LP for one world.

    One basket is one autonomous gross completion of every target item.  The LP
    includes the extra upstream crafts needed to replace all consumed inputs,
    every one-edge transfer, and one-action-per-cat capacity.  It deliberately
    omits price, credit and behavioral choice, so its optimum is a certified
    physical lower bound for every legal market implementation.
    """
    recipes = payload["recipes"][:stage]
    items = payload["items"][:stage]
    cats = seed["cats"]
    cat_count = len(cats)
    item_index = {item["id"]: index for index, item in enumerate(items)}

    if any(recipe["activeSiteRequirementsByDifficulty"]["5"] for recipe in recipes):
        return {
            "seed": seed["seed"], "stage": stage, "success": False,
            "reason": "site-requirements-need-an-explicit-building-configuration",
        }

    craft_variables: list[tuple[int, int]] = []
    for cat_index, cat in enumerate(cats):
        for recipe_index, recipe in enumerate(recipes):
            if recipe_inputs(recipe) or recipe["output"] in cat["resourceItemIds"]:
                craft_variables.append((cat_index, recipe_index))
    transport_variables = [
        (source, target, item_i)
        for source, target in seed["directedEdges"]
        for item_i in range(stage)
    ]
    absorption_variables = [(cat_index, item_i) for cat_index in range(cat_count) for item_i in range(stage)]
    transport_offset = len(craft_variables)
    absorption_offset = transport_offset + len(transport_variables)
    max_load_index = absorption_offset + len(absorption_variables)
    variable_count = max_load_index + 1

    ub_r: list[int] = []
    ub_c: list[int] = []
    ub_d: list[float] = []
    eq_r: list[int] = []
    eq_c: list[int] = []
    eq_d: list[float] = []
    balance_rows = cat_count * stage
    demand_offset = balance_rows
    equality_rows = balance_rows + stage

    for local_index, (cat_index, recipe_index) in enumerate(craft_variables):
        variable = local_index
        recipe = recipes[recipe_index]
        add_entry(ub_r, ub_c, ub_d, cat_index, variable, 1)
        add_entry(eq_r, eq_c, eq_d, cat_index * stage + recipe_index, variable, 1)
        for ingredient in recipe_inputs(recipe):
            add_entry(
                eq_r, eq_c, eq_d,
                cat_index * stage + item_index[ingredient["itemId"]],
                variable, -int(ingredient["quantity"]),
            )

    for local_index, (source, target, item_i) in enumerate(transport_variables):
        variable = transport_offset + local_index
        add_entry(ub_r, ub_c, ub_d, source, variable, 1)
        add_entry(eq_r, eq_c, eq_d, source * stage + item_i, variable, -1)
        add_entry(eq_r, eq_c, eq_d, target * stage + item_i, variable, 1)

    for local_index, (cat_index, item_i) in enumerate(absorption_variables):
        variable = absorption_offset + local_index
        add_entry(eq_r, eq_c, eq_d, cat_index * stage + item_i, variable, -1)
        add_entry(eq_r, eq_c, eq_d, demand_offset + item_i, variable, 1)

    for cat_index in range(cat_count):
        add_entry(ub_r, ub_c, ub_d, cat_index, max_load_index, -1)

    a_ub = coo_matrix((ub_d, (ub_r, ub_c)), shape=(cat_count, variable_count)).tocsr()
    a_eq = coo_matrix((eq_d, (eq_r, eq_c)), shape=(equality_rows, variable_count)).tocsr()
    b_ub = np.zeros(cat_count)
    b_eq = np.concatenate((np.zeros(balance_rows), np.ones(stage)))
    objective = np.zeros(variable_count)
    objective[max_load_index] = 1
    result = linprog(objective, A_ub=a_ub, b_ub=b_ub, A_eq=a_eq, b_eq=b_eq, bounds=(0, None), method="highs")
    if not result.success:
        return {"seed": seed["seed"], "stage": stage, "success": False, "reason": result.message}

    values = np.asarray(result.x)
    craft_values = values[:transport_offset]
    transport_values = values[transport_offset:absorption_offset]
    capacity_slack = np.asarray(result.ineqlin.residual)
    equality_residual = np.asarray(result.eqlin.residual)
    capacity_marginals = np.asarray(result.ineqlin.marginals)
    equality_marginals = np.asarray(result.eqlin.marginals)
    lower_marginals = np.asarray(result.lower.marginals)
    stationarity = objective - a_ub.T @ capacity_marginals - a_eq.T @ equality_marginals
    dual_objective = float(np.dot(b_ub, capacity_marginals) + np.dot(b_eq, equality_marginals))
    max_load = float(values[max_load_index])
    return {
        "seed": seed["seed"],
        "stage": stage,
        "success": True,
        "maxCatActionsPerBasket": max_load,
        "omniscientWindowLowerBoundMs": max_load * float(payload["actionDurationMs"]),
        "totalCraftActionsPerBasket": float(np.sum(craft_values)),
        "totalTransportActionsPerBasket": float(np.sum(transport_values)),
        "totalPhysicalActionsPerBasket": float(np.sum(craft_values) + np.sum(transport_values)),
        "bindingCatCount": int(np.sum(capacity_slack <= 1e-8)),
        "dualityGap": abs(float(result.fun) - dual_objective),
        "maxPrimalResidual": float(max(
            np.max(np.abs(equality_residual)),
            np.max(np.maximum(-capacity_slack, 0)),
        )),
        "maxKktResidual": float(np.max(np.abs(stationarity - lower_marginals))),
    }


def solve_integer_regenerative_period(
    payload: dict[str, Any],
    seed: dict[str, Any],
    stage: int,
    time_limit_seconds: float,
) -> dict[str, Any]:
    """Solve the exact discrete steady-state regenerative period.

    All craft, one-edge transport and terminal-basket variables are integers.
    The final variable K is the maximum number of five-second actions assigned
    to any cat.  Each target item has exactly one unit of terminal surplus, so
    all ingredients consumed by that basket are replaced.

    This aggregate model is also a realizable repeating pipeline: assign each
    cat's at-most-K integer actions to K slots in any fixed order and seed every
    cat/item buffer with the negative of its minimum within-period prefix sum.
    The balance equations make every end buffer no smaller than its start
    buffer.  Repeating the same slots is therefore legal after a finite warm-up.
    Conversely, aggregating any legal K-slot regenerative pipeline produces a
    feasible integer solution.  Thus K*5 seconds is the exact physical period,
    not a continuous relaxation or a fitted estimate.
    """
    recipes = payload["recipes"][:stage]
    items = payload["items"][:stage]
    cats = seed["cats"]
    cat_count = len(cats)
    item_index = {item["id"]: index for index, item in enumerate(items)}

    if any(recipe["activeSiteRequirementsByDifficulty"]["5"] for recipe in recipes):
        return {
            "seed": seed["seed"], "stage": stage, "success": False,
            "reason": "site-requirements-need-an-explicit-building-configuration",
        }

    craft_variables: list[tuple[int, int]] = []
    for cat_index, cat in enumerate(cats):
        for recipe_index, recipe in enumerate(recipes):
            if recipe_inputs(recipe) or recipe["output"] in cat["resourceItemIds"]:
                craft_variables.append((cat_index, recipe_index))
    transport_variables = [
        (source, target, item_i)
        for source, target in seed["directedEdges"]
        for item_i in range(stage)
    ]
    terminal_variables = [(cat_index, item_i) for cat_index in range(cat_count) for item_i in range(stage)]
    transport_offset = len(craft_variables)
    terminal_offset = transport_offset + len(transport_variables)
    period_slots_index = terminal_offset + len(terminal_variables)
    variable_count = period_slots_index + 1

    rows: list[int] = []
    cols: list[int] = []
    data: list[float] = []
    lower: list[float] = []
    upper: list[float] = []
    row_index = 0

    # Every cat executes at most K actions.  Receiving and terminal accounting
    # do not occupy an action; outbound one-edge transport does.
    craft_by_cat: list[list[int]] = [[] for _ in cats]
    for variable, (cat_index, _recipe_index) in enumerate(craft_variables):
        craft_by_cat[cat_index].append(variable)
    transport_by_source: list[list[int]] = [[] for _ in cats]
    for local_index, (source, _target, _item_i) in enumerate(transport_variables):
        transport_by_source[source].append(transport_offset + local_index)
    for cat_index in range(cat_count):
        for variable in craft_by_cat[cat_index]:
            add_entry(rows, cols, data, row_index, variable, 1)
        for variable in transport_by_source[cat_index]:
            add_entry(rows, cols, data, row_index, variable, 1)
        add_entry(rows, cols, data, row_index, period_slots_index, -1)
        lower.append(-np.inf)
        upper.append(0)
        row_index += 1

    # Per-cat/per-item conservation.  A terminal variable is physical surplus
    # (end inventory minus start inventory), not a free deletion.
    balance_row = [[row_index + cat_index * stage + item_i for item_i in range(stage)] for cat_index in range(cat_count)]
    for variable, (cat_index, recipe_index) in enumerate(craft_variables):
        recipe = recipes[recipe_index]
        add_entry(rows, cols, data, balance_row[cat_index][recipe_index], variable, 1)
        for ingredient in recipe_inputs(recipe):
            add_entry(
                rows, cols, data,
                balance_row[cat_index][item_index[ingredient["itemId"]]],
                variable, -int(ingredient["quantity"]),
            )
    for local_index, (source, target, item_i) in enumerate(transport_variables):
        variable = transport_offset + local_index
        add_entry(rows, cols, data, balance_row[source][item_i], variable, -1)
        add_entry(rows, cols, data, balance_row[target][item_i], variable, 1)
    for local_index, (cat_index, item_i) in enumerate(terminal_variables):
        add_entry(rows, cols, data, balance_row[cat_index][item_i], terminal_offset + local_index, -1)
    for _ in range(cat_count * stage):
        lower.append(0)
        upper.append(0)
        row_index += 1

    # Exactly one surplus unit of every target item per period.  Integrality
    # places that unit at one concrete cat.
    for item_i in range(stage):
        for cat_index in range(cat_count):
            local_index = cat_index * stage + item_i
            add_entry(rows, cols, data, row_index, terminal_offset + local_index, 1)
        lower.append(1)
        upper.append(1)
        row_index += 1

    constraint_matrix = coo_matrix((data, (rows, cols)), shape=(row_index, variable_count)).tocsr()
    constraints = LinearConstraint(constraint_matrix, np.asarray(lower), np.asarray(upper))
    objective = np.zeros(variable_count)
    objective[period_slots_index] = 1
    variable_lower = np.zeros(variable_count)
    variable_upper = np.full(variable_count, np.inf)
    # One unit of an item is assigned to exactly one cat as terminal surplus.
    variable_upper[terminal_offset:period_slots_index] = 1
    started = time.perf_counter()
    result = milp(
        objective,
        integrality=np.ones(variable_count),
        bounds=Bounds(variable_lower, variable_upper),
        constraints=constraints,
        options={
            "time_limit": time_limit_seconds,
            "mip_rel_gap": 0.0,
            "presolve": True,
        },
    )
    elapsed = time.perf_counter() - started
    if not result.success or result.x is None:
        return {
            "seed": seed["seed"], "stage": stage, "success": False,
            "reason": result.message,
            "status": int(result.status),
            "elapsedSeconds": elapsed,
            "mipGap": None if getattr(result, "mip_gap", None) is None else float(result.mip_gap),
        }

    period_slots = int(round(float(result.x[period_slots_index])))
    # K is the theorem quantity.  With K fixed to its proven optimum, solve a
    # second exact MILP to remove arbitrary zero-objective transport cycles and
    # obtain the minimum-hop representative of the optimal-period face.
    secondary_objective = np.zeros(variable_count)
    secondary_objective[transport_offset:terminal_offset] = 1
    secondary_lower = variable_lower.copy()
    secondary_upper = variable_upper.copy()
    secondary_lower[period_slots_index] = period_slots
    secondary_upper[period_slots_index] = period_slots
    secondary_started = time.perf_counter()
    secondary = milp(
        secondary_objective,
        integrality=np.ones(variable_count),
        bounds=Bounds(secondary_lower, secondary_upper),
        constraints=constraints,
        options={
            "time_limit": time_limit_seconds,
            "mip_rel_gap": 0.0,
            "presolve": True,
        },
    )
    secondary_elapsed = time.perf_counter() - secondary_started
    if not secondary.success or secondary.x is None:
        return {
            "seed": seed["seed"], "stage": stage, "success": False,
            "reason": f"period optimum found, minimum-hop certificate failed: {secondary.message}",
            "status": int(secondary.status),
            "elapsedSeconds": elapsed + secondary_elapsed,
            "provenPeriodSlots": period_slots,
        }

    rounded = np.rint(np.asarray(secondary.x)).astype(np.int64)
    residual = constraint_matrix @ rounded
    violations = np.maximum(np.asarray(lower) - residual, 0) + np.maximum(residual - np.asarray(upper), 0)
    craft_values = rounded[:transport_offset]
    transport_values = rounded[transport_offset:terminal_offset]
    terminal_values = rounded[terminal_offset:period_slots_index]
    period_slots = int(rounded[period_slots_index])
    cat_loads = []
    for cat_index in range(cat_count):
        cat_loads.append(int(
            sum(rounded[variable] for variable in craft_by_cat[cat_index])
            + sum(rounded[variable] for variable in transport_by_source[cat_index])
        ))
    basket_counts = regenerative_basket_counts(payload, stage, 1)
    actual_recipe_counts = [0] * stage
    for variable, (_cat_index, recipe_index) in enumerate(craft_variables):
        actual_recipe_counts[recipe_index] += int(rounded[variable])
    if actual_recipe_counts != basket_counts:
        raise AssertionError(
            f"integer mass balance did not recover the unique basket counts for seed={seed['seed']} stage={stage}"
        )
    if int(np.sum(terminal_values)) != stage:
        raise AssertionError("terminal surplus does not contain exactly one unit per item")
    lower_bound = getattr(result, "mip_node_count", None)
    return {
        "seed": seed["seed"],
        "stage": stage,
        "success": True,
        "periodSlots": period_slots,
        "exactDiscretePeriodMs": period_slots * int(payload["actionDurationMs"]),
        "totalCraftActionsPerBasket": int(np.sum(craft_values)),
        "totalTransportActionsPerBasket": int(np.sum(transport_values)),
        "totalPhysicalActionsPerBasket": int(np.sum(craft_values) + np.sum(transport_values)),
        "catLoads": cat_loads,
        "bindingCatCount": sum(load == period_slots for load in cat_loads),
        "integerFeasibilityResidual": float(np.max(violations)) if len(violations) else 0.0,
        "mipGap": max(
            float(getattr(result, "mip_gap", 0.0) or 0.0),
            float(getattr(secondary, "mip_gap", 0.0) or 0.0),
        ),
        "mipNodeCount": None if lower_bound is None else int(lower_bound),
        "secondaryMipNodeCount": None if getattr(secondary, "mip_node_count", None) is None else int(secondary.mip_node_count),
        "elapsedSeconds": elapsed + secondary_elapsed,
        "proof": {
            "lower": "Every legal regenerative pipeline aggregates to these integer conservation and per-cat capacity constraints, hence needs at least K slots.",
            "upper": "Assign each cat's actions to K slots and seed finite per-cat/item buffers equal to the largest within-period prefix deficit; conservation makes end stock componentwise no lower, so the slot pattern repeats legally.",
        },
    }


def init_worker(payload: dict[str, Any]) -> None:
    global PAYLOAD
    PAYLOAD = payload


def solve_job(job: tuple[int, int]) -> dict[str, Any]:
    seed_index, stage = job
    assert PAYLOAD is not None
    return solve_spatial_cycle(PAYLOAD, PAYLOAD["seeds"][seed_index], stage)


def solve_integer_job(job: tuple[int, int, float]) -> dict[str, Any]:
    seed_index, stage, time_limit_seconds = job
    assert PAYLOAD is not None
    return solve_integer_regenerative_period(
        PAYLOAD,
        PAYLOAD["seeds"][seed_index],
        stage,
        time_limit_seconds,
    )


def main() -> None:
    started = time.perf_counter()
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    if payload.get("schema") != 2:
        raise ValueError("expected price-theory input schema 2")
    stages = [int(value) for value in args.stages.split(",") if value.strip()]
    integer_stages = [int(value) for value in args.integer_stages.split(",") if value.strip()]
    if any(stage <= 0 or stage > len(payload["items"]) for stage in stages):
        raise ValueError("stage is outside the real catalog")
    if any(stage <= 0 or stage > len(payload["items"]) for stage in integer_stages):
        raise ValueError("integer stage is outside the real catalog")
    seed_limit = min(args.seed_limit, len(payload["seeds"]))
    payload["seeds"] = payload["seeds"][:seed_limit]

    depths, single_work = calculate_prefix_metrics(payload)
    prefix_rows = []
    for stage in sorted(set([10, 15, 19, 20, 22, 30, 35, 65])):
        one_basket = regenerative_basket_counts(payload, stage, 1)
        three_baskets = [3 * value for value in one_basket]
        deepest_index = max(range(stage), key=lambda index: depths[index])
        prefix_rows.append({
            "stage": stage,
            "dependencyDepth": max(depths[:stage]),
            "deepestItemId": payload["items"][deepest_index]["id"],
            "singleDeepestItemTechnicalWork": str(single_work[deepest_index]),
            "oneBasketTechnicalActions": str(sum(one_basket)),
            "threeWindowMinimumTechnicalActions": str(sum(three_baskets)),
            "oneBasketCraftCounts": {
                payload["items"][index]["id"]: str(value)
                for index, value in enumerate(one_basket)
            },
            "minimalityProof": "Reverse topological substitution is the unique componentwise-minimal nonnegative integer solution because every recipe coefficient and action cost is positive.",
        })

    periodic_family = build_periodic_family(payload, max(args.extension_items, 65), args.power_iterations)

    jobs = [(seed_index, stage) for seed_index in range(seed_limit) for stage in stages]
    with ProcessPoolExecutor(max_workers=args.workers, initializer=init_worker, initargs=(payload,)) as pool:
        spatial_results = list(pool.map(solve_job, jobs, chunksize=4))
    successful = [entry for entry in spatial_results if entry["success"]]
    failures = [entry for entry in spatial_results if not entry["success"]]
    aggregates = []
    for stage in stages:
        group = [entry for entry in successful if entry["stage"] == stage]
        if not group:
            aggregates.append({"stage": stage, "count": 0})
            continue
        aggregates.append({
            "stage": stage,
            "count": len(group),
            "maxCatActionsPerBasket": quantiles(entry["maxCatActionsPerBasket"] for entry in group),
            "omniscientWindowLowerBoundMs": quantiles(entry["omniscientWindowLowerBoundMs"] for entry in group),
            "totalCraftActionsPerBasket": quantiles(entry["totalCraftActionsPerBasket"] for entry in group),
            "totalTransportActionsPerBasket": quantiles(entry["totalTransportActionsPerBasket"] for entry in group),
            "totalPhysicalActionsPerBasket": quantiles(entry["totalPhysicalActionsPerBasket"] for entry in group),
            "bindingCatCount": quantiles(entry["bindingCatCount"] for entry in group),
            "maxDualityGap": max(entry["dualityGap"] for entry in group),
            "maxPrimalResidual": max(entry["maxPrimalResidual"] for entry in group),
            "maxKktResidual": max(entry["maxKktResidual"] for entry in group),
        })

    integer_seed_limit = min(args.integer_seed_limit, seed_limit)
    integer_jobs = [
        (seed_index, stage, args.mip_time_limit_seconds)
        for seed_index in range(integer_seed_limit)
        for stage in integer_stages
    ]
    with ProcessPoolExecutor(max_workers=args.workers, initializer=init_worker, initargs=(payload,)) as pool:
        integer_results = list(pool.map(solve_integer_job, integer_jobs, chunksize=1))
    integer_successful = [entry for entry in integer_results if entry["success"]]
    integer_failures = [entry for entry in integer_results if not entry["success"]]
    integer_aggregates = []
    for stage in integer_stages:
        group = [entry for entry in integer_successful if entry["stage"] == stage]
        integer_aggregates.append({
            "stage": stage,
            "count": len(group),
            **({} if not group else {
                "periodSlots": quantiles(entry["periodSlots"] for entry in group),
                "exactDiscretePeriodMs": quantiles(entry["exactDiscretePeriodMs"] for entry in group),
                "totalCraftActionsPerBasket": quantiles(entry["totalCraftActionsPerBasket"] for entry in group),
                "totalTransportActionsPerBasket": quantiles(entry["totalTransportActionsPerBasket"] for entry in group),
                "totalPhysicalActionsPerBasket": quantiles(entry["totalPhysicalActionsPerBasket"] for entry in group),
                "bindingCatCount": quantiles(entry["bindingCatCount"] for entry in group),
                "maxIntegerFeasibilityResidual": max(entry["integerFeasibilityResidual"] for entry in group),
                "maxMipGap": max(entry["mipGap"] for entry in group),
                "elapsedSeconds": quantiles(entry["elapsedSeconds"] for entry in group),
            }),
        })

    result = {
        "schema": "cat-workshop-cycle-complexity-proof-v1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": {
            "input": str(input_path),
            "inputSha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
            "catalogItemCount": len(payload["items"]),
            "worldCount": seed_limit,
            "difficulty": 5,
            "actionDurationMs": payload["actionDurationMs"],
        },
        "definitions": {
            "intrinsicTechnicalWork": "Minimum harvest+craft actions for one autonomous gross unit of every target while replacing every consumed input.",
            "omniscientCycleTime": "Minimum fractional steady-state maximum per-cat action load for one complete target basket, multiplied by the fixed action duration; it is a certified physical lower bound before market and behavioral constraints.",
            "exactDiscreteRegenerativePeriod": "P*_N(G)=5000*K*_N(G), where K* is the minimum integer maximum per-cat craft+outbound-hop load for one surplus unit of every target while replacing all consumed inputs. It is the exact warm-pipeline physical period before market and behavioral constraints.",
            "coordinationMultiplier": "H^L_N(G)=P^L_N(G)/P*_N(G). P^L is accepted only from a frozen-law, non-drawing, non-debt-drifting three-window trajectory certificate; right-censored runs have no reported H.",
            "regenerativeInventory": "End aggregate stock is componentwise no lower than start; one basket leaves one autonomous terminal unit of every target after replacing all recipe inputs.",
        },
        "realCatalog": {
            "depthByItem": {payload["items"][index]["id"]: depths[index] for index in range(len(depths))},
            "singleItemTechnicalWork": {payload["items"][index]["id"]: str(single_work[index]) for index in range(len(single_work))},
            "prefixCertificates": prefix_rows,
        },
        "periodicFamily": periodic_family,
        "spatialCycleLp": {
            "model": "continuous multi-commodity regenerative basket flow with per-cat craft+outbound-transport capacity",
            "stages": stages,
            "aggregates": aggregates,
            "failures": failures,
            "certificates": successful,
            "qualification": "This is the exact fluid physical optimum and a lower bound on the finite three-window market cycle. Site-constrained stages require an explicit player building configuration and are not silently approximated.",
        },
        "integerRegenerativePeriodMilp": {
            "model": "integer multi-commodity regenerative basket flow with five-second slots and per-cat craft+outbound-transport capacity",
            "stages": integer_stages,
            "worldCount": integer_seed_limit,
            "aggregates": integer_aggregates,
            "failures": integer_failures,
            "certificates": integer_successful,
            "qualification": "Exact for the warm steady-state physical pipeline on stages without site requirements. It intentionally excludes prices, laws, orders, credit and decision latency; those are measured by H, not inserted as guessed constants.",
        },
        "compute": {
            "hostname": socket.gethostname(),
            "platform": platform.platform(),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "logicalCpuCount": os.cpu_count(),
            "workers": args.workers,
            "elapsedSeconds": time.perf_counter() - started,
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "worlds": seed_limit,
        "stages": stages,
        "jobs": len(jobs),
        "failures": len(failures),
        "integerJobs": len(integer_jobs),
        "integerFailures": len(integer_failures),
        "extensionItems": args.extension_items,
        "growth": periodic_family["periodicGrowthCertificate"],
        "elapsedSeconds": result["compute"]["elapsedSeconds"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
