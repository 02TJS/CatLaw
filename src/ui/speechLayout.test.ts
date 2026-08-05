import { describe, expect, it } from "vitest";
import { chooseSpeechBubblePlacement, SPEECH_BUBBLE_MAX_LINES, wrapSpeechText } from "./speechLayout";

const monospaceWidth = (value: string) => [...value].length;

describe("speech bubble wrapping", () => {
  it("allows decision speech to occupy three complete lines", () => {
    expect(SPEECH_BUBBLE_MAX_LINES).toBe(3);
    expect(wrapSpeechText("abcdefghijkl", 4, monospaceWidth)).toEqual(["abcd", "efgh", "ijkl"]);
  });

  it("ellipsizes only after the third line is full", () => {
    expect(wrapSpeechText("abcdefghijklm", 4, monospaceWidth)).toEqual(["abcd", "efgh", "ijk…"]);
  });

  it("keeps short speech compact", () => {
    expect(wrapSpeechText("喵", 4, monospaceWidth)).toEqual(["喵"]);
  });

  it("moves away from a protected high-tier workstation when a clear candidate exists", () => {
    const placement = chooseSpeechBubblePlacement({
      anchor: { x: 400, y: 500 },
      bubbleWidth: 200,
      bubbleHeight: 60,
      viewportWidth: 800,
      viewportHeight: 600,
      edge: 8,
      anchorGap: 35,
      seed: 3,
      occupied: [],
      protectedAreas: [{ x: 285, y: 390, width: 230, height: 100, weight: 3 }],
    });
    expect(placement.x + 200 <= 285 || placement.x >= 515 || placement.y + 60 <= 390).toBe(true);
  });

  it("keeps the compact centered position when no important workstation is obscured", () => {
    expect(chooseSpeechBubblePlacement({
      anchor: { x: 400, y: 500 },
      bubbleWidth: 200,
      bubbleHeight: 60,
      viewportWidth: 800,
      viewportHeight: 600,
      edge: 8,
      anchorGap: 35,
      seed: 1,
      occupied: [],
      protectedAreas: [],
    })).toEqual({ x: 300, y: 405, tailSide: "bottom" });
  });

  it("uses a below-cat bubble with an upward tail for a deterministic share of clear layouts", () => {
    expect(chooseSpeechBubblePlacement({
      anchor: { x: 400, y: 300 },
      bubbleWidth: 200,
      bubbleHeight: 60,
      viewportWidth: 800,
      viewportHeight: 600,
      edge: 8,
      anchorGap: 35,
      seed: 3,
      occupied: [],
      protectedAreas: [],
    })).toEqual({ x: 300, y: 335, tailSide: "top" });
  });

  it("moves a low cat's bubble completely above the bottom control dock", () => {
    const placement = chooseSpeechBubblePlacement({
      anchor: { x: 400, y: 560 },
      bubbleWidth: 200,
      bubbleHeight: 60,
      viewportWidth: 800,
      viewportHeight: 600,
      edge: 8,
      anchorGap: 35,
      seed: 1,
      occupied: [{ x: 0, y: 510, width: 800, height: 90 }],
      protectedAreas: [],
    });
    expect(placement.y + 60).toBeLessThanOrEqual(510);
  });

  it("keeps speech clear of a top title control", () => {
    const placement = chooseSpeechBubblePlacement({
      anchor: { x: 120, y: 92 },
      bubbleWidth: 200,
      bubbleHeight: 60,
      viewportWidth: 800,
      viewportHeight: 600,
      edge: 8,
      anchorGap: 35,
      seed: 1,
      occupied: [{ x: 8, y: 8, width: 250, height: 48 }],
      protectedAreas: [],
    });
    expect(placement.x >= 258 || placement.y >= 56).toBe(true);
  });

  it("moves a bubble away from an open management drawer", () => {
    const placement = chooseSpeechBubblePlacement({
      anchor: { x: 690, y: 330 },
      bubbleWidth: 200,
      bubbleHeight: 60,
      viewportWidth: 800,
      viewportHeight: 600,
      edge: 8,
      anchorGap: 35,
      seed: 2,
      occupied: [{ x: 500, y: 20, width: 300, height: 500 }],
      protectedAreas: [],
    });
    expect(placement.x + 200 <= 500 || placement.y >= 520).toBe(true);
  });
});
