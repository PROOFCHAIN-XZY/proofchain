import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import type {
  AnchorAttemptOutcome,
  BatchStatus,
  IntegrityVerdict,
  KycLevel,
  MaterialType,
  StellarNetwork,
} from "@proofchain/shared";

/**
 * The five core entities (plus Hub and Device, which the integrity checks need).
 * Designed backwards from the audit artifact: every column here exists because a
 * verifier, a PRO, or a credit buyer will ask about it.
 *
 * Numeric columns use `numeric` with an explicit transformer. Postgres returns
 * `numeric` as a string via node-postgres to avoid silent float truncation, and
 * weights denominated in money-grade credits must not be read as strings.
 */

const numericTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};

/** A physical collection hub, with the geofence events must fall inside. */
@Entity("hubs")
export class HubEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true })
  code: string;

  @Column()
  name: string;

  @Column("double precision")
  lat: number;

  @Column("double precision")
  lng: number;

  @Column("int", { default: 250 })
  geofenceRadiusM: number;

  @Column("numeric", { precision: 10, scale: 3, default: 0.1, transformer: numericTransformer })
  minWeightKg: number;

  @Column("numeric", { precision: 10, scale: 3, default: 500, transformer: numericTransformer })
  maxWeightKg: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

/** Who did the collection work. */
@Entity("collectors")
export class CollectorEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;

  /** Tied to mobile-money identity; unique so one person is one payee. */
  @Column({ unique: true })
  phone: string;

  @Column({ nullable: true, type: "varchar" })
  cooperativeId: string | null;

  @Column({ type: "varchar", default: "none" })
  kycLevel: KycLevel;

  @Column("double precision", { nullable: true })
  homeLat: number | null;

  @Column("double precision", { nullable: true })
  homeLng: number | null;

  @Column({ default: true })
  active: boolean;

  @OneToMany(() => DeviceEntity, (d) => d.collector)
  devices: DeviceEntity[];

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

/**
 * An enrolled capture device. Its ed25519 public key is the root of event
 * authenticity — revoking it invalidates nothing already signed, which is why
 * `revokedAt` is a timestamp rather than a delete.
 */
@Entity("devices")
export class DeviceEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column("uuid")
  collectorId: string;

  @ManyToOne(() => CollectorEntity, (c) => c.devices, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "collectorId" })
  collector: CollectorEntity;

  @Column()
  label: string;

  /** Raw 32-byte ed25519 key, base64. Unique: one key, one device, forever. */
  @Column({ unique: true })
  publicKeyBase64: string;

  @CreateDateColumn({ type: "timestamptz" })
  enrolledAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  revokedAt: Date | null;
}

/** A group of events aggregated for processing / sale. */
@Entity("batches")
export class BatchEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column("uuid")
  hubId: string;

  @ManyToOne(() => HubEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "hubId" })
  hub: HubEntity;

  @Column({ type: "varchar" })
  material: MaterialType;

  @Index()
  @Column({ type: "varchar", default: "open" })
  status: BatchStatus;

  @Column("numeric", { precision: 12, scale: 3, default: 0, transformer: numericTransformer })
  totalWeightKg: number;

  @Column("int", { default: 0 })
  eventCount: number;

  /** Set exactly once, at seal time. Never recomputed — that is the point. */
  @Column({ type: "varchar", nullable: true })
  merkleRoot: string | null;

  @Column({ type: "timestamptz", nullable: true })
  sealedAt: Date | null;

  @OneToMany(() => CollectionEventEntity, (e) => e.batch)
  events: CollectionEventEntity[];

  @OneToOne(() => AnchorRecordEntity, (a) => a.batch)
  anchor: AnchorRecordEntity | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}

/** The atomic verified fact: one weigh-in. */
@Entity("collection_events")
@Unique("uq_event_payload_hash", ["payloadHash"])
@Index("ix_event_hub_captured", ["hubId", "capturedAt"])
export class CollectionEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column("uuid")
  collectorId: string;

  @ManyToOne(() => CollectorEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "collectorId" })
  collector: CollectorEntity;

  @Index()
  @Column("uuid")
  hubId: string;

  @ManyToOne(() => HubEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "hubId" })
  hub: HubEntity;

  @Index()
  @Column("uuid")
  deviceId: string;

  @ManyToOne(() => DeviceEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "deviceId" })
  device: DeviceEntity;

  /** Null until the event is pulled into a batch; frozen once that batch seals. */
  @Index()
  @Column({ type: "uuid", nullable: true })
  batchId: string | null;

  @ManyToOne(() => BatchEntity, (b) => b.events, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "batchId" })
  batch: BatchEntity | null;

  @Column("numeric", { precision: 10, scale: 3, transformer: numericTransformer })
  weightKg: number;

  @Column({ type: "varchar" })
  material: MaterialType;

  @Column("double precision")
  lat: number;

  @Column("double precision")
  lng: number;

  /** Device clock at capture. */
  @Column("timestamptz")
  capturedAt: Date;

  /** Server clock at ingest. The gap between the two is an integrity signal. */
  @Column("timestamptz")
  receivedAt: Date;

  /** sha256 of the photo bytes. The photo itself never goes on-chain. */
  @Column()
  photoHash: string;

  @Column({ type: "varchar", nullable: true })
  photoUri: string | null;

  @Column()
  nonce: string;

  /** base64 ed25519 signature over the canonical payload. */
  @Column("text")
  signature: string;

  /**
   * sha256 of the canonical payload. Unique, so the same signed weigh-in cannot
   * be ingested twice — replay protection enforced by the database, not by code.
   */
  @Column()
  payloadHash: string;

  @Column("jsonb")
  integrity: IntegrityVerdict;

  /** Quarantined events are visible to operators but never enter a batch. */
  @Index()
  @Column({ default: false })
  quarantined: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

