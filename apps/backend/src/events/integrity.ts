import {
  verifyWeighInSignature,
  type IntegrityFinding,
  type IntegrityVerdict,
  type WeighInPayload,
} from "@proofchain/shared";

/**
 * Integrity v1 — cheap, high-value checks, run at ingest on every weigh-in.
 *
 * The framing that matters: a plastic credit is worth US$140–800/tonne, so there
 * is direct financial incentive to spoof a weigh-in. Anchoring proves a record
 * was not altered afterwards; it does NOT prove the material on the scale was
 * real. These checks are the ones that make the tonne *true*, not merely
 * immutable. They are deliberately pure — no DB, no clock, no I/O — so every
 * rule is testable in isolation and identical on server and (later) in review
 * tooling.
 *
 * v2 adds photo/volume plausibility and per-collector behavioural baselining;
 * v3 adds ML anomaly detection and tamper-evident hardware. Not before.
 */

export interface IntegrityContext {
  device: {
    id: string;
    collectorId: string;
    publicKeyBase64: string;
    revokedAt: Date | null;
  } | null;
  collector: { id: string; active: boolean } | null;
  hub: {
    id: string;
    minWeightKg: number;
    maxWeightKg: number;
  } | null;
  /** True when an event with this payloadHash (or nonce) already exists. */
  isDuplicate: boolean;
  /** Server receipt time. */
  now: Date;
  maxClockSkewSeconds: number;
}

/** A `fail` on any check quarantines the event; it can never enter a batch. */
export function evaluateIntegrity(
  payload: WeighInPayload,
  signature: string,
  ctx: IntegrityContext,
): IntegrityVerdict {
  const findings: IntegrityFinding[] = [
    checkDeviceEnrolled(payload, ctx),
    checkSignature(payload, signature, ctx),
    checkWeightRange(payload, ctx),
    checkDuplicate(ctx),
    checkClock(payload, ctx),
    checkPhoto(payload),
  ];

  const outcome = findings.some((f) => f.outcome === "fail")
    ? "fail"
    : findings.some((f) => f.outcome === "warn")
      ? "warn"
      : "pass";

  return { outcome, findings };
}

function checkDeviceEnrolled(payload: WeighInPayload, ctx: IntegrityContext): IntegrityFinding {
  if (!ctx.device) {
    return { check: "device_enrolled", outcome: "fail", detail: "device not enrolled" };
  }
  if (ctx.device.revokedAt !== null) {
    return {
      check: "device_enrolled",
      outcome: "fail",
      detail: `device revoked at ${ctx.device.revokedAt.toISOString()}`,
    };
  }
  if (ctx.device.collectorId !== payload.collectorId) {
    return {
      check: "device_enrolled",
      outcome: "fail",
      detail: "device is enrolled to a different collector",
    };
  }
  if (!ctx.collector || !ctx.collector.active) {
    return { check: "device_enrolled", outcome: "fail", detail: "collector is inactive" };
  }
  return { check: "device_enrolled", outcome: "pass" };
}

function checkSignature(
  payload: WeighInPayload,
  signature: string,
  ctx: IntegrityContext,
): IntegrityFinding {
  if (!ctx.device) {
    return { check: "signature_valid", outcome: "fail", detail: "no key to verify against" };
  }
  const valid = verifyWeighInSignature(payload, signature, ctx.device.publicKeyBase64);
  return valid
    ? { check: "signature_valid", outcome: "pass" }
    : {
        check: "signature_valid",
        outcome: "fail",
        detail: "signature does not match the enrolled device key",
      };
}

function checkWeightRange(payload: WeighInPayload, ctx: IntegrityContext): IntegrityFinding {
  if (!Number.isFinite(payload.weightKg) || payload.weightKg <= 0) {
    return { check: "weight_in_range", outcome: "fail", detail: "weight must be positive" };
  }
  if (!ctx.hub) {
    return { check: "weight_in_range", outcome: "fail", detail: "unknown hub" };
  }
  if (payload.weightKg < ctx.hub.minWeightKg) {
    return {
      check: "weight_in_range",
      outcome: "fail",
      detail: `${payload.weightKg} kg below hub minimum ${ctx.hub.minWeightKg} kg`,
    };
  }
  if (payload.weightKg > ctx.hub.maxWeightKg) {
    return {
      check: "weight_in_range",
      outcome: "fail",
      detail: `${payload.weightKg} kg above hub maximum ${ctx.hub.maxWeightKg} kg`,
    };
  }
  return { check: "weight_in_range", outcome: "pass" };
}

function checkDuplicate(ctx: IntegrityContext): IntegrityFinding {
  return ctx.isDuplicate
    ? {
        check: "not_duplicate",
        outcome: "fail",
        detail: "an identical signed weigh-in has already been ingested",
      }
    : { check: "not_duplicate", outcome: "pass" };
}

function checkClock(payload: WeighInPayload, ctx: IntegrityContext): IntegrityFinding {
  const captured = new Date(payload.capturedAt);
  if (Number.isNaN(captured.getTime())) {
    return { check: "clock_plausible", outcome: "fail", detail: "capturedAt is not a valid time" };
  }

  const skewSeconds = (captured.getTime() - ctx.now.getTime()) / 1000;

  // Future-dated beyond tolerance is a hard fail: a device cannot honestly
  // report a weigh-in that has not happened yet.
  if (skewSeconds > ctx.maxClockSkewSeconds) {
    return {
      check: "clock_plausible",
      outcome: "fail",
      detail: `captured ${Math.round(skewSeconds)} s in the future`,
    };
  }

  // Backdated is expected — an offline device may sync days later. It is only
  // worth flagging, because the offline queue is a first-class feature.
  if (-skewSeconds > ctx.maxClockSkewSeconds) {
    return {
      check: "clock_plausible",
      outcome: "warn",
      detail: `captured ${Math.round(-skewSeconds)} s before receipt (offline sync?)`,
    };
  }

  return { check: "clock_plausible", outcome: "pass" };
}

function checkPhoto(payload: WeighInPayload): IntegrityFinding {
  if (!/^[0-9a-f]{64}$/.test(payload.photoHash)) {
    return { check: "photo_present", outcome: "fail", detail: "photoHash is not a sha256 digest" };
  }
  return { check: "photo_present", outcome: "pass" };
}
