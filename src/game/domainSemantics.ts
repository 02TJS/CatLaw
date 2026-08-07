import type {
  CatState,
  GameState,
  PlayerWarehouseInventory,
} from "./types";
import type { Cents } from "./domainUnits";

/** The legacy serialized key is retained verbatim for schema compatibility. */
export const PLAYER_WAREHOUSE_SAVE_FIELD = "playerBuildingInventory" as const;

/** Canonical domain name for the mixed player warehouse map. Returns the original map. */
export function playerWarehouseInventory(
  state: Pick<GameState, typeof PLAYER_WAREHOUSE_SAVE_FIELD>,
): PlayerWarehouseInventory {
  return state[PLAYER_WAREHOUSE_SAVE_FIELD];
}

/** Canonical read name for the schema-4 `coins` compatibility field. */
export function catCashCents(cat: Pick<CatState, "coins">): Cents {
  return cat.coins;
}

/** Canonical read name for the `treasuryCoins` compatibility field. */
export function treasuryCashCents(state: Pick<GameState, "treasuryCoins">): Cents {
  return state.treasuryCoins;
}
