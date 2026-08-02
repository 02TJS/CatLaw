import { it } from "vitest";
import { verifyTeachingGoalRange } from "./spatialAcceptanceTestHelpers";

it("keeps the teaching goal through item fifteen for seeds 26-50 with player batch sales", () => {
  verifyTeachingGoalRange(26, 50);
}, 30_000);
