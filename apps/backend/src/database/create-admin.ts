import "reflect-metadata";
import { config as loadDotenv } from "dotenv";
import { AppDataSource } from "./data-source";
import { UserEntity } from "./entities";
import { AuthService } from "../auth/auth.module";

loadDotenv();

/**
 * Create (or reset) an administrator account.
 *
 * This is the answer to "the database is migrated and empty — how does anyone
 * sign in?". The development seed cannot be that answer: it refuses to run with
 * NODE_ENV=production, and it creates three accounts with published passwords.
 *
 * Unlike the seed, this touches exactly one table and creates exactly the
 * account you name, so it is safe to run against a live deployment:
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run admin:create
 *
 * On a host with a one-off shell (Render, Railway, Fly) run it there so the
 * password never travels through a local shell history or a CI log.
 */

const MIN_PASSWORD_LENGTH = 12;

/** Matches the API's own policy in common/dto.ts — see the note there on length. */
function assertUsablePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters ` +
        `(this account can seal and anchor batches)`,
    );
  }
  // The placeholders shipped in .env.example and the development seed. Catching
  // them here is worth the two lines: an admin account whose password is in the
  // public repository is the single worst outcome this script can produce.
  const known = ["change-me-in-production", "admin-dev-password", "operator-dev-password"];
  if (known.includes(password)) {
    throw new Error("ADMIN_PASSWORD is a placeholder from the repository; choose a real password");
  }
}

async function createAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  // Present but empty is a mistake worth failing on, not a "no".
  const reset = (process.env.ADMIN_RESET_PASSWORD ?? "").toLowerCase() === "true";

  if (!email || !password) {
    throw new Error(
      "set ADMIN_EMAIL and ADMIN_PASSWORD, e.g. " +
        `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run admin:create`,
    );
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`ADMIN_EMAIL is not a valid email address: ${email}`);
  }
  assertUsablePassword(password);

  await AppDataSource.initialize();
  try {
    const users = AppDataSource.getRepository(UserEntity);
    const existing = await users.findOne({ where: { email } });

    if (existing && !reset) {
      // Not an error the caller can ignore: silently doing nothing would leave
      // someone believing they had just rotated a password when they had not.
      throw new Error(
        `${email} already exists. To reset its password and re-enable it, re-run with ` +
          `ADMIN_RESET_PASSWORD=true`,
      );
    }

    const passwordHash = await AuthService.hashPassword(password);

    if (existing) {
      existing.passwordHash = passwordHash;
      existing.role = "admin";
      // A deliberate part of the reset: this script is the recovery path, and
      // recovering an account nobody can log into is the point.
      existing.active = true;
      await users.save(existing);
      console.log(`reset password and restored admin role for ${email}`);
      return;
    }

    const created = await users.save(
      users.create({ email, passwordHash, role: "admin", active: true }),
    );
    console.log(`created admin ${created.email} (${created.id})`);
  } finally {
    await AppDataSource.destroy();
  }
}

createAdmin().catch((error: unknown) => {
  console.error(`admin:create failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
