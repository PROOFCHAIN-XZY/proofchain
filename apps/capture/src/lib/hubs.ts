/**
 * Switching the hub a phone is capturing against.
 *
 * A collector does not always deliver to the same site — the pilot runs several
 * hubs in Kenya and Nigeria, and a phone enrolled at one may spend a day at
 * another. Re-enrolling to move between them would mean an operator login in the
 * field, which is exactly what this app is built not to require.
 *
 * Two things make this safe rather than a hole. The hub id travels inside the
 * signed payload, so a switch is recorded, not implicit. And the server geofences
 * every event against the hub it names: claiming a hub you are not standing at
 * quarantines the weigh-in instead of laundering it. The dropdown therefore lets
 * a collector say where they are; it does not let them say where they were.
 *
 * The list is a snapshot taken at enrolment, because a field device holds no
 * operator token and `/hubs` requires one. It refreshes on the next enrolment.
 */

/** The hub facts a device needs to judge a fix and name a hub in a payload. */
export interface HubOption {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  geofenceRadiusM: number;
}

/** The subset of provisioning a hub selection rewrites. */
export interface HubAssignment {
  hubId: string;
  hubName: string;
  hubLat: number;
  hubLng: number;
  geofenceRadiusM: number;
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
 * The fence note beside the Hub label.
 *
 * A device provisioned by a build that predates `geofenceRadiusM` has none, and
 * `Math.round(undefined)` put "NaN m fence" in front of the collector. Saying
 * the fence is unknown is both true and a cue to re-pair.
 */
export function fenceLabel(radiusM: number | undefined): string {
  if (!Number.isFinite(radiusM) || (radiusM ?? 0) <= 0) return "fence unknown";
  return `${Math.round(radiusM!)} m fence`;
}

/**
 * The assignment for a chosen hub, or null if it is not in the snapshot.
 *
 * Every field moves together. Taking the id without its coordinates would leave
 * the device judging fixes against the *old* hub's fence while signing the new
 * hub's id — the collector would be told they are in range, and the server would
 * quarantine every event for being out of it.
 */
export function selectHub(hubs: readonly HubOption[], hubId: string): HubAssignment | null {
  const hub = hubs.find((h) => h.id === hubId);
  if (!hub) return null;

  return {
    hubId: hub.id,
    hubName: hubLabel(hub),
    hubLat: hub.lat,
    hubLng: hub.lng,
    geofenceRadiusM: hub.geofenceRadiusM,
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
        lat: current.hubLat,
        lng: current.hubLng,
        geofenceRadiusM: current.geofenceRadiusM,
      },
    ];
  }

  return [
    {
      id: current.hubId,
      code: current.hubCode ?? "",
      name: current.hubName,
      lat: current.hubLat,
      lng: current.hubLng,
      geofenceRadiusM: current.geofenceRadiusM,
    },
  ];
}

/** What a refreshed directory means for this device. */
export interface MergedSnapshot {
  hubs: HubOption[];
  /**
   * Set only when the device's own hub changed underneath it — a relocation, a
   * widened fence — so the caller can re-save provisioning without churning it
   * on every refresh.
   */
  assignment: HubAssignment | null;
}

/**
 * Fold a freshly fetched directory into what the device already holds.
 *
 * Two things have to survive a refresh. A device must keep its assigned hub even
 * if the directory no longer lists it — retired, or a different backend — because
 * losing it would leave the phone unable to sign anything. And if the assigned
 * hub *has* moved, the device must adopt the new coordinate and fence, or it will
 * keep judging fixes against a place the hub has left.
 */
export function mergeHubSnapshot(
  directory: readonly HubOption[],
  current: HubAssignment & { hubCode?: string },
): MergedSnapshot {
  const hubs = hubChoices(directory, current);
  const fresh = directory.find((h) => h.id === current.hubId);

  if (!fresh) return { hubs, assignment: null };

  const moved =
    fresh.lat !== current.hubLat ||
    fresh.lng !== current.hubLng ||
    fresh.geofenceRadiusM !== current.geofenceRadiusM;

  return { hubs, assignment: moved ? selectHub([fresh], fresh.id) : null };
}
