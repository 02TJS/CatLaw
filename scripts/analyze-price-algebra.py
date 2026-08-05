#!/usr/bin/env python3
"""Derive Cat Workshop prices symbolically, then substitute a rule set.

The symbolic recurrence is primary. The current game constants are substituted
only in the final section so taxes, credit, freight, and blueprint funding are
not mistaken for mathematical constants.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import sympy as sp


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="output/price-theory-input.json")
    parser.add_argument("--output", default="output/price-algebra-analysis.json")
    parser.add_argument("--difficulty", type=int, default=5)
    parser.add_argument("--tax-rate", type=float, default=0.5)
    parser.add_argument("--procurement-friction-cents", type=int, default=25)
    parser.add_argument("--loan-rate", type=float, default=0.02)
    parser.add_argument("--minimum-loan-fee-cents", type=int, default=1)
    parser.add_argument("--carrier-fee-cap-cents", type=int, default=25)
    parser.add_argument("--ordinary-order-premium-cents", type=int, default=100)
    parser.add_argument("--coordination-risk-cents-per-work", type=int, default=15)
    parser.add_argument("--coordination-horizon-work-units", type=int, default=10)
    parser.add_argument("--minimum-positive-gain-cents", type=int, default=1)
    parser.add_argument("--cents-per-coin", type=int, default=100)
    parser.add_argument("--base-resource-price-coins", type=int, default=1)
    parser.add_argument("--max-route-edges", type=int)
    parser.add_argument("--blueprint-cost-cents-per-base-price-coin", type=int, default=200)
    parser.add_argument("--minimum-blueprint-cost-cents", type=int, default=100)
    parser.add_argument("--blueprint-budget-cents", type=int, default=15_000)
    return parser.parse_args()


def recipe_inputs(recipe: dict[str, Any], difficulty: int) -> list[dict[str, Any]]:
    return recipe["difficulty5Inputs"] if difficulty == 5 else recipe["baseInputs"]


def work_units(payload: dict[str, Any], difficulty: int) -> dict[str, int]:
    recipes = {recipe["output"]: recipe for recipe in payload["recipes"]}
    memo: dict[str, int] = {}

    def visit(item_id: str) -> int:
        if item_id in memo:
            return memo[item_id]
        value = 1 + sum(int(entry["quantity"]) * visit(entry["itemId"])
                        for entry in recipe_inputs(recipes[item_id], difficulty))
        memo[item_id] = value
        return value

    for item in payload["items"]:
        visit(item["id"])
    return memo


def graph_diameter(seed: dict[str, Any]) -> int:
    count = len(seed["cats"])
    adjacency = [[] for _ in range(count)]
    for source, target in seed["directedEdges"]:
        adjacency[source].append(target)
    maximum = 0
    for origin in range(count):
        distance = [-1] * count
        distance[origin] = 0
        queue = [origin]
        while queue:
            source = queue.pop(0)
            for target in adjacency[source]:
                if distance[target] >= 0:
                    continue
                distance[target] = distance[source] + 1
                queue.append(target)
        if any(value < 0 for value in distance):
            raise ValueError("starter graph is disconnected")
        maximum = max(maximum, max(distance))
    return maximum


def exact_vector(payload: dict[str, Any], parameters: dict[str, float]) -> tuple[dict[str, int], list[dict[str, Any]]]:
    difficulty = int(parameters["difficulty"])
    tax = float(parameters["taxRate"])
    friction = int(parameters["procurementFrictionCents"])
    loan_rate = float(parameters["loanRate"])
    carrier_cap = int(parameters["carrierFeeCapCents"])
    order_premium = int(parameters["ordinaryOrderPremiumCents"])
    risk_rate = int(parameters["coordinationRiskCentsPerWork"])
    horizon = int(parameters["coordinationHorizonWorkUnits"])
    epsilon = int(parameters["minimumPositiveGainCents"])
    minimum_loan_fee = int(parameters["minimumLoanFeeCents"])
    cents_per_coin = int(parameters["centsPerCoin"])
    base_resource_price = int(parameters["baseResourcePriceCoins"])
    route_edges = int(parameters["maxRouteEdges"])
    base_work = work_units(payload, 1)

    if not 0 <= tax < 1:
        raise ValueError("taxRate must satisfy 0 <= taxRate < 1")
    if any(value < 0 for value in (friction, loan_rate, carrier_cap, order_premium, risk_rate)):
        raise ValueError("cost and rate parameters must be non-negative")
    if any(value <= 0 for value in (horizon, epsilon, minimum_loan_fee, cents_per_coin, base_resource_price, route_edges)):
        raise ValueError("scale, horizon, epsilon, prices and route length must be positive")

    def net(price_coins: int) -> int:
        gross = price_coins * cents_per_coin
        return gross - min(gross, math.ceil(gross * tax - 1e-12))

    def fully_financed_order_fee(order_cents: int) -> int:
        """Exact fee for one zero-cash order under the runtime settlement rule."""
        return max(minimum_loan_fee, math.ceil(order_cents * loan_rate - 1e-12))

    carrier_cost = max(0, route_edges - 1) * carrier_cap
    margin = max(epsilon, carrier_cost - order_premium + epsilon)
    prices: dict[str, int] = {}
    rows = []
    for recipe in payload["recipes"]:
        inputs = recipe_inputs(recipe, difficulty)
        if not inputs:
            price = base_resource_price
            prices[recipe["output"]] = price
            rows.append({
                "itemId": recipe["output"],
                "basePriceCoins": price,
                "externalPlanGainCents": net(price),
                "priceRole": "exogenous-numeraire",
                "minimalIntegerVerified": True,
            })
            continue
        input_units = sum(int(entry["quantity"]) for entry in inputs)
        opportunity = sum(int(entry["quantity"]) * net(prices[entry["itemId"]]) for entry in inputs)
        order_rows = [{
            "itemId": entry["itemId"],
            "quantity": int(entry["quantity"]),
            "unitBidCents": net(prices[entry["itemId"]]) + order_premium,
            "unitLoanFeeCents": fully_financed_order_fee(net(prices[entry["itemId"]]) + order_premium),
        } for entry in inputs]
        working_capital = sum(entry["quantity"] * entry["unitBidCents"] for entry in order_rows)
        # The game opens one order per missing unit and charges/rounds each loan
        # at contract settlement.  ceil(r * sum K) can therefore understate the
        # exact fee by as much as m_i-1 cents and is not used here.
        financing = sum(entry["quantity"] * entry["unitLoanFeeCents"] for entry in order_rows)
        procurement = input_units * friction
        risk = max(0, base_work[recipe["output"]] - horizon) * risk_rate
        required_net = opportunity + procurement + financing + risk + margin
        price = 1
        while net(price) < required_net:
            price += 1
        gain = net(price) - opportunity - procurement - financing - risk
        worst_order_gain = gain + order_premium - carrier_cost
        if gain < margin or worst_order_gain < epsilon:
            raise AssertionError(f"individual-rationality proof failed for {recipe['output']}")
        prices[recipe["output"]] = price
        rows.append({
            "itemId": recipe["output"],
            "basePriceCoins": price,
            "inputOpportunityCostCents": opportunity,
            "procurementFrictionCents": procurement,
            "zeroCashWorkingCapitalCents": working_capital,
            "zeroCashFinancingCostCents": financing,
            "zeroCashOrderRows": order_rows,
            "coordinationRiskCostCents": risk,
            "requiredExternalMarginCents": margin,
            "requiredNetOutputCents": required_net,
            "netOutputCents": net(price),
            "previousIntegerNetCents": net(price - 1) if price > 1 else None,
            "minimalIntegerVerified": net(price) >= required_net and (price == 1 or net(price - 1) < required_net),
            "externalPlanGainCents": gain,
            "worstRouteOrderGainCents": worst_order_gain,
        })
    return prices, rows


def blueprint_costs(
    prices: dict[str, int],
    blueprint_ids: list[str],
    cents_per_price_coin: int,
    minimum_cost_cents: int,
) -> tuple[dict[str, int], int]:
    costs = {
        item_id: max(minimum_cost_cents, cents_per_price_coin * prices[item_id])
        for item_id in blueprint_ids
    }
    return costs, sum(costs.values())


def continuous_vector(
    payload: dict[str, Any],
    parameters: dict[str, float],
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    """Evaluate the general piecewise-continuous DAG recurrence for all items."""
    difficulty = int(parameters["difficulty"])
    tax = float(parameters["taxRate"])
    q = 1 - tax
    friction = float(parameters["procurementFrictionCents"])
    loan_rate = float(parameters["loanRate"])
    minimum_loan_fee = float(parameters["minimumLoanFeeCents"])
    carrier_cap = float(parameters["carrierFeeCapCents"])
    order_premium = float(parameters["ordinaryOrderPremiumCents"])
    risk_rate = float(parameters["coordinationRiskCentsPerWork"])
    horizon = int(parameters["coordinationHorizonWorkUnits"])
    epsilon = float(parameters["minimumPositiveGainCents"])
    cents_per_coin = float(parameters["centsPerCoin"])
    base_resource_price = float(parameters["baseResourcePriceCoins"])
    route_edges = int(parameters["maxRouteEdges"])
    base_work = work_units(payload, 1)
    margin = max(epsilon, (route_edges - 1) * carrier_cap - order_premium + epsilon)
    prices: dict[str, float] = {}
    rows: list[dict[str, Any]] = []
    for recipe in payload["recipes"]:
        inputs = recipe_inputs(recipe, difficulty)
        if not inputs:
            price = base_resource_price
            prices[recipe["output"]] = price
            rows.append({
                "itemId": recipe["output"],
                "continuousPriceCoins": price,
                "percentageLoanBranchActive": True,
            })
            continue
        input_price_sum = sum(int(entry["quantity"]) * prices[entry["itemId"]] for entry in inputs)
        input_units = sum(int(entry["quantity"]) for entry in inputs)
        order_terms = [{
            "itemId": entry["itemId"],
            "quantity": int(entry["quantity"]),
            "unitBidCents": q * cents_per_coin * prices[entry["itemId"]] + order_premium,
        } for entry in inputs]
        financing = sum(
            entry["quantity"] * max(minimum_loan_fee, loan_rate * entry["unitBidCents"])
            for entry in order_terms
        )
        risk = risk_rate * max(base_work[recipe["output"]] - horizon, 0)
        price = input_price_sum + (friction * input_units + financing + risk + margin) / (cents_per_coin * q)
        prices[recipe["output"]] = price
        rows.append({
            "itemId": recipe["output"],
            "continuousPriceCoins": price,
            "inputPriceSumCoins": input_price_sum,
            "procurementFrictionCents": friction * input_units,
            "continuousFinancingCents": financing,
            "coordinationRiskCostCents": risk,
            "requiredExternalMarginCents": margin,
            "percentageLoanBranchActive": all(
                loan_rate * entry["unitBidCents"] >= minimum_loan_fee for entry in order_terms
            ),
        })
    return prices, rows


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    item_ids = [item["id"] for item in payload["items"]]
    difficulty = args.difficulty
    if difficulty not in range(1, 6):
        raise ValueError("difficulty must be an integer from 1 to 5")
    base_work = work_units(payload, 1)

    # q is kept as a positive symbol in expanded expressions.  Only after the
    # algebra is built do we substitute q = 1-tau.  This avoids hiding positive
    # coefficients behind SymPy's equivalent (tau-1) denominator.
    tau = sp.symbols("tau", nonnegative=True)
    q, f, r, h, b, rho, epsilon, ell, u, c = sp.symbols(
        "q f r h b rho epsilon ell u c", positive=True
    )
    B, kappa, delta = sp.symbols("B kappa delta", positive=True)
    L, H = sp.symbols("L H", integer=True, positive=True)
    M = sp.Max(epsilon, (L - 1) * h - b + epsilon)
    symbolic_prices: dict[str, sp.Expr] = {}
    piecewise_prices: dict[str, sp.Expr] = {}
    symbolic_rows = []
    for recipe in payload["recipes"][:15]:
        inputs = recipe_inputs(recipe, difficulty)
        if not inputs:
            expression = c
            piecewise_expression = c
            local_recurrence = "c"
        else:
            input_sum = sum(int(entry["quantity"]) * symbolic_prices[entry["itemId"]] for entry in inputs)
            piecewise_input_sum = sum(int(entry["quantity"]) * piecewise_prices[entry["itemId"]] for entry in inputs)
            input_units = sum(int(entry["quantity"]) for entry in inputs)
            risk = rho * sp.Max(base_work[recipe["output"]] - H, 0)
            piecewise_financing = sum(
                int(entry["quantity"]) * sp.Max(
                    ell,
                    r * (q * u * piecewise_prices[entry["itemId"]] + b),
                )
                for entry in inputs
            )
            piecewise_expression = sp.cancel(
                piecewise_input_sum
                + (f * input_units + piecewise_financing + risk + M) / (u * q)
            )
            # Matrix form below is the percentage-fee branch of the general
            # piecewise recurrence, i.e. r*(q*u*p_j+b) >= ell on every edge.
            expression = sp.cancel(
                (1 + r) * input_sum
                + ((f + r * b) * input_units + risk + M) / (u * q)
            )
            input_terms = " + ".join(
                f"{int(entry['quantity'])}*p_{entry['itemId']}" if int(entry["quantity"]) != 1 else f"p_{entry['itemId']}"
                for entry in inputs
            )
            local_recurrence = (
                f"({input_terms}) + [{input_units}*f + sum_inputs max(ell,r*(u*q*p_input+b)) + "
                f"rho*max(W_{recipe['output']}-H,0) + M]/(u*q)"
            )
        symbolic_prices[recipe["output"]] = expression
        piecewise_prices[recipe["output"]] = piecewise_expression
        symbolic_rows.append({
            "itemId": recipe["output"],
            "localRecurrence": local_recurrence,
            "expression": str(expression),
        })

    blueprint_ids = ["paper", "tools", "glass", "metal", "gear"]
    blueprint_sum_expression = sp.cancel(sum(symbolic_prices[item_id] for item_id in blueprint_ids))
    continuous_blueprint_spend_expression = kappa * blueprint_sum_expression

    diameter_values = {graph_diameter(seed) for seed in payload["seeds"]}
    if len(diameter_values) != 1:
        raise ValueError(f"starter graph diameter varies: {sorted(diameter_values)}")
    observed_route_edges = diameter_values.pop()
    max_route_edges = args.max_route_edges if args.max_route_edges is not None else observed_route_edges
    substituted_parameters = {
        "difficulty": difficulty,
        "taxRate": args.tax_rate,
        "procurementFrictionCents": args.procurement_friction_cents,
        "loanRate": args.loan_rate,
        "minimumLoanFeeCents": args.minimum_loan_fee_cents,
        "carrierFeeCapCents": args.carrier_fee_cap_cents,
        "ordinaryOrderPremiumCents": args.ordinary_order_premium_cents,
        "coordinationRiskCentsPerWork": args.coordination_risk_cents_per_work,
        "coordinationHorizonWorkUnits": args.coordination_horizon_work_units,
        "minimumPositiveGainCents": args.minimum_positive_gain_cents,
        "centsPerCoin": args.cents_per_coin,
        "baseResourcePriceCoins": args.base_resource_price_coins,
        "maxRouteEdges": max_route_edges,
        "blueprintCostCentsPerBasePriceCoin": args.blueprint_cost_cents_per_base_price_coin,
        "minimumBlueprintCostCents": args.minimum_blueprint_cost_cents,
        "initialBlueprintBudgetCents": args.blueprint_budget_cents,
    }
    prices, exact_rows = exact_vector(payload, substituted_parameters)
    continuous_prices_all, continuous_rows_all = continuous_vector(payload, substituted_parameters)
    per_blueprint_costs, blueprint_total = blueprint_costs(
        prices,
        blueprint_ids,
        args.blueprint_cost_cents_per_base_price_coin,
        args.minimum_blueprint_cost_cents,
    )

    # Differentiate the continuous recurrence only after choosing the active
    # branches at the current rule point. Integer price jumps are reported
    # separately by the exact recurrence above.
    active_substitutions = {
        tau: sp.Float(args.tax_rate), q: sp.Float(1 - args.tax_rate),
        f: args.procurement_friction_cents, r: sp.Float(args.loan_rate),
        h: args.carrier_fee_cap_cents, b: args.ordinary_order_premium_cents,
        rho: args.coordination_risk_cents_per_work, epsilon: args.minimum_positive_gain_cents,
        ell: args.minimum_loan_fee_cents,
        u: args.cents_per_coin, c: args.base_resource_price_coins,
        L: max_route_edges, H: args.coordination_horizon_work_units,
        kappa: args.blueprint_cost_cents_per_base_price_coin,
        delta: args.minimum_blueprint_cost_cents, B: args.blueprint_budget_cents,
    }
    continuous_values = {
        item_id: float(expression.subs(active_substitutions))
        for item_id, expression in symbolic_prices.items()
    }
    piecewise_continuous_values = {
        item_id: float(expression.subs(active_substitutions))
        for item_id, expression in piecewise_prices.items()
    }
    rate_branch_active = all(
        args.loan_rate * order["unitBidCents"] >= args.minimum_loan_fee_cents
        for row in exact_rows
        for order in row.get("zeroCashOrderRows", [])
    )
    if rate_branch_active and any(
        abs(continuous_values[item_id] - piecewise_continuous_values[item_id]) > 1e-8
        for item_id in item_ids[:15]
    ):
        raise AssertionError("piecewise and percentage-loan branch values disagree at the substituted point")
    if any(
        abs(piecewise_continuous_values[item_id] - continuous_prices_all[item_id]) > 1e-8
        for item_id in item_ids[:15]
    ):
        raise AssertionError("symbolic and numeric piecewise recurrences disagree for the first fifteen items")
    # tau acts through q=1-tau, so d/dtau = -d/dq.  B and kappa do not enter
    # technical prices; they enter only the separate blueprint constraint.
    price_sum_sensitivity_expressions = {
        "tau": -sp.diff(blueprint_sum_expression, q),
        "f": sp.diff(blueprint_sum_expression, f),
        "r": sp.diff(blueprint_sum_expression, r),
        "h": sp.diff(blueprint_sum_expression, h),
        "b": sp.diff(blueprint_sum_expression, b),
        "rho": sp.diff(blueprint_sum_expression, rho),
        "u": sp.diff(blueprint_sum_expression, u),
        "c": sp.diff(blueprint_sum_expression, c),
    }
    blueprint_sensitivities = {
        name: float(expression.subs(active_substitutions))
        for name, expression in price_sum_sensitivity_expressions.items()
    }
    continuous_blueprint_sum = float(blueprint_sum_expression.subs(active_substitutions))
    parameter_values = {
        "tau": args.tax_rate,
        "f": args.procurement_friction_cents,
        "r": args.loan_rate,
        "h": args.carrier_fee_cap_cents,
        "b": args.ordinary_order_premium_cents,
        "rho": args.coordination_risk_cents_per_work,
        "u": args.cents_per_coin,
        "c": args.base_resource_price_coins,
    }
    elasticities = {
        name: (derivative * parameter_values[name] / continuous_blueprint_sum
               if continuous_blueprint_sum != 0 else None)
        for name, derivative in blueprint_sensitivities.items()
    }

    ingredient_matrix = []
    for recipe in payload["recipes"]:
        ingredient_matrix.append({
            "output": recipe["output"],
            "inputs": recipe_inputs(recipe, difficulty),
        })

    item_by_id = {item["id"]: item for item in payload["items"]}
    recipe_by_output = {recipe["output"]: recipe for recipe in payload["recipes"]}
    exact_by_id = {row["itemId"]: row for row in exact_rows}
    continuous_by_id = {row["itemId"]: row for row in continuous_rows_all}
    all_item_rows = []
    for index, item_id in enumerate(item_ids, 1):
        item = item_by_id[item_id]
        recipe = recipe_by_output[item_id]
        current_catalog_price = int(item["currentCatalogPriceCoins"])
        exact_price = prices[item_id]
        active_requirements = recipe.get("activeSiteRequirementsByDifficulty", {}).get(str(difficulty), [])
        all_item_rows.append({
            "index": index,
            "itemId": item_id,
            "name": item["name"],
            "emoji": item["emoji"],
            "tier": int(item["tier"]),
            "difficultyInputs": recipe_inputs(recipe, difficulty),
            "siteRequirements": active_requirements,
            "workUnitsUsedByRuntime": base_work[item_id],
            "continuousPriceCoins": continuous_prices_all[item_id],
            "exactIntegerPriceCoins": exact_price,
            "currentCatalogPriceCoins": current_catalog_price,
            "exactToCurrentRatio": exact_price / current_catalog_price,
            "exactTerms": exact_by_id[item_id],
            "continuousTerms": continuous_by_id[item_id],
        })
    tier_summaries = []
    for tier in sorted({row["tier"] for row in all_item_rows}):
        tier_rows = [row for row in all_item_rows if row["tier"] == tier]
        tier_summaries.append({
            "tier": tier,
            "itemCount": len(tier_rows),
            "exactPriceMinCoins": min(row["exactIntegerPriceCoins"] for row in tier_rows),
            "exactPriceMaxCoins": max(row["exactIntegerPriceCoins"] for row in tier_rows),
            "exactPriceSumCoins": sum(row["exactIntegerPriceCoins"] for row in tier_rows),
            "currentCatalogSumCoins": sum(row["currentCatalogPriceCoins"] for row in tier_rows),
        })
    paid_item_ids = item_ids[10:]
    all_paid_blueprint_costs, all_paid_blueprint_total = blueprint_costs(
        prices,
        paid_item_ids,
        args.blueprint_cost_cents_per_base_price_coin,
        args.minimum_blueprint_cost_cents,
    )

    output = {
        "schema": "cat-workshop-symbolic-price-model-v2",
        "source": str(input_path),
        "modelClass": "parametric Leontief DAG with robust individual-rationality constraints",
        "parameterPolicy": (
            "No tax, friction, lending, freight, order-premium or blueprint-budget number is a theorem. "
            "They remain free parameters through the derivation and are substituted only in finalRulePoint."
        ),
        "domains": {
            "tax": "0 <= tau < 1 and q = 1-tau",
            "nonnegative": ["f", "r", "h", "b", "rho"],
            "strictlyPositive": ["epsilon", "ell", "u", "c", "B", "kappa", "delta"],
            "positiveIntegers": ["L", "H"],
        },
        "symbols": {
            "tau": "external sales tax rate",
            "q": "after-tax retention q=1-tau",
            "f": "procurement friction cents per missing input unit",
            "r": "loan fee rate",
            "ell": "minimum fee cents charged for one positive loan",
            "h": "maximum carrier fee cents per intermediate cat",
            "b": "ordinary order premium cents",
            "L": "maximum route edge count in the priced topology",
            "rho": "coordination-risk cents per work unit above H",
            "H": "single-cat coordination horizon in work units",
            "epsilon": "minimum strictly positive gain in cents",
            "u": "cents per coin",
            "c": "base-resource price numeraire in coins",
            "B": "blueprint budget in cents",
            "kappa": "blueprint cost cents per catalog-price coin",
            "delta": "minimum price of one paid blueprint in cents",
        },
        "algebra": {
            "netValue": "n_tau(p) = u*p - ceil(tau*u*p); continuous form n_bar_tau(p) = u*(1-tau)*p",
            "workingCapital": "K_i = sum_j a_ij * (n_tau(p_j) + b)",
            "perOrderLoanFee": "phi_(r,ell)(z) = max(ell, ceil(r*z)) for a positive zero-cash order z; total financing is sum_j a_ij*phi_(r,ell)(n_tau(p_j)+b)",
            "transportMargin": "M = max(epsilon, (L-1)*h - b + epsilon)",
            "exactIntegerRecurrence": "p_i = min {positive integer p: n_tau(p) >= sum_j a_ij*n_tau(p_j) + f*m_i + sum_j a_ij*phi_(r,ell)(n_tau(p_j)+b) + rho*max(W_i-H,0) + M}",
            "piecewiseContinuousRecurrence": "p_i* = sum_j a_ij*p_j* + [f*m_i + sum_j a_ij*max(ell,r*(u*q*p_j*+b)) + rho*max(W_i-H,0) + M]/(u*q)",
            "percentageLoanBranch": "If r*(u*q*p_j*+b) >= ell on every used edge, the piecewise recurrence reduces to p_i*=(1+r)*sum_j a_ij*p_j*+[(f+r*b)m_i+rho*max(W_i-H,0)+M]/(u*q)",
            "matrixFormOnPercentageLoanBranch": "p* = (I-(1+r)A)^(-1)d = sum_{k=0}^{64}((1+r)A)^k d, because the recipe DAG makes A^65=0",
            "blueprintCost": "C_i^blueprint = max(delta, kappa*p_i)",
            "budgetFeasibility": "sum_{i in {11,...,15}} max(delta,kappa*p_i) <= B",
            "feasibleParameterSet": "Theta = {all domain-valid parameter vectors theta: C_blueprint(theta) <= B}; B changes affordability, not the technical price recurrence",
            "minimality": "Topological induction plus monotonic n_tau makes the exact integer vector componentwise minimal for the stated robust constraints.",
            "scope": "This is a sufficient zero-cash/all-inputs-missing/longest-route price envelope, not a proof of steady network throughput; the latter is tested by the separate multi-commodity flow LP and deterministic simulation.",
        },
        "symbolicFirst15": symbolic_rows,
        "symbolicBlueprintPriceSum": str(blueprint_sum_expression),
        "symbolicContinuousBlueprintSpendWhenMinimumDoesNotBind": str(continuous_blueprint_spend_expression),
        "ingredientMatrix": ingredient_matrix,
        "finalRulePoint": {
            "label": "current difficulty-5 rule point, substituted after the symbolic derivation",
            "parameters": substituted_parameters,
            "observedStarterGraphDiameterEdges": observed_route_edges,
            "continuousFirst15": {item_id: continuous_values[item_id] for item_id in item_ids[:15]},
            "piecewiseContinuousFirst15": {item_id: piecewise_continuous_values[item_id] for item_id in item_ids[:15]},
            "percentageLoanBranchActiveForFirst15": rate_branch_active,
            "percentageLoanBranchActiveForAll65": all(row["percentageLoanBranchActive"] for row in continuous_rows_all),
            "exactIntegerPrices": prices,
            "exactRows": exact_rows,
            "first15": [[item_id, prices[item_id]] for item_id in item_ids[:15]],
            "perBlueprintCostsCents": per_blueprint_costs,
            "blueprint11To15TotalCents": blueprint_total,
            "blueprintBudgetSlackCents": args.blueprint_budget_cents - blueprint_total,
            "blueprintAffordable": blueprint_total <= args.blueprint_budget_cents,
            "continuousBlueprintPriceSum": continuous_blueprint_sum,
            "continuousBlueprintPriceSumDerivatives": blueprint_sensitivities,
            "continuousBlueprintPriceSumElasticities": elasticities,
            "budgetDerivatives": {
                "technicalPriceWithRespectToB": 0,
                "affordabilitySlackWithRespectToB": 1,
                "spendWithRespectToKappaWhenMinimumDoesNotBind": continuous_blueprint_sum,
            },
            "all65": all_item_rows,
            "tierSummaries": tier_summaries,
            "allPaidBlueprintCostsCents": all_paid_blueprint_costs,
            "allPaidBlueprintTotalCents": all_paid_blueprint_total,
            "proofChecks": {
                "itemCount": len(all_item_rows),
                "allExactPricesPositiveIntegers": all(
                    isinstance(row["exactIntegerPriceCoins"], int) and row["exactIntegerPriceCoins"] > 0
                    for row in all_item_rows
                ),
                "allIntegerPricesComponentwiseMinimal": all(
                    row.get("minimalIntegerVerified", False) for row in exact_rows
                ),
                "allPiecewiseContinuousValuesFinitePositive": all(
                    math.isfinite(row["continuousPriceCoins"]) and row["continuousPriceCoins"] > 0
                    for row in continuous_rows_all
                ),
                "percentageLoanBranchActiveForAllRecipeEdges": all(
                    row["percentageLoanBranchActive"] for row in continuous_rows_all
                ),
                "maximumExactPriceCoins": max(prices.values()),
                "maximumExactPriceItemId": max(prices, key=prices.get),
            },
        },
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "first15": output["finalRulePoint"]["first15"],
        "blueprintTotalCents": blueprint_total,
        "blueprintBudgetSlackCents": output["finalRulePoint"]["blueprintBudgetSlackCents"],
        "sensitivities": blueprint_sensitivities,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
