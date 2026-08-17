import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { DataSource } from "typeorm";
import { randomUUID } from "node:crypto";
import { UsersService } from "../../src/users/users.service";
import { AuthService } from "../../src/auth/auth.module";
import { UserEntity } from "../../src/database/entities";
import { createTestDataSource, resetTables } from "./database";

/**
 * Account management is the control that decides who can seal and anchor
 * batches, so its failure modes are locking everyone out or letting the wrong
 * person in. Both are properties of concurrent state in a table, not of a
 * function in isolation — the last-admin rule is a lock plus a count — so these
 * run against a real Postgres.
 */

let dataSource: DataSource;
let service: UsersService;

beforeAll(async () => {
  dataSource = await createTestDataSource();
}, 60_000);

afterAll(async () => {
  await dataSource?.destroy();
});

beforeEach(async () => {
  await resetTables(dataSource);
  service = new UsersService(dataSource.getRepository(UserEntity), dataSource);
});

async function insertUser(
  email: string,
  role: "admin" | "operator" | "auditor",
  options: { active?: boolean; password?: string } = {},
): Promise<UserEntity> {
  const users = dataSource.getRepository(UserEntity);
  return users.save(
    users.create({
      email,
      passwordHash: await AuthService.hashPassword(options.password ?? "a-long-test-password"),
      role,
      active: options.active ?? true,
    }),
  );
}

/** Any actor other than the user being changed, so self-lockout rules stay out of the way. */
const SOMEONE_ELSE = { sub: randomUUID() };

