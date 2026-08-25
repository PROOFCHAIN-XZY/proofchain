import { describe, expect, it } from "vitest";
import {
  describeFailures,
  describeFinding,
  formatKg,
  technicalSummary,
  weightProblem,
} from "../src/integrity-copy.js";
import { INTEGRITY_CHECKS } from "../src/types.js";

/**
 * These strings are read by a collector standing at a scale, and what they say
 * decides whether a weigh-in gets re-done or silently becomes unpaid work. The
 * tests are therefore about the contract of the copy — every check covered, no
 * internal identifiers, an unknown check still says something — rather than
 * about exact wording, which is expected to change.
 */

describe("describeFinding", () => {
  it("has collector-facing copy for every check the server can report", () => {
    for (const check of INTEGRITY_CHECKS) {
      const message = describeFinding({ check });

      expect(message.length, check).toBeGreaterThan(0);
      // The check name is the thing being translated away; leaking it back into
      // the copy would defeat the exercise.
      expect(message, check).not.toContain(check);
      expect(message, check).not.toContain("_");
    }
  });

  it("falls back to the server's detail for a check this build has never heard of", () => {
    // A field phone can run for weeks against a backend that has been updated
    // under it. An unrecognised check is an expected state, not a bug.
    const message = describeFinding({ check: "photo_plausible", detail: "photo is not a scale" });

    expect(message).toContain("photo is not a scale");
  });

  it("still says something when an unknown check carries no detail", () => {
    expect(describeFinding({ check: "future_check_v9" })).toMatch(/refused/i);
  });
});

describe("describeFailures", () => {
  it("reports only the checks that failed", () => {
    const summary = describeFailures([
      { check: "weight_in_range", outcome: "fail", detail: "300 kg above hub maximum 200 kg" },
      { check: "signature_valid", outcome: "pass" },
    ]);

    expect(summary).toBe(describeFinding({ check: "weight_in_range" }));
  });

  it("does not say the same sentence twice when a check is reported twice", () => {
    const summary = describeFailures([
      { check: "weight_in_range", outcome: "fail", detail: "too heavy" },
      { check: "weight_in_range", outcome: "fail", detail: "also too heavy" },
    ]);

    expect(summary).toBe(describeFinding({ check: "weight_in_range" }));
  });

  it("is empty when nothing failed, so a passing sync shows no error at all", () => {
    expect(describeFailures([{ check: "photo_present", outcome: "pass" }])).toBe("");
  });
});

describe("technicalSummary", () => {
  it("keeps check names and details for the operator-facing surfaces", () => {
    expect(
      technicalSummary([
        { check: "weight_in_range", outcome: "fail", detail: "300 kg above hub maximum 200 kg" },
        { check: "photo_present", outcome: "fail" },
      ]),
    ).toBe("weight_in_range: 300 kg above hub maximum 200 kg; photo_present");
  });
});

describe("weightProblem", () => {
  const bounds = { minKg: 0.5, maxKg: 10_000 };

  it("accepts a weight inside the hub's range", () => {
    expect(weightProblem(300, bounds)).toBeNull();
    expect(weightProblem(0.5, bounds)).toBeNull();
    expect(weightProblem(10_000, bounds)).toBeNull();
  });

  it("names the ceiling, in kg, when the weight is over it", () => {
    const problem = weightProblem(10_001, bounds);

    expect(problem).toContain("10,000 kg");
    expect(problem).toMatch(/too heavy/i);
  });

  it("names the floor when the weight is under it", () => {
    expect(weightProblem(0.2, bounds)).toContain("0.5 kg");
  });

  it("judges nothing when the device does not know the bounds", () => {
    // A phone provisioned before the hub directory published bounds must keep
    // capturing: a missing piece of configuration cannot be allowed to cost a
    // collector a weigh-in. The server still enforces the real limits.
    expect(weightProblem(50_000, { minKg: null, maxKg: null })).toBeNull();
  });

  it("checks the bound it has when only one is known", () => {
    expect(weightProblem(50_000, { minKg: null, maxKg: 10_000 })).toMatch(/too heavy/i);
    expect(weightProblem(50_000, { minKg: 0.5, maxKg: null })).toBeNull();
  });

  it("leaves an absent weight to the caller's own 'still needed' check", () => {
    // A half-typed "0." must not be reported as below the hub's minimum.
    expect(weightProblem(Number.NaN, bounds)).toBeNull();
    expect(weightProblem(0, bounds)).toBeNull();
  });
});

describe("formatKg", () => {
  it("groups thousands, because 10000 and 1000 are one glance apart", () => {
    expect(formatKg(10_000)).toBe("10,000");
    expect(formatKg(1_000)).toBe("1,000");
    expect(formatKg(999)).toBe("999");
  });

  it("keeps real decimals and drops meaningless ones", () => {
    expect(formatKg(0.5)).toBe("0.5");
    expect(formatKg(12.5)).toBe("12.5");
    expect(formatKg(200)).toBe("200");
  });
});
