import { useEffect } from "react";
import { ITEMS } from "../game/catalog";
import type { GameController } from "../game/controller";
import {
  RECIPE_BRIDGE_CHANNEL_NAME,
  type RecipeBridgeMessage,
  type RecipeInterfaceState,
} from "../recipeBridge";

export function buildRecipeInterfaceState(state: GameController["state"]): RecipeInterfaceState {
  return {
    unlockedRecipes: [...state.unlockedRecipes],
    craftedItems: ITEMS.filter((item) => state.itemStats[item.id].crafted > 0).map((item) => item.id),
    treasuryCoins: state.treasuryCoins,
    difficulty: state.difficulty,
  };
}

export function useRecipeBridge(controller: GameController): void {
  useEffect(() => {
    const channel = new BroadcastChannel(RECIPE_BRIDGE_CHANNEL_NAME);
    const sendState = () => channel.postMessage({
      type: "recipe-state",
      state: buildRecipeInterfaceState(controller.state),
    } satisfies RecipeBridgeMessage);
    channel.onmessage = (event: MessageEvent<RecipeBridgeMessage>) => {
      if (event.data?.type === "recipe-state-request") sendState();
      if (event.data?.type === "recipe-unlock" && typeof event.data.recipeId === "string") {
        const result = controller.unlockRecipe(event.data.recipeId);
        channel.postMessage({ type: "recipe-unlock-result", recipeId: event.data.recipeId, ...result } satisfies RecipeBridgeMessage);
        sendState();
      }
    };
    const timer = window.setInterval(sendState, 1_000);
    sendState();
    return () => {
      window.clearInterval(timer);
      channel.close();
    };
  }, []);
}
