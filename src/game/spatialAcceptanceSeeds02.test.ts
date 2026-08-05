import { it } from "vitest";
import { verifyGreedyFoundationRange } from "./spatialAcceptanceTestHelpers";

it("lets asset-greedy cats reach item fifteen for seeds 26-50 after recipe purchases only", () => {
  verifyGreedyFoundationRange(26, 50);
}, 60_000);
