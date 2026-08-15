import { describe, expect, it } from "vitest";
import { resolvePostgresConnection } from "../src/database/postgres-connection";

/**
 * These assertions are about whether the connection carrying the evidentiary
 * record is encrypted and verified. A regression here is silent — the app keeps
 * working, just over a connection somebody can read or intercept — so the
 * matrix is spelled out rather than spot-checked.
 */

const NEON = "postgres://user:pw@ep-cool-name-123.eu-central-1.aws.neon.tech/proofchain";
const LOCAL = "postgres://proofchain:proofchain@localhost:5433/proofchain";

describe("resolvePostgresConnection", () => {
  it("requires DATABASE_URL", () => {
    expect(() => resolvePostgresConnection({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a URL it cannot parse rather than failing at connect time", () => {
    expect(() => resolvePostgresConnection({ DATABASE_URL: "not-a-url" })).toThrow(
      /not a valid connection URL/,
    );
  });

  describe("host inference, when nothing else says", () => {
    it("verifies TLS against a remote host", () => {
      expect(resolvePostgresConnection({ DATABASE_URL: NEON }).ssl).toEqual({
        rejectUnauthorized: true,
      });
    });

    it.each([
      ["localhost", LOCAL],
      ["loopback ipv4", "postgres://u:p@127.0.0.1:5432/db"],
      ["loopback ipv6", "postgres://u:p@[::1]:5432/db"],
      ["a compose service name", "postgres://u:p@postgres:5432/db"],
      ["a private network address", "postgres://u:p@10.0.1.7:5432/db"],
      ["a provider-internal host", "postgres://u:p@db.render.internal:5432/db"],
    ])("leaves TLS off for %s", (_label, url) => {
      expect(resolvePostgresConnection({ DATABASE_URL: url }).ssl).toBe(false);
    });
  });

  describe("sslmode in the URL", () => {
    it("verifies for require, which is what Neon hands you", () => {
      const resolved = resolvePostgresConnection({ DATABASE_URL: `${NEON}?sslmode=require` });
      expect(resolved.ssl).toEqual({ rejectUnauthorized: true });
    });

    it("honours an explicit disable even on a remote host", () => {
      expect(resolvePostgresConnection({ DATABASE_URL: `${NEON}?sslmode=disable` }).ssl).toBe(
        false,
      );
    });

    it("does not downgrade prefer to plaintext, only to unverified", () => {
      expect(resolvePostgresConnection({ DATABASE_URL: `${NEON}?sslmode=prefer` }).ssl).toEqual({
        rejectUnauthorized: false,
      });
    });

    it("would encrypt a loopback connection if the URL asked", () => {
      expect(resolvePostgresConnection({ DATABASE_URL: `${LOCAL}?sslmode=require` }).ssl).toEqual({
        rejectUnauthorized: true,
      });
    });
  });

  describe("DATABASE_SSL overrides the URL", () => {
    it("turns TLS off", () => {
      const resolved = resolvePostgresConnection({
        DATABASE_URL: `${NEON}?sslmode=require`,
        DATABASE_SSL: "disable",
      });
      expect(resolved.ssl).toBe(false);
    });

    it("drops verification for a self-signed server", () => {
      const resolved = resolvePostgresConnection({
        DATABASE_URL: `${NEON}?sslmode=require`,
        DATABASE_SSL: "no-verify",
      });
      expect(resolved.ssl).toEqual({ rejectUnauthorized: false });
    });

    it("turns verified TLS on for a host that would otherwise be treated as local", () => {
      const resolved = resolvePostgresConnection({
        DATABASE_URL: LOCAL,
        DATABASE_SSL: "require",
      });
      expect(resolved.ssl).toEqual({ rejectUnauthorized: true });
    });

    it("names the accepted values when given something else", () => {
      expect(() =>
        resolvePostgresConnection({ DATABASE_URL: NEON, DATABASE_SSL: "yes-please" }),
      ).toThrow(/disable, no-verify, require/);
    });

    it("ignores an empty value rather than treating it as a choice", () => {
      expect(resolvePostgresConnection({ DATABASE_URL: NEON, DATABASE_SSL: "  " }).ssl).toEqual({
        rejectUnauthorized: true,
      });
    });
  });

  describe("a custom CA", () => {
    it("is attached and forces verification back on", () => {
      const resolved = resolvePostgresConnection({
        DATABASE_URL: NEON,
        DATABASE_SSL: "no-verify",
        DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
      });
      expect(resolved.ssl).toMatchObject({ rejectUnauthorized: true });
      expect((resolved.ssl as { ca: string }).ca).toContain("BEGIN CERTIFICATE");
    });

    it("refuses to be combined with TLS switched off", () => {
      expect(() =>
        resolvePostgresConnection({
          DATABASE_URL: NEON,
          DATABASE_SSL: "disable",
          DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----",
        }),
      ).toThrow(/DATABASE_SSL_CA is set but TLS is disabled/);
    });
  });

  /**
   * The reason this module rewrites the URL at all: node-postgres lets a parsed
   * connection string overwrite the `ssl` option it was passed alongside, so any
   * ssl parameter left in the URL would quietly win over the resolved decision.
   */
  describe("URL rewriting", () => {
    it("strips every ssl parameter that could override the ssl option", () => {
      const resolved = resolvePostgresConnection({
        DATABASE_URL: `${NEON}?sslmode=require&channel_binding=require&sslnegotiation=direct&application_name=proofchain`,
      });
      expect(resolved.url).not.toMatch(/sslmode|sslnegotiation/);
      // Unrelated parameters are the provider's business and are left alone.
      expect(resolved.url).toContain("channel_binding=require");
      expect(resolved.url).toContain("application_name=proofchain");
    });

    it("keeps credentials, host, port and database intact", () => {
      const resolved = resolvePostgresConnection({
        DATABASE_URL: "postgres://user:p%40ss@host.example:6543/proofchain?sslmode=require",
      });
      const url = new URL(resolved.url);
      expect(url.username).toBe("user");
      expect(decodeURIComponent(url.password)).toBe("p@ss");
      expect(url.host).toBe("host.example:6543");
      expect(url.pathname).toBe("/proofchain");
    });
  });
});
