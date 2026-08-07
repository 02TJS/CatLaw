import {
  SAVE_SCHEMA_VERSION,
  type SupportedSaveSchemaVersion,
} from "./saveSchema";

/**
 * Compatibility gates introduced while advancing from one stored schema to
 * the next. The migration body still applies these gates in its historical
 * execution order; this registry only replaces scattered numeric predicates.
 */
export type SaveMigrationGate =
  | "legacy-world"
  | "resource-regions"
  | "integer-cent-market"
  | "building-market"
  | "difficulty"
  | "starter-laws"
  | "reliable-market";

export interface SaveSchemaRegistration {
  version: SupportedSaveSchemaVersion;
  nextVersion: SupportedSaveSchemaVersion | null;
  gates: readonly SaveMigrationGate[];
}

/** Every supported schema is explicit, including no-op transitions. */
export const SAVE_MIGRATION_REGISTRY = [
  { version: 1, nextVersion: 2, gates: ["legacy-world"] },
  { version: 2, nextVersion: 3, gates: ["resource-regions"] },
  { version: 3, nextVersion: 4, gates: ["integer-cent-market"] },
  { version: 4, nextVersion: 5, gates: ["building-market"] },
  { version: 5, nextVersion: 6, gates: ["difficulty"] },
  { version: 6, nextVersion: 7, gates: [] },
  { version: 7, nextVersion: 8, gates: [] },
  { version: 8, nextVersion: 9, gates: [] },
  { version: 9, nextVersion: 10, gates: [] },
  { version: 10, nextVersion: 11, gates: [] },
  { version: 11, nextVersion: 12, gates: ["starter-laws"] },
  { version: 12, nextVersion: 13, gates: [] },
  { version: 13, nextVersion: 14, gates: ["reliable-market"] },
  { version: 14, nextVersion: 15, gates: [] },
  { version: 15, nextVersion: 16, gates: [] },
  { version: 16, nextVersion: 17, gates: [] },
  { version: 17, nextVersion: null, gates: [] },
] as const satisfies readonly SaveSchemaRegistration[];

export interface SaveMigrationPlan {
  sourceVersion: SupportedSaveSchemaVersion;
  targetVersion: typeof SAVE_SCHEMA_VERSION;
  steps: readonly SaveSchemaRegistration[];
  legacy: boolean;
  needsResourceRegionMigration: boolean;
  needsMarketMigration: boolean;
  needsBuildingMarketMigration: boolean;
  needsDifficultyMigration: boolean;
  needsStarterLawMigration: boolean;
  needsReliableMarketMigration: boolean;
}

export function saveMigrationPlanFor(sourceVersion: SupportedSaveSchemaVersion): SaveMigrationPlan {
  const steps = SAVE_MIGRATION_REGISTRY.filter((registration) => (
    registration.version >= sourceVersion && registration.nextVersion !== null
  ));
  const gates = new Set<SaveMigrationGate>(steps.flatMap((registration) => registration.gates));
  return {
    sourceVersion,
    targetVersion: SAVE_SCHEMA_VERSION,
    steps,
    legacy: gates.has("legacy-world"),
    needsResourceRegionMigration: gates.has("resource-regions"),
    needsMarketMigration: gates.has("integer-cent-market"),
    needsBuildingMarketMigration: gates.has("building-market"),
    needsDifficultyMigration: gates.has("difficulty"),
    needsStarterLawMigration: gates.has("starter-laws"),
    needsReliableMarketMigration: gates.has("reliable-market"),
  };
}
