import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Not, Repository } from "typeorm";
import * as argon2 from "argon2";
import { UserEntity } from "../database/entities";
import { AuthService, type Role } from "../auth/auth.module";
import type { CreateUserDto, UpdateUserDto } from "../common/dto";

/**
 * Accounts for the humans who operate the platform.
 *
 * Before this existed, users could only be created by the development seed —
 * which refuses to run against production, hardcodes three well-known
 * passwords, and is not something you want anywhere near a live database. The
 * practical effect was that adding an operator to a deployed instance meant
 * opening psql and writing an argon2 hash by hand.
 *
 * Collectors are deliberately absent here: they authenticate by device key, not
 * password, and are managed through the registry.
 */

/** A user as the API returns it — never the password hash. */
export interface UserView {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export function toUserView(user: UserEntity): UserView {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async list(): Promise<UserView[]> {
    const rows = await this.users.find({ order: { createdAt: "ASC" } });
    return rows.map(toUserView);
  }

  async findOne(id: string): Promise<UserView> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`user ${id} not found`);
    return toUserView(user);
  }

  async create(dto: CreateUserDto): Promise<UserView> {
    // Stored lower-cased because login looks up by lower-cased email; without
    // this, "Ops@example.com" would create an account nobody can sign in to.
    const email = dto.email.trim().toLowerCase();

    const existing = await this.users.findOne({ where: { email } });
    if (existing) throw new ConflictException(`a user with email ${email} already exists`);

    const user = await this.users.save(
      this.users.create({
        email,
        passwordHash: await AuthService.hashPassword(dto.password),
        role: dto.role,
        active: true,
      }),
    );
    return toUserView(user);
  }

  /**
   * Change a user's role or active flag.
   *
   * Runs in a transaction that locks the admin rows, so two administrators
   * demoting each other at the same moment cannot both pass the last-admin
   * check and leave the deployment with nobody able to manage it.
   */
  async update(id: string, dto: UpdateUserDto, actor: { sub: string }): Promise<UserView> {
    if (dto.role === undefined && dto.active === undefined) {
      throw new BadRequestException("nothing to update: provide role, active, or both");
    }

    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(UserEntity, {
        where: { id },
        lock: { mode: "pessimistic_write" },
      });
      if (!user) throw new NotFoundException(`user ${id} not found`);

      const losingAdmin =
        user.role === "admin" &&
        ((dto.role !== undefined && dto.role !== "admin") || dto.active === false);

      if (losingAdmin) {
        // Locking the *other* admin rows is what makes the count below
        // trustworthy under concurrency: a second transaction trying to demote
        // one of them blocks here until this one commits.
        const otherAdmins = await manager.find(UserEntity, {
          where: { role: "admin", active: true, id: Not(id) },
          lock: { mode: "pessimistic_write" },
        });

        if (otherAdmins.length === 0) {
          throw new ConflictException(
            "this is the last active admin; promote another user to admin first, " +
              "otherwise nobody can manage accounts, hubs or devices",
          );
        }
      }

      // Self-lockout is a footgun rather than a policy question — an admin who
      // demotes themselves cannot undo it, and needs a colleague or shell
      // access to recover. The last-admin rule above does not catch it when a
      // second admin exists.
      if (id === actor.sub) {
        if (dto.active === false) {
          throw new ForbiddenException("you cannot deactivate your own account");
        }
        if (dto.role !== undefined && dto.role !== user.role) {
          throw new ForbiddenException(
            "you cannot change your own role; ask another admin to do it",
          );
        }
      }

      if (dto.role !== undefined) user.role = dto.role;
      if (dto.active !== undefined) user.active = dto.active;

      return toUserView(await manager.save(user));
    });
  }

  /**
   * Admin resets someone else's password — the "operator forgot it" path. There
   * is no email delivery in this build, so the new password is handed over out
   * of band and the user changes it themselves afterwards.
   */
  async resetPassword(id: string, newPassword: string): Promise<UserView> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`user ${id} not found`);

    user.passwordHash = await AuthService.hashPassword(newPassword);
    return toUserView(await this.users.save(user));
  }

  /**
   * A user changes their own password, proving they know the current one.
   *
   * Sessions already issued are NOT invalidated — there is no token revocation
   * in this build, so a token stolen before the change keeps working until it
   * expires (12h by default). Deactivating the account is the control that
   * takes effect immediately; `JwtAuthGuard` re-reads the row on every request.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true }> {
    const user = await this.users.findOne({ where: { id: userId } });
    // The guard already established this user exists and is active; a miss here
    // means the row vanished mid-request.
    if (!user) throw new UnauthorizedException("account is no longer active");

    const ok = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
    if (!ok) throw new UnauthorizedException("current password is incorrect");

    if (currentPassword === newPassword) {
      throw new BadRequestException("the new password must differ from the current one");
    }

    user.passwordHash = await AuthService.hashPassword(newPassword);
    await this.users.save(user);
    return { changed: true };
  }
}
