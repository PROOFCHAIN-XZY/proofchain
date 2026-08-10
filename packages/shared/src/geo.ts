const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres. Used for the hub geofence check — at hub
 * scale (hundreds of metres) the spherical approximation is far more accurate
 * than the GPS fix it is applied to.
 */
export function haversineMetres(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isWithinGeofence(
  point: { lat: number; lng: number },
  centre: { lat: number; lng: number },
  radiusM: number,
): boolean {
  return haversineMetres(point.lat, point.lng, centre.lat, centre.lng) <= radiusM;
}

export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}
