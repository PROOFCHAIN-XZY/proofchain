import { describe, expect, it } from "vitest";
import {
  generateDeviceKeypair,
  publicKeyToBase64,
  signWeighIn,
  type WeighInPayload,
} from "@proofchain/shared";
import { evaluateIntegrity, type IntegrityContext } from "../src/events/integrity";

/**
 * These tests encode the threat model, not just the code paths. Each one stands
 * for a way somebody could try to turn worthless data into a saleable credit.
 */

const HUB = {
  id: "hub-1",
  minWeightKg: 0.5,
  maxWeightKg: 200,
};

const NOW = new Date("2026-08-08T10:00:00.000Z");
const keypair = generateDeviceKeypair();

function makePayload(overrides: Partial<WeighInPayload> = {}): WeighInPayload {
  return {
    schema: "proofchain.weighin.v2",
    collectorId: "collector-1",
    hubId: HUB.id,
    deviceId: "device-1",
    weightKg: 12.5,
    material: "PET",
    capturedAt: "2026-08-08T09:59:30.000Z",
    photoHash: "a".repeat(64),
    nonce: "b".repeat(32),
    ...overrides,
  };
}

function makeContext(overrides: Partial<IntegrityContext> = {}): IntegrityContext {
  return {
    device: {
      id: "device-1",
      collectorId: "collector-1",
      publicKeyBase64: publicKeyToBase64(keypair.publicKey),
      revokedAt: null,
    },
    collector: { id: "collector-1", active: true },
    hub: HUB,
    isDuplicate: false,
    now: NOW,
    maxClockSkewSeconds: 900,
    ...overrides,
  };
}

/** Signs the payload with the enrolled key, as an honest device would. */
function signed(payload: WeighInPayload): string {
  return signWeighIn(payload, keypair.privateKey);
}

function findingFor(verdict: ReturnType<typeof evaluateIntegrity>, check: string) {
  return verdict.findings.find((f) => f.check === check);
}

describe("evaluateIntegrity — the honest path", () => {
  it("passes a well-formed weigh-in from an enrolled device at the hub", () => {
    const p = makePayload();
    const verdict = evaluateIntegrity(p, signed(p), makeContext());

    expect(verdict.outcome).toBe("pass");
    expect(verdict.findings.every((f) => f.outcome === "pass")).toBe(true);
  });

  it("reports every check on every event, so the audit log is complete", () => {
    const p = makePayload();
    const verdict = evaluateIntegrity(p, signed(p), makeContext());
    const checks = verdict.findings.map((f) => f.check).sort();

    expect(checks).toEqual([
      "clock_plausible",
      "device_enrolled",
      "not_duplicate",
      "photo_present",
      "signature_valid",
      "weight_in_range",
    ]);
  });
});

