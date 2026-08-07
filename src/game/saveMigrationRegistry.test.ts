import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { migrateSaveSnapshot, serializeGameState } from "./persistence";
import { SAVE_MIGRATION_REGISTRY, saveMigrationPlanFor } from "./saveMigrationRegistry";
import { SAVE_SCHEMA_VERSION, SUPPORTED_SAVE_SCHEMA_VERSIONS } from "./saveSchema";

describe("save migration registry", () => {
  it("registers schema 1 through 17 once and in a continuous chain", () => {
    expect(SAVE_MIGRATION_REGISTRY.map((registration) => registration.version)).toEqual(
      SUPPORTED_SAVE_SCHEMA_VERSIONS,
    );
    for (const [index, registration] of SAVE_MIGRATION_REGISTRY.entries()) {
      expect(registration.nextVersion).toBe(
        index + 1 < SAVE_MIGRATION_REGISTRY.length
          ? SAVE_MIGRATION_REGISTRY[index + 1].version
          : null,
      );
    }
  });

  it.each(SUPPORTED_SAVE_SCHEMA_VERSIONS)("keeps the schema %i plan equivalent to the legacy predicates", (version) => {
    const plan = saveMigrationPlanFor(version);
    expect(plan.targetVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(plan.legacy).toBe(version === 1);
    expect(plan.needsResourceRegionMigration).toBe(version < 3);
    expect(plan.needsMarketMigration).toBe(version < 4);
    expect(plan.needsBuildingMarketMigration).toBe(version < 5);
    expect(plan.needsDifficultyMigration).toBe(version < 6);
    expect(plan.needsStarterLawMigration).toBe(version < 12);
    expect(plan.needsReliableMarketMigration).toBe(version < 14);
  });

  it.each(SUPPORTED_SAVE_SCHEMA_VERSIONS)("loads and re-saves a schema %i fixture without losing durable fields", (version) => {
    const raw = structuredClone(createInitialState({ worldSeed: 4_000 + version })) as any;
    raw.schemaVersion = version;
    raw.simTime = 30_000 + version;
    raw.paused = true;
    raw.simulationSpeed = 5_000;
    raw.speechFrequency = 42;
    raw.dirtyDecisions = true;
    raw.floatingEvents = [{
      id: `fixture-${version}`,
      catId: raw.cats[0].id,
      text: "fixture",
      createdAt: raw.simTime,
      duration: 1_000,
      kind: "gain",
    }];
    raw.cats[0].position = { x: 17, y: -5 };
    raw.cats[0].inventory[`legacy-item-${version}`] = version;
    raw.enactmentCount = version;
    raw.stargatesBuilt = version;
    raw.milestoneAt = version * 100;
    raw.legacyExtension = { version, nested: ["kept"] };

    const migrated = migrateSaveSnapshot(raw, 999);
    expect(migrated).toMatchObject({
      schemaVersion: SAVE_SCHEMA_VERSION,
      simTime: 30_000 + version,
      paused: false,
      simulationSpeed: 1,
      speechFrequency: 42,
      dirtyDecisions: false,
      floatingEvents: [],
      enactmentCount: version,
      stargatesBuilt: version,
      milestoneAt: version * 100,
    });
    expect(migrated.cats[0].position).toEqual({ x: 17, y: -5 });
    expect(migrated.cats[0].inventory[`legacy-item-${version}`]).toBe(version);
    expect((migrated as any).legacyExtension).toEqual({ version, nested: ["kept"] });

    const saved = serializeGameState(migrated) as any;
    expect(saved.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(saved.floatingEvents).toEqual([]);
    expect(saved.legacyExtension).toEqual({ version, nested: ["kept"] });

    const reloaded = migrateSaveSnapshot(saved);
    expect(reloaded.cats[0].inventory[`legacy-item-${version}`]).toBe(version);
    expect((reloaded as any).legacyExtension).toEqual({ version, nested: ["kept"] });
  });

  it.each([0, 18, "17", null])("keeps unsupported schema %p on the new-game fallback path", (schemaVersion) => {
    const raw = { schemaVersion, cats: [], legacyExtension: true };
    const fallback = migrateSaveSnapshot(raw, 7_777) as any;
    expect(fallback.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(fallback.worldSeed).toBe(7_777);
    expect(fallback.legacyExtension).toBeUndefined();
  });
});
