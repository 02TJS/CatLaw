import { it } from "vitest";
import { verifyTeachingGoalRange } from "./spatialAcceptanceTestHelpers";

it("keeps the teaching goal through item fifteen for seeds 1-25 with player batch sales", () => {
  verifyTeachingGoalRange(1, 25);
}, 30_000);
