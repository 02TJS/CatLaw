import { it } from "vitest";
import { verifyTeachingGoalRange } from "./spatialAcceptanceTestHelpers";

it("keeps the teaching goal through item fifteen for seeds 76-100 with player batch sales", () => {
  verifyTeachingGoalRange(76, 100);
}, 30_000);
