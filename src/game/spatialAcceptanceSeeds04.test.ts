import { it } from "vitest";
import { verifyGreedyFoundationRange } from "./spatialAcceptanceTestHelpers";

it("lets asset-greedy cats reach item fifteen for seeds 76-100 after recipe purchases only", () => {
  verifyGreedyFoundationRange(76, 100);
}, 60_000);
