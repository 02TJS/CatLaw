import { describe, expect, it } from "vitest";
import { compileLaw } from "./lawCompiler.js";

describe("shared logic law compiler", () => {
  it("compiles a local transfer instruction into a safe shared behavior function", async () => {
    const draft = await compileLaw({
      text: "如果有木材而且东边有猫，就把木材向东传，否则按局部收益行动",
      existingLaws: [],
    });
    expect(draft.category).toBe("behavior");
    expect(draft.sourceCode).toContain("neighborExists(\"east\")");
    expect(draft.sourceCode).toContain("earnCoins()");
    expect(draft.validation).toMatchObject({ syntax: true, safety: true });
  });

  it("keeps price and tax laws as passive economic modifiers", async () => {
    const price = await compileLaw({ text: "把齿轮价格提高50%", existingLaws: [] });
    const tax = await compileLaw({ text: "征收80%销售税进入国库", existingLaws: [] });
    expect(price).toMatchObject({ category: "price", priceItemId: "gear", priceMultiplier: 1.5 });
    expect(tax).toMatchObject({ category: "tax", taxRate: 0.8 });
    expect(price.sourceCode).toBe("function decide(ctx) { return null; }");
    expect(tax.sourceCode).toBe("function decide(ctx) { return null; }");
  });

  it("can compile an instruction that changes scoring instead of forcing an if/else action", async () => {
    const draft = await compileLaw({
      text: "把传递木材的评分提高3倍，其余候选继续局部贪心",
      existingLaws: [],
    });
    expect(draft.category).toBe("behavior");
    expect(draft.sourceCode).toContain('adjust("pass", "wood", 3, 0)');
    expect(draft.sourceCode).toContain("return choose()");
    expect(draft.validation).toMatchObject({ syntax: true, safety: true });
  });
});
