import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import {
  BATCH_STATUSES,
  MATERIAL_CODE_MAX_LENGTH,
  MATERIAL_CODE_PATTERN,
  MATERIAL_DESCRIPTION_MAX_LENGTH,
  MATERIAL_EXAMPLE_MAX_LENGTH,
  MATERIAL_EXAMPLES_MAX,
  MATERIAL_NAME_MAX_LENGTH,
  type BatchStatus,
  type MaterialType,
} from "@proofchain/shared";

/**
 * Validation at the system boundary. Everything crossing into the backend is
 * untrusted — most of it arrives from phones in the field over flaky links.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Material codes are validated in two stages, and both are needed.
 *
 * Here: the *shape*, which is all a DTO can check now that the catalogue lives in
 * the database rather than in a compiled union. This bounds what can reach the
 * signed-payload column at all.
 *
 * Then in the service: *existence* in the catalogue, via
 * `MaterialsService.assertKnown` for ingest or `assertOpenable` for a new batch.
 * That check needs a repository, so it cannot live in a decorator without wiring
 * class-validator to the Nest container — and putting it in the service also lets
 * the two paths differ, which they must: ingest accepts retired codes so an
 * offline queue signed hours ago still lands, while opening a batch does not.
 */
const MaterialCode = (): PropertyDecorator =>
  Matches(MATERIAL_CODE_PATTERN, {
    message: "material must be 2-16 characters: uppercase letters, digits, _ or -",
  });

/**
 * Query-string booleans.
 *
 * A URL carries `?quarantined=false` as the STRING "false", and every non-empty
 * string is truthy — so `@Type(() => Boolean)` turns it into `true` and
 * `@IsBoolean()` then waves it through as a perfectly valid boolean. The filter
 * silently returns the exact opposite of what was asked for, which on
 * `GET /events?quarantined=false` means an operator asking for clean events is
 * shown only the quarantined ones.
 *
 * Anything that is not a recognised spelling is passed through untouched so
 * `@IsBoolean()` rejects it with a 400. Guessing at `?quarantined=maybe` would
 * reintroduce the same class of silent wrong answer.
 */
const QueryBoolean = (): PropertyDecorator =>
  Transform(({ value }) => {
    if (typeof value === "boolean") return value;
    // Absent, or present-but-empty (`?quarantined=`): express no preference
    // rather than asserting false, so @IsOptional() drops the filter entirely.
    if (value === undefined || value === null || value === "") return undefined;

    const normalised = String(value).trim().toLowerCase();
    if (normalised === "true" || normalised === "1") return true;
    if (normalised === "false" || normalised === "0") return false;
    return value;
  });

export class WeighInPayloadDto {
  @IsIn(["proofchain.weighin.v2"])
  schema: "proofchain.weighin.v2";

  @IsUUID()
  collectorId: string;

  @IsUUID()
  hubId: string;

  @IsUUID()
  deviceId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(100_000)
  weightKg: number;

  @MaterialCode()
  material: MaterialType;

  @IsISO8601({ strict: true })
  capturedAt: string;

  @Matches(SHA256_HEX, { message: "photoHash must be a lowercase sha256 hex digest" })
  photoHash: string;

  @IsString()
  @MinLength(16)
  @MaxLength(64)
  nonce: string;
}

export class SubmitWeighInDto {
  @ValidateNested()
  @Type(() => WeighInPayloadDto)
  payload: WeighInPayloadDto;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  signature: string;
}

export class CreateCollectorDto {
  @IsString() @IsNotEmpty() @MaxLength(200) name: string;

  @Matches(/^\+?[0-9]{7,15}$/, { message: "phone must be an E.164-style number" })
  phone: string;

  @IsOptional() @IsString() @MaxLength(100) cooperativeId?: string;

  @IsOptional() @IsIn(["none", "basic", "verified"]) kycLevel?: "none" | "basic" | "verified";
}

export class EnrolDeviceDto {
  @IsUUID() collectorId: string;

  @IsString() @IsNotEmpty() @MaxLength(120) label: string;

  @Matches(/^[A-Za-z0-9+/]{43}=$/, {
    message: "publicKeyBase64 must be a base64-encoded 32-byte ed25519 key",
  })
  publicKeyBase64: string;
}

export class CreateHubDto {
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsString() @IsNotEmpty() @MaxLength(200) name: string;
  @IsOptional() @IsNumber() @Min(0) minWeightKg?: number;
  @IsOptional() @IsNumber() @Min(0) maxWeightKg?: number;
}

export class CreateBatchDto {
  @IsUUID() hubId: string;

  @MaterialCode()
  material: MaterialType;
}

export class CreateMaterialDto {
  /**
   * Permanent once a device signs it. Normalised to uppercase by the service, so
   * `pet` is accepted as input and stored as `PET` — but only the stored form
   * ever reaches a payload.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MATERIAL_CODE_MAX_LENGTH)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{1,15}$/, {
    message: "code must be 2-16 characters: letters, digits, _ or -",
  })
  code: string;

  @IsString() @IsNotEmpty() @MaxLength(MATERIAL_NAME_MAX_LENGTH) name: string;

  @IsOptional() @IsString() @MaxLength(MATERIAL_DESCRIPTION_MAX_LENGTH) description?: string;

  /**
   * The products this material is, as a collector would name them: ["Milk jugs",
   * "Detergent bottles"].
   *
   * Bounded here and normalised in the service, which is where blanks, repeats
   * and stray whitespace are dropped. Presentation only — nothing in this list
   * is ever signed or hashed.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MATERIAL_EXAMPLES_MAX)
  @IsString({ each: true })
  @MaxLength(MATERIAL_EXAMPLE_MAX_LENGTH, { each: true })
  examples?: string[];

  @IsOptional() @IsBoolean() active?: boolean;

  @IsOptional() @IsNumber() @Min(0) @Max(10_000) sortOrder?: number;
}

/**
 * Note the absence of `code`. A material code is signed into weigh-in payloads
 * and anchored on the ledger, so renaming one would invalidate the audit reports
 * of every batch containing it. `name` is the editable label; `active: false`
 * retires a material without touching history.
 */
export class UpdateMaterialDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(MATERIAL_NAME_MAX_LENGTH) name?: string;

