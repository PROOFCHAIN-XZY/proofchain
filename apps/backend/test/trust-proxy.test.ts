import { describe, expect, it } from "vitest";
import { parseTrustProxy, trustProxyWarning } from "../src/config/trust-proxy";

describe("parseTrustProxy", () => {
  it.each([undefined, "", "   ", "false", "FALSE", "off", "no", "0"])(
    "treats %j as trusting nothing",
    (value) => {
      expect(parseTrustProxy(value)).toBe(false);
    },
  );

  it.each(["true", "TRUE", "on", "yes"])("treats %j as trusting every hop", (value) => {
    expect(parseTrustProxy(value)).toBe(true);
  });

  it("reads a hop count", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy(" 2 ")).toBe(2);
  });

  it.each(["-1", "1.5"])("refuses %j rather than coercing it to something silent", (value) => {
    expect(() => parseTrustProxy(value)).toThrow(/whole number of proxy hops/);
  });

  it("passes a subnet list through for Express to validate", () => {
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(parseTrustProxy("10.0.0.0/8, 192.168.0.0/16")).toBe("10.0.0.0/8, 192.168.0.0/16");
  });
});

describe("trustProxyWarning", () => {
  it("warns that trusting every hop is spoofable", () => {
    expect(trustProxyWarning(true, true)).toMatch(/forge/);
    // The hazard does not depend on the environment.
    expect(trustProxyWarning(true, false)).toMatch(/forge/);
  });

  it("warns in production when nothing is trusted, because a proxy is likely", () => {
    expect(trustProxyWarning(false, true)).toMatch(/share one bucket/);
  });

  it("stays quiet in development, where running without a proxy is the norm", () => {
    expect(trustProxyWarning(false, false)).toBeNull();
  });

  it("stays quiet for a hop count, which is the intended production setting", () => {
    expect(trustProxyWarning(1, true)).toBeNull();
    expect(trustProxyWarning("loopback", true)).toBeNull();
  });
});
