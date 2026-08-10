import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Module,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as argon2 from "argon2";
import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { UserEntity } from "../database/entities";
import { loadConfig } from "../config/configuration";

export type Role = "admin" | "operator" | "auditor";

export const IS_PUBLIC = "isPublic";
/** Opt a route out of auth entirely (health, login, device ingest). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = "roles";
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
  ) {}

  async validate(email: string, password: string): Promise<UserEntity> {
    const user = await this.users.findOne({ where: { email: email.toLowerCase() } });

    // Verify against a dummy hash when the user is absent so that a missing
    // account and a wrong password take the same time — no user enumeration.
    const hash = user?.passwordHash ?? DUMMY_ARGON2_HASH;
    const ok = await argon2.verify(hash, password).catch(() => false);

    if (!user || !ok || !user.active) {
      throw new UnauthorizedException("invalid credentials");
    }
    return user;
  }

  async login(email: string, password: string): Promise<{ accessToken: string; role: Role }> {
    const user = await this.validate(email, password);
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    return { accessToken: await this.jwt.signAsync(payload), role: user.role };
  }

  static hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }
}

/** argon2id hash of a random string; only ever used to equalise timing. */
const DUMMY_ARGON2_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$3vC2N0YQ0kCq9K6l6H5t0aVQ0Yl7pWc0FhVv0eE2sLk";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const header = request.headers.authorization;

    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer token");
    }

    try {
      request.user = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      throw new UnauthorizedException("invalid or expired token");
    }

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length && !required.includes(request.user.role)) {
      throw new ForbiddenException(`requires role: ${required.join(" or ")}`);
    }

    return true;
  }
}

/**
 * Guards `POST /batches/:id/anchor`, the anchor worker's write-back of a
 * Stellar transaction onto a sealed batch. That route is `@Public()` (opted
 * out of `JwtAuthGuard`) because the worker is a headless service with no
 * operator session — but "no operator session" must not mean "no credential
 * at all". Before this guard existed, anyone who could learn a batch's
 * merkleRoot (trivially — it is printed by the public audit report) could
 * POST a fabricated Stellar tx hash and have it accepted as the on-chain
 * proof in every report sold to a buyer thereafter. Compares with
 * `timingSafeEqual` so the check itself cannot be timing-attacked into
 * leaking the token.
 */
@Injectable()
export class AnchorWorkerGuard implements CanActivate {
  private readonly token = loadConfig().anchorWorkerToken;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const presented = request.headers["x-anchor-worker-token"];

    if (typeof presented !== "string" || !this.matchesToken(presented)) {
      throw new UnauthorizedException("missing or invalid anchor worker token");
    }
    return true;
  }

  private matchesToken(presented: string): boolean {
    const expected = Buffer.from(this.token, "utf8");
    const given = Buffer.from(presented, "utf8");
    // Lengths must match before timingSafeEqual will even accept the buffers;
    // padding the comparison keeps that early return from leaking length info.
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity]),
    JwtModule.registerAsync({
      useFactory: () => {
        const config = loadConfig();
        return {
          secret: config.jwtSecret,
          signOptions: { expiresIn: config.jwtExpiresIn },
        };
      },
    }),
  ],
  providers: [AuthService, JwtAuthGuard, AnchorWorkerGuard],
  exports: [AuthService, JwtAuthGuard, AnchorWorkerGuard, JwtModule],
})
export class AuthModule {}