/** Proves chain-of-custody between parties. */
@Entity("custody_transfers")
export class CustodyTransferEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column("uuid")
  batchId: string;

  @ManyToOne(() => BatchEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "batchId" })
  batch: BatchEntity;

  @Column()
  fromParty: string;

  @Column()
  toParty: string;

  @Column("numeric", { precision: 12, scale: 3, transformer: numericTransformer })
  weightInKg: number;

  @Column("numeric", { precision: 12, scale: 3, transformer: numericTransformer })
  weightOutKg: number;

  /** Stored, not derived, so a later change to either weight is auditable. */
  @Column("numeric", { precision: 12, scale: 3, transformer: numericTransformer })
  varianceKg: number;

  @Column({ type: "varchar", nullable: true })
  reason: string | null;

  @Column("timestamptz")
  transferredAt: Date;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

/** Links off-chain data to its on-chain proof. One anchor per batch. */
@Entity("anchor_records")
export class AnchorRecordEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index({ unique: true })
  @Column("uuid")
  batchId: string;

  @OneToOne(() => BatchEntity, (b) => b.anchor, { onDelete: "CASCADE" })
  @JoinColumn({ name: "batchId" })
  batch: BatchEntity;

  @Column()
  merkleRoot: string;

  @Column({ unique: true })
  stellarTxHash: string;

  @Column("bigint", { transformer: numericTransformer })
  stellarLedger: number;

  @Column({ type: "varchar", default: "testnet" })
  network: StellarNetwork;

  /** The manageData key the root was written under. */
  @Column()
  dataEntryKey: string;

  @Column("timestamptz")
  anchoredAt: Date;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

/**
 * One recorded attempt to put a batch's root on the ledger.
 *
 * Append-only, and it exists because failure was previously invisible. The
 * worker logged `[anchor-failed]` to stdout and moved on, leaving a batch that
 * had failed four hundred times indistinguishable from one sealed a minute ago:
 * both simply sat in the pending queue. Nobody could answer "is anchoring
 * working" without reading worker logs, and nothing throttled the retries.
 *
 * Successes are recorded too, so the table reads as the full history of what
 * was tried rather than a list of complaints.
 */
@Entity("anchor_attempts")
@Index("ix_anchor_attempt_batch_time", ["batchId", "occurredAt"])
export class AnchorAttemptEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column("uuid")
  batchId: string;

  @ManyToOne(() => BatchEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "batchId" })
  batch: BatchEntity;

  /** 1-based, assigned by the backend so two workers cannot both claim "attempt 3". */
  @Column("int")
  attemptNumber: number;

  /**
   * `failed` — the transaction never made it onto the ledger.
   * `unverified` — it was submitted but the read-back could not confirm it,
   *   which is the more alarming of the two: it may have cost a real fee and
   *   may yet appear.
   * `succeeded` — the anchor was recorded.
   */
  @Column({ type: "varchar" })
  outcome: AnchorAttemptOutcome;

  /** The error text, truncated. Operators debug from this, so it is stored verbatim. */
  @Column({ type: "text", nullable: true })
  detail: string | null;

  /** A transaction hash exists for `unverified` attempts and is what an operator chases. */
  @Column({ type: "varchar", nullable: true })
  stellarTxHash: string | null;

  @Column("timestamptz")
  occurredAt: Date;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

/** Operator/auditor login. Collectors authenticate by device key, not password. */
@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true })
  email: string;

  @Column("text")
  passwordHash: string;

  /** operator runs the hub; auditor is read-only; admin manages enrolment. */
  @Column({ type: "varchar", default: "operator" })
  role: "admin" | "operator" | "auditor";

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;
}

export const ALL_ENTITIES = [
  HubEntity,
  CollectorEntity,
  DeviceEntity,
  BatchEntity,
  CollectionEventEntity,
  CustodyTransferEntity,
  AnchorRecordEntity,
  AnchorAttemptEntity,
  UserEntity,
];
