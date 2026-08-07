import type { LandmarkId } from "../game/types";

export interface PlacementFeedback {
  itemId: string;
  position: { x: number; y: number };
  ok: boolean;
  error?: string;
}

export interface LandmarkPlacementFeedback {
  landmarkId: LandmarkId;
  position: { x: number; y: number };
  ok: boolean;
  error?: string;
}

export interface CommerceItemDelta {
  itemId: string;
  quantity: number;
}

export interface CommerceFeedback {
  id: number;
  ok: boolean;
  text: string;
  itemDeltas?: CommerceItemDelta[];
  treasuryDeltaCents?: number;
}
