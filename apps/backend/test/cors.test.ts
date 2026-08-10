import { describe, expect, it } from "vitest";
import { isAllowedOrigin, isLocalNetworkOrigin } from "../src/config/cors.js";

const ALLOWLIST = ["http://localhost:3001", "http://localhost:3002"];

describe("isLocalNetworkOrigin", () => {
  it.each([
    "http://localhost:3002",
    "http://127.0.0.1:3002",
    "http://[::1]:3002",
    "http://192.168.88.249:3002",
    "http://10.0.0.5:5173",
    "http://172.16.4.9:3002",
    "http://169.254.10.1:3002",
  ])("accepts the local origin %s", (origin) => {
    expect(isLocalNetworkOrigin(origin)).toBe(true);
  });

  it.each([
    "http://proofchain.example.com",
    "http://8.8.8.8",
    // Adjacent to private ranges but public: 172.15 and 172.32 are not RFC 1918.
    "http://172.15.0.1:3002",
    "http://172.32.0.1:3002",
    "http://11.0.0.1:3002",
    "http://192.169.1.1:3002",
  ])("rejects the public origin %s", (origin) => {
    expect(isLocalNetworkOrigin(origin)).toBe(false);
  });

  it("rejects a hostname that merely embeds a private address", () => {
    // A classic bypass: attacker-controlled DNS name shaped like a local one.
    expect(isLocalNetworkOrigin("http://192.168.1.1.evil.com")).toBe(false);
    expect(isLocalNetworkOrigin("http://localhost.evil.com")).toBe(false);
  });

  it("rejects non-http schemes", () => {
    expect(isLocalNetworkOrigin("file://localhost")).toBe(false);
    expect(isLocalNetworkOrigin("javascript:alert(1)")).toBe(false);
  });

  it("rejects malformed input rather than throwing", () => {
    expect(isLocalNetworkOrigin("not a url")).toBe(false);
    expect(isLocalNetworkOrigin("")).toBe(false);
  });
});

describe("isAllowedOrigin in production", () => {
  const inProd = (origin: string | undefined) => isAllowedOrigin(origin, ALLOWLIST, true);

  it("allows an origin on the explicit allowlist", () => {
    expect(inProd("http://localhost:3001")).toBe(true);
  });

  it("refuses a LAN origin that is not on the allowlist", () => {
    // The whole point of the production branch: no implicit local trust.
    expect(inProd("http://192.168.88.249:3002")).toBe(false);
  });

  it("refuses an unknown public origin", () => {
    expect(inProd("https://evil.example.com")).toBe(false);
  });

  it("allows a request with no Origin header", () => {
    // curl, health checks and the anchor worker carry no browser credentials.
    expect(inProd(undefined)).toBe(true);
  });
});

describe("isAllowedOrigin in development", () => {
  const inDev = (origin: string | undefined) => isAllowedOrigin(origin, ALLOWLIST, false);

  it("allows the phone on the office wifi", () => {
    expect(inDev("http://192.168.88.249:3002")).toBe(true);
  });

  it("allows 127.0.0.1, which is a different origin from localhost", () => {
    expect(inDev("http://127.0.0.1:3002")).toBe(true);
  });

  it("allows any local port, since dev servers move around", () => {
    expect(inDev("http://localhost:5173")).toBe(true);
  });

  it("still refuses a public origin", () => {
    expect(inDev("https://evil.example.com")).toBe(false);
  });
});
