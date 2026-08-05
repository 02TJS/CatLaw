import { it } from "vitest";
import { verifyGreedyFoundationRange } from "./spatialAcceptanceTestHelpers";

it("lets asset-greedy cats reach item fifteen for seeds 51-75 after recipe purchases only", () => {
  verifyGreedyFoundationRange(51, 75);
}, 60_000);
