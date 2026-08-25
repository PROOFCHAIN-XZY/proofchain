import { describe, expect, it } from "vitest";
import {
  activeMaterials,
  examplesLine,
  formatExamples,
  MATERIAL_EXAMPLE_MAX_LENGTH,
  MATERIAL_EXAMPLES_MAX,
  normaliseExamples,
  parseExamples,
  isMaterialCode,
  MATERIAL_CODE_MAX_LENGTH,
  MATERIAL_TYPES,
  materialLabel,
  SEED_MATERIALS,
  sortMaterials,
  type Material,
} from "../src/materials.js";

/**
 * The catalogue's job is to keep one distinction sharp: a code is signed and
 * permanent, a name is presentation and free. Most of what follows guards the
 * first half, because getting it wrong invalidates anchored batches rather than
 * merely looking wrong on screen.
 */

function material(overrides: Partial<Material> = {}): Material {
  return {
    code: "PET",
    name: "PET",
    description: null,
    examples: [],
    active: true,
    sortOrder: 10,
    ...overrides,
  };
}

describe("isMaterialCode", () => {
  it("accepts the codes the pilot already anchored", () => {
    for (const code of MATERIAL_TYPES) {
      expect(isMaterialCode(code), code).toBe(true);
    }
  });

  it("accepts internal separators and digits", () => {
    expect(isMaterialCode("PET-G")).toBe(true);
    expect(isMaterialCode("PVC_RIGID")).toBe(true);
    expect(isMaterialCode("P2")).toBe(true);
  });

  it.each([
    ["lowercase", "pet"],
    ["mixed case", "Pet"],
    ["a space", "MIXED PLASTIC"],
    ["a single character", "P"],
    ["empty", ""],
    ["a leading separator", "-PET"],
    ["a dot, which a Stellar data key should not carry", "PET.1"],
    ["a slash", "PET/HDPE"],
    ["a quote", "PET'"],
    ["seventeen characters", "A".repeat(17)],
  ])("rejects %s", (_why, code) => {
    expect(isMaterialCode(code)).toBe(false);
  });

  it("accepts exactly the documented maximum length", () => {
    expect(isMaterialCode("A".repeat(MATERIAL_CODE_MAX_LENGTH))).toBe(true);
  });

  /**
   * A display name reaching the code field would be permanent. The pattern is
   * the last thing standing between an operator typing in the wrong box and a
   * ledger entry keyed on "Clear bottle plastic".
   */
  it("rejects a plausible display name typed into the code field", () => {
    expect(isMaterialCode("Clear bottle plastic")).toBe(false);
  });
});

describe("SEED_MATERIALS", () => {
  it("is non-empty, which the capture pickers rely on as their floor", () => {
    expect(SEED_MATERIALS.length).toBeGreaterThan(0);
    expect(activeMaterials(SEED_MATERIALS).length).toBeGreaterThan(0);
  });

  it("uses only codes that pass validation", () => {
    for (const m of SEED_MATERIALS) {
      expect(isMaterialCode(m.code), m.code).toBe(true);
    }
  });

  it("has no duplicate codes, since code is the primary key", () => {
    const codes = SEED_MATERIALS.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives every entry a name and a description", () => {
    for (const m of SEED_MATERIALS) {
      expect(m.name.length, m.code).toBeGreaterThan(0);
      expect(m.description, m.code).toBeTruthy();
    }
  });

  /**
   * The seed list is what a phone that has never reached a backend shows, so an
   * entry with no products there means a collector in exactly the worst position
   * — offline, first shift — gets a bare code and nothing to match a sack
   * against.
   */
  it("gives every entry products a collector can match a sack against", () => {
    for (const m of SEED_MATERIALS) {
      expect(m.examples.length, m.code).toBeGreaterThan(0);
      expect(normaliseExamples(m.examples), m.code).toEqual(m.examples);
    }
  });

  /**
   * These six strings are in anchored Merkle roots. Renaming one is not a
   * refactor — it invalidates the audit report of every batch containing it. The
   * assertion is deliberately literal so that changing a code has to change this
   * test, and changing this test has to be argued for.
   */
  it("still contains exactly the codes anchored under the closed union", () => {
    expect([...MATERIAL_TYPES]).toEqual(["PET", "HDPE", "LDPE", "PP", "PS", "MIXED"]);
  });
});

