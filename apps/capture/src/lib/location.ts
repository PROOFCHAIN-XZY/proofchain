export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
  at: string;
}

/**
 * A GPS fix, with accuracy surfaced rather than hidden.
 *
 * Accuracy matters because the server geofences on this coordinate. A 500 m
 * accuracy fix taken indoors can quarantine an honest weigh-in, so the UI shows
 * the collector how good the fix is before they commit to signing it.
 */
/**
 * Browsers expose `navigator.geolocation` on insecure origins but refuse to use
 * it, reporting PERMISSION_DENIED. That produces the single most misleading
 * message this app can show: the collector is told they denied permission, goes
 * into phone settings, finds it already granted, and has no way forward. So the
 * context is checked before the API is called, and named as the real cause.
 *
 * Secure means HTTPS, or localhost. A phone opening this app over the office
 * wifi on a plain http:// LAN address is NOT a secure context.
 */
export function isSecureContextAvailable(): boolean {
  return typeof window !== "undefined" && window.isSecureContext;
}

export const INSECURE_CONTEXT_MESSAGE =
  "GPS is blocked because this page is not served over HTTPS. " +
  "Open it via http://localhost, or serve it over HTTPS — phone settings will not fix this.";

export function getFix(timeoutMs = 15_000): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("this device has no geolocation"));
      return;
    }

    if (!isSecureContextAvailable()) {
      reject(new Error(INSECURE_CONTEXT_MESSAGE));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
          accuracyM: Math.round(position.coords.accuracy),
          at: new Date(position.timestamp).toISOString(),
        }),
      // The Permissions API distinguishes "the site is blocked" from "the prompt
      // was never answered". Those need opposite actions from the collector, and
      // the GeolocationPositionError alone cannot tell them apart.
      (error) => {
        void describeDenial(error).then((message) => reject(new Error(message)));
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

export type PermissionStateish = "granted" | "denied" | "prompt" | "unknown";

/** Best-effort: Safari and older browsers do not expose geolocation permission state. */
export async function geolocationPermissionState(): Promise<PermissionStateish> {
  try {
    if (!navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    return status.state as PermissionStateish;
  } catch {
    return "unknown";
  }
}

export const BLOCKED_MESSAGE =
  "This site is blocked from using location. Click the icon at the left of the " +
  "address bar → Site settings → Location → Allow, then reload and try again.";

export const DISMISSED_MESSAGE =
  "The location prompt was not answered. Tap “Get GPS fix” again and choose Allow " +
  "— a weigh-in cannot be verified without a position.";

async function describeDenial(error: GeolocationPositionError): Promise<string> {
  if (error.code !== error.PERMISSION_DENIED) return geolocationMessage(error);
  if (!isSecureContextAvailable()) return INSECURE_CONTEXT_MESSAGE;

  const state = await geolocationPermissionState();
  if (state === "denied") return BLOCKED_MESSAGE;
  if (state === "prompt") return DISMISSED_MESSAGE;
  return geolocationMessage(error);
}

export function geolocationMessage(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      // A denial on an insecure origin is the browser refusing the origin, not
      // the collector refusing the prompt — say which one it actually was.
      return isSecureContextAvailable()
        ? "location permission denied — a weigh-in cannot be verified without it"
        : INSECURE_CONTEXT_MESSAGE;
    case error.POSITION_UNAVAILABLE:
      return "no position available (move into the open and retry)";
    case error.TIMEOUT:
      return "timed out waiting for a GPS fix";
    default:
      return error.message || "could not get a location fix";
  }
}
