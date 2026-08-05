import { it } from "vitest";
import { verifyGreedyFoundationRange } from "./spatialAcceptanceTestHelpers";

it("lets asset-greedy cats reach item fifteen for seeds 1-25 after recipe purchases only", () => {
  verifyGreedyFoundationRange(1, 25);
}, 60_000);