describe("creating users", () => {
  it("returns a view that never carries the password hash", async () => {
    const created = await service.create({
      email: "ops@example.com",
      password: "a-long-test-password",
      role: "operator",
    });

    expect(created).toStrictEqual({
      id: expect.any(String),
      email: "ops@example.com",
      role: "operator",
      active: true,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(created)).not.toContain("argon2");
  });

  it("lower-cases the email, because login looks the account up that way", async () => {
    const created = await service.create({
      email: "  Ops@Example.COM ",
      password: "a-long-test-password",
      role: "operator",
    });
    expect(created.email).toBe("ops@example.com");

    // The account it just created must actually be reachable by login.
    const found = await dataSource
      .getRepository(UserEntity)
      .findOne({ where: { email: "ops@example.com" } });
    expect(found).not.toBeNull();
  });

  it("rejects a duplicate regardless of the case it is typed in", async () => {
    await service.create({ email: "ops@example.com", password: "a-long-test-password", role: "operator" });
    await expect(
      service.create({ email: "OPS@example.com", password: "a-long-test-password", role: "admin" }),
    ).rejects.toThrow(ConflictException);
  });

  it("stores a verifiable argon2 hash rather than the password", async () => {
    const created = await service.create({
      email: "ops@example.com",
      password: "a-long-test-password",
      role: "operator",
    });

    const row = await dataSource.getRepository(UserEntity).findOneOrFail({
      where: { id: created.id },
    });
    expect(row.passwordHash).not.toContain("a-long-test-password");
    expect(row.passwordHash.startsWith("$argon2id$")).toBe(true);
  });
});

describe("the last admin", () => {
  it("cannot be demoted", async () => {
    const admin = await insertUser("admin@example.com", "admin");
    await insertUser("ops@example.com", "operator");

    await expect(service.update(admin.id, { role: "operator" }, SOMEONE_ELSE)).rejects.toThrow(
      ConflictException,
    );
  });

  it("cannot be deactivated", async () => {
    const admin = await insertUser("admin@example.com", "admin");

    await expect(service.update(admin.id, { active: false }, SOMEONE_ELSE)).rejects.toThrow(
      /last active admin/,
    );
  });

  /** An inactive admin cannot log in, so they do not count as cover. */
  it("does not count a deactivated admin as the second one", async () => {
    const admin = await insertUser("admin@example.com", "admin");
    await insertUser("former@example.com", "admin", { active: false });

    await expect(service.update(admin.id, { active: false }, SOMEONE_ELSE)).rejects.toThrow(
      ConflictException,
    );
  });

  it("may be demoted once another active admin exists", async () => {
    const admin = await insertUser("admin@example.com", "admin");
    await insertUser("second@example.com", "admin");

    const updated = await service.update(admin.id, { role: "operator" }, SOMEONE_ELSE);
    expect(updated.role).toBe("operator");
  });

  /**
   * The rule has to survive two admins demoting each other at the same instant.
   * Serialised by the row locks in update(); without them both transactions read
   * "another admin exists" and both commit, leaving zero.
   */
  it("survives two concurrent demotions", async () => {
    const first = await insertUser("first@example.com", "admin");
    const second = await insertUser("second@example.com", "admin");

    const results = await Promise.allSettled([
      service.update(first.id, { role: "operator" }, SOMEONE_ELSE),
      service.update(second.id, { role: "operator" }, SOMEONE_ELSE),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded).toHaveLength(1);

    const remaining = await dataSource
      .getRepository(UserEntity)
      .count({ where: { role: "admin", active: true } });
    expect(remaining).toBe(1);
  });
});

describe("acting on your own account", () => {
  it("cannot deactivate itself", async () => {
    const admin = await insertUser("admin@example.com", "admin");
    await insertUser("second@example.com", "admin");

    await expect(service.update(admin.id, { active: false }, { sub: admin.id })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("cannot change its own role, even with other admins around", async () => {
    const admin = await insertUser("admin@example.com", "admin");
    await insertUser("second@example.com", "admin");

    await expect(
      service.update(admin.id, { role: "operator" }, { sub: admin.id }),
    ).rejects.toThrow(/ask another admin/);
  });

  it("may still be reactivated by itself, which is a no-op rather than a lockout", async () => {
    const admin = await insertUser("admin@example.com", "admin");
    const updated = await service.update(admin.id, { active: true }, { sub: admin.id });
    expect(updated.active).toBe(true);
  });
});

describe("updating", () => {
  it("refuses an empty patch instead of silently doing nothing", async () => {
    const user = await insertUser("ops@example.com", "operator");
    await expect(service.update(user.id, {}, SOMEONE_ELSE)).rejects.toThrow(BadRequestException);
  });

  it("404s on an unknown id", async () => {
    await expect(
      service.update(randomUUID(), { active: false }, SOMEONE_ELSE),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("passwords", () => {
  it("changes with the correct current password", async () => {
    const user = await insertUser("ops@example.com", "operator", { password: "the-old-password" });

    await expect(
      service.changeOwnPassword(user.id, "the-old-password", "the-new-password"),
    ).resolves.toEqual({ changed: true });

    const auth = new AuthService(dataSource.getRepository(UserEntity), {
      signAsync: async () => "token",
    } as never);
    await expect(auth.validate("ops@example.com", "the-new-password")).resolves.toBeTruthy();
    await expect(auth.validate("ops@example.com", "the-old-password")).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("refuses without the correct current password", async () => {
    const user = await insertUser("ops@example.com", "operator", { password: "the-old-password" });

    await expect(
      service.changeOwnPassword(user.id, "not-the-password", "the-new-password"),
    ).rejects.toThrow(UnauthorizedException);

    // And the stored credential is untouched.
    const row = await dataSource.getRepository(UserEntity).findOneOrFail({ where: { id: user.id } });
    const auth = new AuthService(dataSource.getRepository(UserEntity), {
      signAsync: async () => "token",
    } as never);
    await expect(auth.validate(row.email, "the-old-password")).resolves.toBeTruthy();
  });

  it("refuses to re-set the same password", async () => {
    const user = await insertUser("ops@example.com", "operator", { password: "the-old-password" });
    await expect(
      service.changeOwnPassword(user.id, "the-old-password", "the-old-password"),
    ).rejects.toThrow(BadRequestException);
  });

  it("lets an admin reset someone's password without knowing the old one", async () => {
    const user = await insertUser("ops@example.com", "operator", { password: "forgotten" });

    await service.resetPassword(user.id, "issued-by-the-admin");

    const auth = new AuthService(dataSource.getRepository(UserEntity), {
      signAsync: async () => "token",
    } as never);
    await expect(auth.validate("ops@example.com", "issued-by-the-admin")).resolves.toBeTruthy();
  });

  /** A reset is not a reinstatement: a suspended account stays suspended. */
  it("does not reactivate a deactivated account", async () => {
    const user = await insertUser("ops@example.com", "operator", { active: false });
    const view = await service.resetPassword(user.id, "issued-by-the-admin");
    expect(view.active).toBe(false);
  });
});
