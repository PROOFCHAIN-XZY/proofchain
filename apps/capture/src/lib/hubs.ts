/**
 * Switching the hub a phone is capturing against.
 *
 * A collector does not always deliver to the same site — the pilot runs several
 * hubs in Kenya and Nigeria, and a phone enrolled at one may spend a day at
 * another. Re-enrolling to move between them would mean an operator login in the
 * field, which is exactly what this app is built not to require.
 *
 * What makes this safe rather than a hole is that the hub id travels inside the
 * signed payload, so a switch is recorded, not implicit.
 *
 * The list is a snapshot taken at enrolment, because a field device holds no
 * operator token and `/hubs` requires one. It refreshes on the next enrolment.
 */

/** The hub facts a device needs to name a hub in a payload. */
export interface HubOption {
  id: string;
  code: string;
  name: string;
  /**
   * Sanity bounds for one weigh-in here, as published by the hub directory.
   *
   * Optional because a snapshot taken before the directory carried them is
   * still a valid snapshot on a phone that has not been back in signal since,
   * and a synthesised option has no directory entry behind it at all. Absent
   * means "not known here", which the weight check reads as "do not judge" —
   * never as zero.
   */
  minWeightKg?: number;
  maxWeightKg?: number;
}

/** The subset of provisioning a hub selection rewrites. */
export interface HubAssignment {
  hubId: string;
  hubName: string;
}

/**
 * "NBO-01 — Nairobi Pilot Hub", without saying it twice.
 *
 * Provisioning stores `hubName` as the whole label, so a synthesised option that
 * fed it as both code and name rendered "NBO-01 — Nairobi Pilot Hub — NBO-01 —
 * Nairobi Pilot Hub" on the collector's screen.
 */
export function hubLabel(hub: Pick<HubOption, "code" | "name">): string {
  const code = hub.code.trim();
  if (!code || hub.name.trim().startsWith(code)) return hub.name;
  return `${code} — ${hub.name}`;
}

/**
 * The assignment for a chosen hub, or null if it is not in the snapshot.
 *
 * Every field moves together, so the label on screen always describes the hub id
 * that will be signed into the payload.
 */
export function selectHub(hubs: readonly HubOption[], hubId: string): HubAssignment | null {
  const hub = hubs.find((h) => h.id === hubId);
  if (!hub) return null;

  return {
    hubId: hub.id,
    hubName: hubLabel(hub),
  };
}

/**
 * The list to show, given what was snapshotted and where the device is assigned.
 *
 * A device provisioned before the snapshot existed has an empty list; rather
 * than render an empty dropdown, its current hub is synthesised from the fields
 * provisioning already carries. The collector then sees one option — the truth —
 * instead of a control that appears broken.
 */
export function hubChoices(
  snapshot: readonly HubOption[] | undefined,
  current: HubAssignment & { hubCode?: string },
): HubOption[] {
  if (snapshot && snapshot.length > 0) {
    // The assigned hub must appear even if it was removed from the catalogue
    // since enrolment, otherwise the select silently jumps to another site.
    if (snapshot.some((h) => h.id === current.hubId)) return [...snapshot];

    return [
      ...snapshot,
      {
        id: current.hubId,
        code: current.hubCode ?? "",
        name: current.hubName,
      },
    ];
  }

  return [
    {
      id: current.hubId,
      code: current.hubCode ?? "",
      name: current.hubName,
    },
  ];
}

/** What a refreshed directory means for this device. */
export interface MergedSnapshot {
  hubs: HubOption[];
  /**
   * Set only when the device's own hub changed underneath it — a rename — so the
   * caller can re-save provisioning without churning it on every refresh.
   */
  assignment: HubAssignment | null;
}

/**
 * Fold a freshly fetched directory into what the device already holds.
 *
 * Two things have to survive a refresh. A device must keep its assigned hub even
 * if the directory no longer lists it — retired, or a different backend — because
 * losing it would leave the phone unable to sign anything. And if the assigned
 * hub has been renamed, the device must adopt the new label, or the collector
 * keeps seeing a name the operator has already changed.
 */
export function mergeHubSnapshot(
  directory: readonly HubOption[],
  current: HubAssignment & { hubCode?: string },
): MergedSnapshot {
  const hubs = hubChoices(directory, current);
  const fresh = directory.find((h) => h.id === current.hubId);

  if (!fresh) return { hubs, assignment: null };

  const renamed = hubLabel(fresh) !== current.hubName;

  return { hubs, assignment: renamed ? selectHub([fresh], fresh.id) : null };
}

/**
 * The bounds to check a weight against, for the hub the device is capturing at.
 *
 * Returns nulls rather than defaults when the hub is unknown to the snapshot or
 * predates bounds being published. A guessed ceiling would be worse than none:
 * too low it blocks honest weigh-ins, too high it is not a check at all.
 */
export function boundsForHub(
  hubs: readonly HubOption[],
  hubId: string,
): { minKg: number | null; maxKg: number | null } {
  const hub = hubs.find((h) => h.id === hubId);

  return {
    minKg: hub?.minWeightKg ?? null,
    maxKg: hub?.maxWeightKg ?? null,
  };
}