describe("sortMaterials", () => {
  it("puts active entries before retired ones", () => {
    const sorted = sortMaterials([
      material({ code: "OLD", active: false, sortOrder: 1 }),
      material({ code: "NEW", active: true, sortOrder: 900 }),
    ]);
    expect(sorted.map((m) => m.code)).toEqual(["NEW", "OLD"]);
  });

  it("orders by sortOrder within a group", () => {
    const sorted = sortMaterials([
      material({ code: "C", sortOrder: 30 }),
      material({ code: "A", sortOrder: 10 }),
      material({ code: "B", sortOrder: 20 }),
    ]);
    expect(sorted.map((m) => m.code)).toEqual(["A", "B", "C"]);
  });

  it("falls back to code so the order is total and stable", () => {
    const sorted = sortMaterials([
      material({ code: "ZZ", sortOrder: 10 }),
      material({ code: "AA", sortOrder: 10 }),
    ]);
    expect(sorted.map((m) => m.code)).toEqual(["AA", "ZZ"]);
  });

  it("does not mutate its input", () => {
    const input = [material({ code: "B", sortOrder: 20 }), material({ code: "A", sortOrder: 10 })];
    sortMaterials(input);
    expect(input.map((m) => m.code)).toEqual(["B", "A"]);
  });
});

describe("activeMaterials", () => {
  it("drops retired entries", () => {
    const result = activeMaterials([
      material({ code: "PET" }),
      material({ code: "PS", active: false }),
    ]);
    expect(result.map((m) => m.code)).toEqual(["PET"]);
  });
});

describe("materialLabel", () => {
  const catalogue = [
    material({ code: "PET", name: "PET" }),
    material({ code: "MIXED", name: "Mixed plastic" }),
  ];

  it("pairs code and name when they differ", () => {
    expect(materialLabel("MIXED", catalogue)).toBe("MIXED · Mixed plastic");
  });

  it("does not repeat itself when the name IS the code", () => {
    expect(materialLabel("PET", catalogue)).toBe("PET");
  });

  /**
   * A retired material dropped from a cached catalogue must still render as what
   * was signed. "Unknown" would misreport a record whose ledger entry says PS.
   */
  it("falls back to the bare code for a material it has never heard of", () => {
    expect(materialLabel("PS", catalogue)).toBe("PS");
  });
});

describe("normaliseExamples", () => {
  it("trims, collapses whitespace and drops blanks", () => {
    expect(normaliseExamples(["  Milk jugs ", "", "   ", "Crates\n"])).toEqual([
      "Milk jugs",
      "Crates",
    ]);
  });

  /** "Bottle caps" and "bottle caps" are one product to whoever reads the picker. */
  it("removes case-insensitive duplicates, keeping the first spelling", () => {
    expect(normaliseExamples(["Bottle caps", "bottle caps", "BOTTLE CAPS"])).toEqual([
      "Bottle caps",
    ]);
  });

  it("truncates an over-long entry rather than dropping it", () => {
    const [only] = normaliseExamples(["x".repeat(MATERIAL_EXAMPLE_MAX_LENGTH + 20)]);
    expect(only).toHaveLength(MATERIAL_EXAMPLE_MAX_LENGTH);
  });

  it("caps the count so a picker cannot be flooded", () => {
    const many = Array.from({ length: MATERIAL_EXAMPLES_MAX + 5 }, (_, i) => `product ${i}`);
    expect(normaliseExamples(many)).toHaveLength(MATERIAL_EXAMPLES_MAX);
  });

  /**
   * The offline path. A cache written before this field existed, a backend that
   * predates it, and a driver that spells an empty array its own way all arrive
   * here — and all must degrade to "no products", never to a crash in the one
   * screen a collector cannot work around.
   */
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "{}"],
    ["a number", 3],
    ["an object", { 0: "Milk jugs" }],
  ])("returns an empty array for %s", (_why, value) => {
    expect(normaliseExamples(value)).toEqual([]);
  });

  it("ignores non-string entries inside an otherwise usable array", () => {
    expect(normaliseExamples(["Milk jugs", null, 7, { name: "Crates" }])).toEqual(["Milk jugs"]);
  });
});

describe("parseExamples", () => {
  it("accepts a comma-separated line", () => {
    expect(parseExamples("Milk jugs, Detergent bottles")).toEqual([
      "Milk jugs",
      "Detergent bottles",
    ]);
  });

  it("accepts one product per line, since both spellings are natural to type", () => {
    expect(parseExamples("Milk jugs\nDetergent bottles\n")).toEqual([
      "Milk jugs",
      "Detergent bottles",
    ]);
  });

  it("round-trips through formatExamples", () => {
    const examples = ["Milk jugs", "Detergent bottles", "Crates"];
    expect(parseExamples(formatExamples(examples))).toEqual(examples);
  });

  it("treats an empty box as no products rather than one blank product", () => {
    expect(parseExamples("   ")).toEqual([]);
  });
});

describe("examplesLine", () => {
  it("joins with a separator that survives a glance", () => {
    expect(examplesLine(["Milk jugs", "Crates"])).toBe("Milk jugs · Crates");
  });

  /**
   * Counted, not truncated silently: a collector should be able to tell the list
   * continues rather than believe they have seen all of it.
   */
  it("counts the overflow past the limit", () => {
    expect(examplesLine(["a", "b", "c", "d", "e", "f"], 4)).toBe("a · b · c · d +2 more");
  });

  it("is empty for no examples, so a caller can hide the element", () => {
    expect(examplesLine([])).toBe("");
  });
});
