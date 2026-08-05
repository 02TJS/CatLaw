import { describe, expect, it } from "vitest";
import { buildLawSystemPrompt, compileLaw } from "./lawCompiler.js";
import { SHARED_BEHAVIOR_HASH, SHARED_BEHAVIOR_SOURCE } from "../src/game/lawProgram.js";

describe("unified immutable law compiler", () => {
  it("provides the full observation contract and forbids replacing shared behavior", () => {
    const prompt = buildLawSystemPrompt([], { sourceCode: "sharedBehavior/v1", astHash: "shared-hash" });
    expect(prompt).toContain("只读观察");
    expect(prompt).not.toContain("warehouse:Readonly<Record<ItemId,number>>");
    expect(prompt).toContain("warehouseCount");
    expect(prompt).toContain("订单/悬赏/建筑报价");
    expect(prompt).toContain("正在承运的合同");
    expect(prompt).toContain("不得重写、复制或声称修改共享循环");
    expect(prompt).toContain("总AST不超过4096节点");
    expect(prompt).toContain("AST深度不超过64层");
    expect(prompt).toContain("shared-hash");
    expect(prompt).toContain('"sourceCodeLines"');
    expect(prompt).not.toContain("category");
  });

  it("never mutates the shared behavior across independent compilations", async () => {
    const beforeSource = SHARED_BEHAVIOR_SOURCE;
    const beforeHash = SHARED_BEHAVIOR_HASH;
    const input = {
      existingLaws: [],
      sharedBehavior: { sourceCode: beforeSource, astHash: beforeHash },
    };
    const first = await compileLaw({ ...input, text: "把全部商品价格设为2倍，不改变动作" });
    const second = await compileLaw({ ...input, text: "有订单时提高制作评分并请求choose" });
    expect(first.compileAudit).toBeUndefined();
    expect(second.program).toEqual({ version: 2 });
    expect(SHARED_BEHAVIOR_SOURCE).toBe(beforeSource);
    expect(SHARED_BEHAVIOR_HASH).toBe(beforeHash);
  });

  it("compiles a transfer instruction into one decision program", async () => {
    const draft = await compileLaw({ text: "如果有木材而且东边有猫，就把木材向东传，否则按局部收益行动", existingLaws: [] });
    expect(draft.program).toEqual({ version: 2 });
    expect(draft.sourceCode).toContain("neighborExists('east')");
    expect(draft.sourceCode).toContain("choose()");
    expect(draft.validation).toMatchObject({ syntax: true, safety: true });
  });

  it("keeps price laws and rejects removed tax effects", async () => {
    const price = await compileLaw({ text: "把齿轮价格提高50%", existingLaws: [] });
    const tax = await compileLaw({ text: "征收80%销售税进入国库", existingLaws: [] });
    expect(price.sourceCode).toContain('setPrice("gear", 1.5)');
    expect(tax.sourceCode).not.toContain("setTax");
    expect(tax.warnings.join(" ")).toContain("税收系统已移除");
    expect(price.sourceCode).toContain("return null");
  });

  it("compiles an additive price request as cents instead of a multiplier", async () => {
    const draft = await compileLaw({ text: "燃料的价格+3", existingLaws: [] });
    expect(draft.sourceCode).not.toMatch(/setPrice\s*\(/u);
    expect(draft.sourceCode).toContain('addPrice("fuel", 300)');
    expect(draft.sourceCode).toContain("return null");
    expect(draft.warnings.join(" ")).toContain("价格加法");
    expect(draft.explanation).toContain("而不是乘以3");
  });

  it("expands same-era exclusions from catalog tiers, not coordinates", async () => {
    const draft = await compileLaw({ text: "燃料同一时代的除了燃料都*1.2价格", existingLaws: [] });
    expect(draft.sourceCode).toContain("setPrice('lamp', 1.2)");
    expect(draft.sourceCode).toContain("setPrice('machine_tool', 1.2)");
    expect(draft.sourceCode).not.toContain("setPrice('fuel'");
    expect(draft.sourceCode).not.toContain("ctx.position");
    const executableLines = draft.sourceCode.split("\n").filter((line) => !line.trimStart().startsWith("//"));
    expect(executableLines.filter((line) => /setPrice\(/u.test(line))).toHaveLength(6);
    expect(draft.validation.safety).toBe(true);
  });

  it("compiles scoring without replacing existing laws", async () => {
    const draft = await compileLaw({ text: "把传递木材的评分提高3倍，其余候选继续局部贪心", existingLaws: [] });
    expect(draft.sourceCode).toContain("adjust('pass', 'wood', 3, 0)");
    expect(draft.sourceCode).toContain("return choose()");
    expect(draft.program).toEqual({ version: 2 });
  });

  it("compiles a warehouse threshold draft as a normal unified decision law", async () => {
    const draft = await compileLaw({ text: "当玩家仓库木板低于5件时，优先生产木板", existingLaws: [] });
    expect(draft.title).toContain("木板");
    expect(draft.sourceCode).toContain("warehouseCount('plank') < 5");
    expect(draft.sourceCode).toContain("adjust('craft', 'plank'");
    expect(draft.sourceCode).toContain("return choose()");
    expect(draft.program).toEqual({ version: 2 });
    expect(draft.validation).toMatchObject({ syntax: true, safety: true });
  });

  it("recognizes explicit minimum-inventory wording after a warehouse purchase", async () => {
    const draft = await compileLaw({ text: "wood 最低库存至少保持 5 件", existingLaws: [] });
    expect(draft.sourceCode).toContain("warehouseCount('wood') < 5");
    expect(draft.sourceCode).toContain("adjust('craft', 'wood'");
    expect(draft.program).toEqual({ version: 2 });
    expect(draft.validation).toMatchObject({ syntax: true, safety: true });
  });
});
