import { describe, expect, it } from "vitest";
import { haversineMetres, isValidLatLng, isWithinGeofence } from "../src/geo.js";

const hub = { lat: -1.286389, lng: 36.817223 }; // Nairobi CBD

describe("haversineMetres", () => {
  it("is zero for a point against itself", () => {
    expect(haversineMetres(hub.lat, hub.lng, hub.lat, hub.lng)).toBe(0);
  });

  it("is symmetric", () => {
    const a = haversineMetres(hub.lat, hub.lng, 6.5244, 3.3792);
    const b = haversineMetres(6.5244, 3.3792, hub.lat, hub.lng);
    expect(a).toBeCloseTo(b, 6);
  });

  it("matches a known long-haul distance (Nairobi to Lagos ~3830 km)", () => {
    const m = haversineMetres(hub.lat, hub.lng, 6.5244, 3.3792);
    expect(m / 1000).toBeGreaterThan(3750);
    expect(m / 1000).toBeLessThan(3900);
  });

  it("resolves short hub-scale distances", () => {
    // 0.001 degrees of latitude is ~111 m anywhere on Earth.
    const m = haversineMetres(hub.lat, hub.lng, hub.lat + 0.001, hub.lng);
    expect(m).toBeGreaterThan(105);
    expect(m).toBeLessThan(118);
  });
});

describe("isWithinGeofence", () => {
  it("accepts a weigh-in at the hub", () => {
    expect(isWithinGeofence(hub, hub, 250)).toBe(true);
  });

  it("accepts a weigh-in just inside the fence", () => {
    expect(isWithinGeofence({ lat: hub.lat + 0.001, lng: hub.lng }, hub, 250)).toBe(true);
  });

  it("rejects a weigh-in a kilometre away", () => {
    expect(isWithinGeofence({ lat: hub.lat + 0.01, lng: hub.lng }, hub, 250)).toBe(false);
  });

  it("rejects a null-island GPS fix, the classic spoof tell", () => {
    expect(isWithinGeofence({ lat: 0, lng: 0 }, hub, 250)).toBe(false);
  });
});

describe("isValidLatLng", () => {
  it("accepts in-range coordinates", () => {
    expect(isValidLatLng(-1.286389, 36.817223)).toBe(true);
    expect(isValidLatLng(-90, 180)).toBe(true);
  });

  it("rejects out-of-range or non-finite coordinates", () => {
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(0, 181)).toBe(false);
    expect(isValidLatLng(Number.NaN, 0)).toBe(false);
    expect(isValidLatLng(0, Infinity)).toBe(false);
  });
});