describe("evaluateIntegrity — forged or tampered records", () => {
  it("fails a weigh-in whose weight was inflated after the device signed it", () => {
    const honest = makePayload({ weightKg: 12.5 });
    const signature = signed(honest);
    const inflated = { ...honest, weightKg: 125 };

    const verdict = evaluateIntegrity(inflated, signature, makeContext());

    expect(verdict.outcome).toBe("fail");
    expect(findingFor(verdict, "signature_valid")?.outcome).toBe("fail");
  });

  it("fails a weigh-in signed by a device that was never enrolled", () => {
    const stranger = generateDeviceKeypair();
    const p = makePayload();
    const signature = signWeighIn(p, stranger.privateKey);

    const verdict = evaluateIntegrity(p, signature, makeContext());

    expect(verdict.outcome).toBe("fail");
    expect(findingFor(verdict, "signature_valid")?.outcome).toBe("fail");
  });

  it("fails when the device is unknown to us entirely", () => {
    const p = makePayload();
    const verdict = evaluateIntegrity(p, signed(p), makeContext({ device: null }));

    expect(verdict.outcome).toBe("fail");
    expect(findingFor(verdict, "device_enrolled")?.detail).toMatch(/not enrolled/);
  });

  it("fails a weigh-in from a revoked device (a stolen or cloned phone)", () => {
    const p = makePayload();
    const ctx = makeContext({
      device: {
        id: "device-1",
        collectorId: "collector-1",
        publicKeyBase64: publicKeyToBase64(keypair.publicKey),
        revokedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });

    const verdict = evaluateIntegrity(p, signed(p), ctx);

    expect(verdict.outcome).toBe("fail");
    expect(findingFor(verdict, "device_enrolled")?.detail).toMatch(/revoked/);
  });

  it("fails when a device is used to claim work for a different collector", () => {
    const p = makePayload({ collectorId: "collector-2" });
    const verdict = evaluateIntegrity(p, signed(p), makeContext());

    expect(verdict.outcome).toBe("fail");
    expect(findingFor(verdict, "device_enrolled")?.detail).toMatch(/different collector/);
  });

  it("fails a replay of an already-ingested weigh-in", () => {
    const p = makePayload();
    const verdict = evaluateIntegrity(p, signed(p), makeContext({ isDuplicate: true }));

    expect(verdict.outcome).toBe("fail");
    expect(findingFor(verdict, "not_duplicate")?.outcome).toBe("fail");
  });
});

describe("evaluateIntegrity — weight sanity", () => {
  it("fails a weight above the hub's plausible maximum", () => {
    const p = makePayload({ weightKg: 5000 });
    const verdict = evaluateIntegrity(p, signed(p), makeContext());

    expect(findingFor(verdict, "weight_in_range")?.detail).toMatch(/above hub maximum/);
  });

  it("fails a weight below the hub's minimum", () => {
    const p = makePayload({ weightKg: 0.05 });
    const verdict = evaluateIntegrity(p, signed(p), makeContext());

    expect(findingFor(verdict, "weight_in_range")?.detail).toMatch(/below hub minimum/);
  });

  it("fails a zero or negative weight", () => {
    for (const weightKg of [0, -5]) {
      const p = makePayload({ weightKg });
      const verdict = evaluateIntegrity(p, signed(p), makeContext());
      expect(findingFor(verdict, "weight_in_range")?.outcome, `weight=${weightKg}`).toBe("fail");
    }
  });
});

describe("evaluateIntegrity — clocks and offline sync", () => {
  it("warns, but does not fail, on a weigh-in that synced days later", () => {
    const p = makePayload({ capturedAt: "2026-08-05T09:00:00.000Z" });
    const verdict = evaluateIntegrity(p, signed(p), makeContext());

    // Offline-first capture is a feature: backdating is expected, not fraud.
    expect(verdict.outcome).toBe("warn");
    expect(findingFor(verdict, "clock_plausible")?.outcome).toBe("warn");
  });

  it("fails a weigh-in dated in the future beyond tolerated skew", () => {
    const p = makePayload({ capturedAt: "2026-08-08T11:00:00.000Z" });
    const verdict = evaluateIntegrity(p, signed(p), makeContext());

    expect(verdict.outcome).toBe("fail");
    expect(findingFor(verdict, "clock_plausible")?.detail).toMatch(/in the future/);
  });

  it("fails an unparseable timestamp", () => {
    const p = makePayload({ capturedAt: "not-a-date" });
    const verdict = evaluateIntegrity(p, signed(p), makeContext());

    expect(findingFor(verdict, "clock_plausible")?.outcome).toBe("fail");
  });
});

describe("evaluateIntegrity — photo evidence", () => {
  it("fails when the photo hash is missing or malformed", () => {
    for (const photoHash of ["", "nope", "A".repeat(64)]) {
      const p = makePayload({ photoHash });
      const verdict = evaluateIntegrity(p, signed(p), makeContext());
      expect(findingFor(verdict, "photo_present")?.outcome, photoHash).toBe("fail");
    }
  });
});

describe("evaluateIntegrity — verdict aggregation", () => {
  it("reports fail when any single check fails, even amid passes", () => {
    const p = makePayload({ weightKg: 9999 });
    const verdict = evaluateIntegrity(p, signed(p), makeContext());

    expect(verdict.outcome).toBe("fail");
    expect(verdict.findings.filter((f) => f.outcome === "pass").length).toBeGreaterThan(0);
  });

  it("collects multiple independent failures rather than stopping at the first", () => {
    const p = makePayload({ weightKg: 9999 });
    const verdict = evaluateIntegrity(p, signed(p), makeContext({ isDuplicate: true }));

    const failed = verdict.findings.filter((f) => f.outcome === "fail").map((f) => f.check);
    expect(failed).toContain("weight_in_range");
    expect(failed).toContain("not_duplicate");
  });
});
