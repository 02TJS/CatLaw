export const SPEECH_BUBBLE_MAX_LINES = 3;

export interface SpeechLayoutRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpeechProtectedRectangle extends SpeechLayoutRectangle {
  /** Higher weights make the most valuable currently handled goods harder to cover. */
  weight: number;
}

interface SpeechBubblePlacementOptions {
  anchor: { x: number; y: number };
  bubbleWidth: number;
  bubbleHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  edge: number;
  anchorGap: number;
  seed: number;
  occupied: readonly SpeechLayoutRectangle[];
  protectedAreas: readonly SpeechProtectedRectangle[];
}

function overlapArea(left: SpeechLayoutRectangle, right: SpeechLayoutRectangle): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

/**
 * Keeps bubbles above their speaker while preferring clear views of the two
 * best item tiers currently being crafted or transported. The protected-area
 * penalty is deliberately softer than bubble-vs-bubble collision avoidance:
 * on a crowded or very small viewport the bubble must still remain readable.
 */
export function chooseSpeechBubblePlacement(options: SpeechBubblePlacementOptions): { x: number; y: number; tailSide: "top" | "bottom" } {
  const {
    anchor, bubbleWidth, bubbleHeight, viewportWidth, viewportHeight,
    edge, anchorGap, seed, occupied, protectedAreas,
  } = options;
  const clampX = (value: number) => Math.max(edge, Math.min(viewportWidth - bubbleWidth - edge, value));
  const clampY = (value: number) => Math.max(edge, Math.min(viewportHeight - bubbleHeight - edge, value));
  const preferredX = anchor.x - bubbleWidth / 2;
  const firstSide = seed % 2 === 0 ? -1 : 1;
  const horizontalSteps = [0, firstSide * .72, -firstSide * .72, firstSide * 1.44, -firstSide * 1.44];
  // Fixed offsets work well for speech-to-speech spacing, but a wide dock or
  // drawer can end between those offsets and leave a tiny overlap. Add exact
  // candidates immediately outside every hard UI obstacle so a zero-overlap
  // placement wins whenever the viewport has room for one.
  for (const rectangle of occupied) {
    horizontalSteps.push(
      (rectangle.x - bubbleWidth - preferredX) / bubbleWidth,
      (rectangle.x + rectangle.width - preferredX) / bubbleWidth,
    );
  }
  const verticalSides: readonly ("top" | "bottom")[] = seed % 3 === 0 ? ["top", "bottom"] : ["bottom", "top"];
  const initialSide = verticalSides[0];
  const initialY = initialSide === "bottom" ? anchor.y - anchorGap - bubbleHeight : anchor.y + anchorGap;
  let best = { x: clampX(preferredX), y: clampY(initialY), tailSide: initialSide, score: Number.POSITIVE_INFINITY, order: 0 };
  let order = 0;

  for (const tailSide of verticalSides) {
    for (let level = 0; level < 3; level += 1) {
      for (const horizontalStep of horizontalSteps) {
        const rawX = preferredX + horizontalStep * bubbleWidth;
        const rawY = tailSide === "bottom"
          ? anchor.y - anchorGap - bubbleHeight - level * (bubbleHeight + 6)
          : anchor.y + anchorGap + level * (bubbleHeight + 6);
        const x = clampX(rawX);
        const y = clampY(rawY);
        const candidate = { x, y, width: bubbleWidth, height: bubbleHeight };
        const occupiedPenalty = occupied.reduce((sum, rectangle) => sum + overlapArea(candidate, rectangle), 0) * 100_000;
        const protectedPenalty = protectedAreas.reduce(
          (sum, rectangle) => sum + overlapArea(candidate, rectangle) * Math.max(1, rectangle.weight) * 120,
          0,
        );
        const clampPenalty = (Math.abs(rawX - x) + Math.abs(rawY - y)) * 30;
        const distancePenalty = Math.abs(x - preferredX) + level * 18 + (tailSide === initialSide ? 0 : 6);
        const score = occupiedPenalty + protectedPenalty + clampPenalty + distancePenalty;
        if (score < best.score || (score === best.score && order < best.order)) best = { x, y, tailSide, score, order };
        order += 1;
      }
    }
  }
  return { x: best.x, y: best.y, tailSide: best.tailSide };
}

export function wrapSpeechText(
  text: string,
  maxWidth: number,
  measureWidth: (value: string) => number,
  maxLines = SPEECH_BUBBLE_MAX_LINES,
): string[] {
  const safeMaxLines = Math.max(1, Math.floor(maxLines));
  const lines: string[] = [""];
  let overflowed = false;
  for (const character of [...text]) {
    const index = lines.length - 1;
    const candidate = `${lines[index]}${character}`;
    if (measureWidth(candidate) <= maxWidth) {
      lines[index] = candidate;
    } else if (lines.length < safeMaxLines) {
      lines.push(character);
    } else {
      overflowed = true;
      break;
    }
  }
  if (overflowed) {
    const last = lines.length - 1;
    while (lines[last] && measureWidth(`${lines[last]}…`) > maxWidth) {
      lines[last] = [...lines[last]].slice(0, -1).join("");
    }
    lines[last] = `${lines[last]}…`;
  }
  return lines.filter(Boolean);
}
