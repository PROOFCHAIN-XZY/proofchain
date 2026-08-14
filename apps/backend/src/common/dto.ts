import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsLatitude,
  IsLongitude,
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
import { BATCH_STATUSES, MATERIAL_TYPES, type BatchStatus, type MaterialType } from "@proofchain/shared";

/**
 * Validation at the system boundary. Everything crossing into the backend is
 * untrusted — most of it arrives from phones in the field over flaky links.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

export class WeighInPayloadDto {
  @IsIn(["proofchain.weighin.v1"])
  schema: "proofchain.weighin.v1";

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

  @IsIn(MATERIAL_TYPES as unknown as string[])
  material: MaterialType;

  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

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

  @IsOptional() @IsLatitude() homeLat?: number;
  @IsOptional() @IsLongitude() homeLng?: number;
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
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;

  @IsOptional() @IsNumber() @Min(10) @Max(20_000) geofenceRadiusM?: number;
  @IsOptional() @IsNumber() @Min(0) minWeightKg?: number;
  @IsOptional() @IsNumber() @Min(0) maxWeightKg?: number;
}

export class CreateBatchDto {
  @IsUUID() hubId: string;

  @IsIn(MATERIAL_TYPES as unknown as string[])
  material: MaterialType;
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

  @IsString() @MinLength(8) @MaxLength(200) password: string;
}

export class ListEventsQueryDto {
  @IsOptional() @IsUUID() hubId?: string;
  @IsOptional() @IsUUID() collectorId?: string;

  @IsOptional() @IsBoolean() @Type(() => Boolean) batched?: boolean;
  @IsOptional() @IsBoolean() @Type(() => Boolean) quarantined?: boolean;

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