  @IsOptional() @IsString() @MaxLength(MATERIAL_DESCRIPTION_MAX_LENGTH) description?: string;

  /**
   * Replaces the stored list wholesale rather than merging into it — an operator
   * removing a wrong example must be able to, and a merge would make that
   * impossible. Omitting the field leaves the list untouched; sending `[]`
   * clears it.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MATERIAL_EXAMPLES_MAX)
  @IsString({ each: true })
  @MaxLength(MATERIAL_EXAMPLE_MAX_LENGTH, { each: true })
  examples?: string[];

  @IsOptional() @IsBoolean() active?: boolean;

  @IsOptional() @IsNumber() @Min(0) @Max(10_000) sortOrder?: number;
}

export class AddEventsDto {
  @IsArray()
  @IsUUID("4", { each: true })
  eventIds: string[];
}

export class AdvanceStatusDto {
  @IsIn(BATCH_STATUSES as unknown as string[])
  status: BatchStatus;
}

export class RecordAnchorDto {
  @Matches(SHA256_HEX) merkleRoot: string;

  @Matches(/^[0-9a-f]{64}$/, { message: "stellarTxHash must be a 64-char hex hash" })
  stellarTxHash: string;

  @IsNumber() @Min(1) stellarLedger: number;

  @IsIn(["testnet", "public"]) network: "testnet" | "public";

  @IsString() @IsNotEmpty() @MaxLength(64) dataEntryKey: string;

  @IsISO8601({ strict: true }) anchoredAt: string;
}

/**
 * The worker reporting an attempt that produced no anchor.
 *
 * `detail` is free text on purpose — it is whatever Horizon or the SDK said,
 * and an operator debugging a stuck batch needs the real message rather than a
 * code we mapped it onto and lost the specifics of. Bounded, because it reaches
 * us from a network failure path where the message length is not ours to
 * control.
 */
export class RecordAnchorFailureDto {
  @IsIn(["failed", "unverified"]) outcome: "failed" | "unverified";

  @IsOptional() @IsString() @MaxLength(2000) detail?: string;

  /** Present for `unverified`: the submission that may have cost a real fee. */
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/, { message: "stellarTxHash must be a 64-char hex hash" })
  stellarTxHash?: string;
}

export class CreateCustodyTransferDto {
  @IsString() @IsNotEmpty() @MaxLength(200) fromParty: string;
  @IsString() @IsNotEmpty() @MaxLength(200) toParty: string;

  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) weightInKg: number;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) weightOutKg: number;

  @IsOptional() @IsString() @MaxLength(500) reason?: string;

  @IsISO8601({ strict: true }) transferredAt: string;
}

export class LoginDto {
  @IsEmail() email: string;

  // Deliberately looser than the 12-character minimum enforced when a password
  // is *set*: this validates an attempt to use an existing credential, and
  // rejecting a short one here would tell an attacker which accounts predate
  // the policy. Wrong passwords fail as wrong passwords.
  @IsString() @MinLength(8) @MaxLength(200) password: string;
}

/**
 * Minimum length for any password this system stores.
 *
 * Long rather than complex: length is what defeats offline cracking of an
 * argon2id hash, and composition rules mostly produce "Password1!". These
 * accounts can open, seal and anchor batches, so they are worth guessing.
 */
const PASSWORD_MIN_LENGTH = 12;

class PasswordFieldDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  // Bounded because argon2 hashes the whole input: an unbounded password is a
  // CPU-exhaustion vector on an unauthenticated-ish endpoint.
  @MaxLength(200)
  newPassword: string;
}

export class CreateUserDto {
  @IsEmail() email: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  @MaxLength(200)
  password: string;

  @IsIn(["admin", "operator", "auditor"])
  role: "admin" | "operator" | "auditor";
}

export class UpdateUserDto {
  @IsOptional() @IsIn(["admin", "operator", "auditor"]) role?: "admin" | "operator" | "auditor";

  @IsOptional() @IsBoolean() active?: boolean;
}

/** Admin resetting somebody else's password; no current password to prove. */
export class ResetPasswordDto extends PasswordFieldDto {}

/** A user changing their own password, proving they hold the current one. */
export class ChangePasswordDto extends PasswordFieldDto {
  @IsString() @IsNotEmpty() @MaxLength(200) currentPassword: string;
}

export class ListEventsQueryDto {
  @IsOptional() @IsUUID() hubId?: string;
  @IsOptional() @IsUUID() collectorId?: string;

  @IsOptional() @IsBoolean() @QueryBoolean() batched?: boolean;
  @IsOptional() @IsBoolean() @QueryBoolean() quarantined?: boolean;

  /**
   * Filter on whether the photo bytes have been received.
   *
   * The operator-facing question this answers is "which weigh-ins are still
   * missing their evidence, and whose phone are they on" — worth asking before
   * a batch is sealed, because after sealing the membership is frozen and the
   * photo can only ever be attached to a record already sold.
   */
  @IsOptional() @IsBoolean() @Type(() => Boolean) hasPhoto?: boolean;

  @IsOptional() @IsNumber() @Min(1) @Max(500) @Type(() => Number) limit?: number;
}
