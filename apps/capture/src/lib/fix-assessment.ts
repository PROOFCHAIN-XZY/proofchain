import { haversineMetres } from "@shared/geo";
import type { Fix } from "./location";

/** The hub facts a device carries after enrolment. */
export interface HubContext {
  hubName: string;
  hubLat: number;
  hubLng: number;
  geofenceRadiusM: number;
}

export interface FixAssessment {
  usable: boolean;
  message: string | null;
}

/**
 * Decide whether a fix can support the claim "this weigh-in happened at the hub".
 *
 * The rule is relative to the hub's own geofence rather than a fixed number: a
 * fix whose error radius exceeds the fence cannot place the collector inside it,
 * however plausible the coordinate looks. Desktop browsers without GPS hardware
 * fall back to IP geolocation and cheerfully report accuracies of hundreds of
 * kilometres, which is precisely the case this rejects.
 *
 * Being far outside the fence is reported separately, because the collector can
 * act on "you are 3449 km from your hub" and cannot act on "quarantined".
 */
export function assessFix(
  candidate: Fix,
  device: HubContext | null,
): FixAssessment {
  if (!device) {
    return { usable: true, message: null };
  }

  const fence = device.geofenceRadiusM;

  if (candidate.accuracyM > fence) {
    return {
      usable: false,
      message:
        `Fix is only ±${formatDistance(candidate.accuracyM)} accurate, wider than the ` +
        `${fence} m hub geofence — it cannot show you are at ${device.hubName}. ` +
        `Use a phone with GPS, or move into the open and retry.`,
    };
  }

  const distance = haversineMetres(candidate.lat, candidate.lng, device.hubLat, device.hubLng);

  if (distance > fence + candidate.accuracyM) {
    return {
      usable: false,
      message:
        `This position is ${formatDistance(distance)} from ${device.hubName}, outside its ` +
        `${fence} m geofence. The server would quarantine the weigh-in.`,
    };
  }

  if (candidate.accuracyM > fence / 3) {
    return {
      usable: true,
      message:
        `Fix is ±${formatDistance(candidate.accuracyM)} accurate against a ${fence} m ` +
        `geofence — usable, but move into the open for a tighter one.`,
    };
  }

  return { usable: true, message: null };
}

function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km` : `${Math.round(metres)} m`;
}
