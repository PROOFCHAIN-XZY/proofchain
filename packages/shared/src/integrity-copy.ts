import { INTEGRITY_CHECKS, type IntegrityCheck } from "./types.js";

/**
 * Integrity outcomes, in words a collector can act on — both the server's
 * findings and the one check a device can run before it signs.
 *
 * A failed check is not a diagnostic here — it is unpaid work. The collector is
 * standing at a scale with the sack still in front of them, and the only thing
 * that matters is whether they can fix this weigh-in and whether they should
 * re-do it now or fetch an operator. `weight_in_range: 300 kg above hub maximum
 * 200 kg` answers neither: it names an internal check and leaves the person
 * holding the material to infer the rest.
 *
 * The raw finding is not lost by translating it. It stays on the event's
 * integrity verdict in the database, and the dashboard renders check names
 * verbatim, because an operator triaging quarantined events genuinely does want
 * the identifier. Two audiences, two renderings, one source finding.
 *
 * Copy rules, from the field:
 *
 * - Say what happened, then what to do. A sentence a collector cannot act on is
 *   noise on a small screen in daylight.
 * - Never blame the collector for something only an operator can fix. Enrolment
 *   and revocation are back-office states; the useful instruction is "ask an
 *   operator", not an apology.
 * - No jargon: no "signature", no "nonce", no "payload". "This phone" and "this
 *   weigh-in" are the only two objects a collector needs.
 */

const COLLECTOR_COPY: Record<IntegrityCheck, string> = {
  signature_valid:
    "This phone's signing key was not accepted. Ask an operator to re-enrol it — weigh-ins captured until then will not count.",
  device_enrolled:
    "This phone is not enrolled to capture for this collector. Ask an operator to enrol it again.",
  weight_in_range:
    "The weight is outside what this hub accepts. Re-weigh the material and capture it again.",
  not_duplicate: "This weigh-in was already recorded, so it was not counted twice.",
  clock_plausible:
    "This phone's date and time are wrong. Correct them in the phone's settings, then capture this weigh-in again.",
  photo_present: "The photo did not record properly. Capture this weigh-in again with a new photo.",
};

function isKnownCheck(check: string): check is IntegrityCheck {
  return (INTEGRITY_CHECKS as readonly string[]).includes(check);
}

/**
 * One finding, as a collector should read it.
 *
 * Deliberately tolerant of an unrecognised check. A field phone can run for
 * weeks against a backend that has been updated under it, so a check this build
 * has never heard of is an expected state, not a bug — and falling back to the
 * server's own detail is more useful than either crashing or saying nothing.
 */
export function describeFinding(finding: { check: string; detail?: string }): string {
  if (isKnownCheck(finding.check)) return COLLECTOR_COPY[finding.check];

  return finding.detail
    ? `This weigh-in was refused: ${finding.detail}`
    : "This weigh-in was refused by the server.";
}

/**
 * Every failed check in one line, for the queue row.
 *
 * Deduplicated, because the copy is per check rather than per detail and a
 * server that reports the same check twice would otherwise print the same
 * sentence twice at a collector.
 */
export function describeFailures(
  findings: readonly { check: string; outcome: string; detail?: string }[],
): string {
  const messages = findings
    .filter((f) => f.outcome === "fail")
    .map((f) => describeFinding(f));

  return [...new Set(messages)].join(" ");
}

/**
 * The same findings for an operator or a log: check name, then the server's
 * detail. This is the format the capture apps used to show collectors; it is
 * the right format for someone who can act on `clock_plausible` as a string.
 */
export function technicalSummary(
  findings: readonly { check: string; outcome: string; detail?: string }[],
): string {
  return findings
    .filter((f) => f.outcome === "fail")
    .map((f) => `${f.check}${f.detail ? `: ${f.detail}` : ""}`)
    .join("; ");
}

/**
 * The hub's weight bounds as a device knows them.
 *
 * Either bound may be null: a phone provisioned before the hub directory carried
 * bounds, or assigned to a hub the directory no longer lists, has no figure to
 * check against. Null means "unknown", and unknown never blocks capture — a
 * missing piece of configuration must not cost a collector a weigh-in. The
 * server still enforces the real bounds at ingest; this check exists to catch
 * the mistake while the material is still on the scale.
 */
export interface HubWeightBounds {
  minKg: number | null;
  maxKg: number | null;
}

/**
 * Digits a collector can read at a glance: no exponent, no trailing zeros, and
 * thousands grouped, because "10000" and "1000" are one careless glance apart at
 * arm's length in daylight.
 *
 * Grouping is done by hand rather than through `toLocaleString`, because this
 * runs in Hermes on a field phone where full ICU data is not guaranteed.
 */
export function formatKg(value: number): string {
  const fixed = Number(value.toFixed(3)).toString();
  const [whole = "", fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * The client-side half of `weight_in_range`, in the collector's words.
 *
 * Returns null when the weight is acceptable — or when it cannot be judged.
 * Both capture apps run this before signing, so a weight the hub will refuse is
 * refused while it can still be corrected, rather than becoming a rejected row
 * discovered hours later when the sack is long gone.
 */
export function weightProblem(weightKg: number, bounds: HubWeightBounds): string | null {
  // Nothing to judge yet. A half-typed "0." is not a weight below the minimum,
  // and telling a collector their weigh-in is too light while they are still
  // typing it is noise. The caller's own "still needed: a weight" check owns
  // this case.
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;

  if (bounds.maxKg !== null && weightKg > bounds.maxKg) {
    return `Too heavy for this hub — the limit is ${formatKg(bounds.maxKg)} kg for one weigh-in. Split the load and weigh it in parts.`;
  }
  if (bounds.minKg !== null && weightKg < bounds.minKg) {
    return `Too light for this hub — the minimum is ${formatKg(bounds.minKg)} kg for one weigh-in.`;
  }
  return null;
}
