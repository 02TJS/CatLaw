import { it } from "vitest";
import { verifyTeachingGoalRange } from "./spatialAcceptanceTestHelpers";

it("keeps the teaching goal through item fifteen for seeds 51-75 with player batch sales", () => {
  verifyTeachingGoalRange(51, 75);
}, 30_000);
