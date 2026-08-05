import { describe, expect, it } from "vitest";
import { buildingQualityPalette, itemQualityLevel, itemQualityPalette, qualityPaletteAtLevel, workstationQualityVisual } from "./itemQuality";

describe("item quality palettes", () => {
  it("maps the catalog from pearl through graphite and reserves prism for the stargate", () => {
    expect(itemQualityPalette("wood").id).toBe("pearl");
    expect(itemQualityPalette("fire").id).toBe("sage");
    expect(itemQualityPalette("metal").id).toBe("azure");
    expect(itemQualityPalette("lamp").id).toBe("lilac");
    expect(itemQualityPalette("chip").id).toBe("champagne");
    expect(itemQualityPalette("computer").id).toBe("rose");
    expect(itemQualityPalette("rocket").id).toBe("graphite");
    expect(itemQualityPalette("quantum_field").id).toBe("graphite");
    expect(itemQualityPalette("gate_ring").id).toBe("graphite");
    expect(itemQualityPalette("stargate").id).toBe("prism");
  });

  it("uses layered pale tones instead of pure primary colors", () => {
    for (const itemId of ["wood", "fire", "metal", "lamp", "chip", "computer", "rocket", "stargate"]) {
      const palette = itemQualityPalette(itemId);
      expect(new Set(palette.topStops).size).toBe(3);
      expect(palette.topStops).not.toContain("#ffffff");
      expect(palette.topStops).not.toContain("#000000");
      expect(palette.topStops).not.toContain("#ff0000");
    }
  });

  it("grades world buildings independently from pearl resources through higher facilities", () => {
    expect(qualityPaletteAtLevel(0).id).toBe("pearl");
    expect(buildingQualityPalette("factory").id).toBe("sage");
    expect(buildingQualityPalette("machine_tool").id).toBe("azure");
    expect(buildingQualityPalette("antenna").id).toBe("lilac");
    expect(buildingQualityPalette("lab").id).toBe("champagne");
    expect(buildingQualityPalette("reactor").id).toBe("rose");
  });

  it("exposes stable quality thresholds for workstation borders", () => {
    expect(itemQualityLevel("wood")).toBe(0);
    expect(itemQualityLevel("fire")).toBe(1);
    expect(itemQualityLevel("metal")).toBe(2);
    expect(itemQualityLevel("stargate")).toBeGreaterThan(2);
  });

  it("makes green rims heavier while keeping blue lifts modest and gold higher", () => {
    const common = workstationQualityVisual("wood");
    const green = workstationQualityVisual("fire");
    const blue = workstationQualityVisual("metal");
    const purple = workstationQualityVisual("lamp");

    expect(green.borderWidth).toBeGreaterThan(common.borderWidth * 2);
    expect(green.liftTileFraction).toBe(0);
    expect(blue.borderWidth).toBeGreaterThan(green.borderWidth);
    expect(blue.glowWidth).toBeGreaterThan(blue.borderWidth);
    expect(blue.glowBlur).toBeGreaterThan(20);
    expect(blue.liftTileFraction).toBeCloseTo(1 / 9);
    expect(purple.liftTileFraction).toBeCloseTo(1 / 9);
    expect(workstationQualityVisual("chip").liftTileFraction).toBeCloseTo(2 / 9);
    expect(workstationQualityVisual("chip").fullHighlight).toBe(false);
    expect(workstationQualityVisual("computer").fullHighlight).toBe(true);
  });
});
