import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryColumn,
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

  /**
   * Human place name for this coordinate, e.g. "Kaduna, Nigeria".
   *
   * Descriptive only — it exists so an audit report reads as somewhere real
   * rather than as a pair of decimals. Nothing derives from it: the geofence
   * uses lat/lng, and the signed payload and Merkle leaf never see it, so a
   * wrong or missing label cannot affect whether a weigh-in is accepted or a
   * batch verifies. Nullable because the geocoder is allowed to be down, and
   * because hubs enrolled before this column existed have no label.
   */
  @Column({ type: "varchar", length: 200, nullable: true })
  locality: string | null;

  /**
   * When the label was resolved, and the source's attribution.
   *
   * Kept because the label is a third-party claim about the world at a point in
   * time, and a report that shows it should be able to say where it came from —
   * ODbL requires the credit, and a reader deserves to know the name is OSM's
   * as of a date, not our own assertion.
   */
  @Column({ type: "timestamptz", nullable: true })
  localityResolvedAt: Date | null;

  @Column({ type: "varchar", length: 300, nullable: true })
  localityAttribution: string | null;

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

/**
 * The material catalogue an operator maintains at runtime.
 *
 * `code` is the primary key rather than a surrogate uuid, and that is deliberate:
 * the code is what devices sign and what every event and batch row already
 * stores, so a uuid would add a join without adding a fact. It also makes the
 * append-only rule structural — you cannot rename a primary key by accident.
 *
 * There is no foreign key from `collection_events.material` or
 * `batches.material` to this table. Adding one would be wrong: a retired or
 * deleted catalogue row must never be able to orphan or cascade into an anchored
 * event, whose material is a signed historical fact rather than a reference to
 * current configuration. Existence is checked at ingest instead, where it can be
 * reported to the collector as a 400 rather than as a constraint violation.
 */
@Entity("materials")
export class MaterialEntity {
  /** Uppercase, `PET`-shaped, immutable once signed. Never rename in place. */
  @PrimaryColumn({ type: "varchar", length: 16 })
  code: string;

  /** Presentation only — never signed, never hashed, safe to edit at will. */
  @Column({ type: "varchar", length: 120 })
  name: string;

  /** Field guidance: what actually counts as this material. */
  @Column({ type: "varchar", length: 300, nullable: true })
  description: string | null;

  /**
   * The products a collector would recognise this material as — "milk jugs",
   * "bottle caps".
   *
   * A real array rather than a delimited string, because these are separate
   * values that a picker renders one per chip, and packing them into one column
   * would put the parser in every reader instead of in the driver. Not null:
   * "no examples" is the empty array, so nothing downstream has to distinguish
   * absent from empty.
   */
  @Column({ type: "text", array: true, default: () => "'{}'" })
  examples: string[];

  /** False = retired: hidden from new capture, still valid in every stored event. */
  @Column({ default: true })
  active: boolean;

  @Column({ type: "int", default: 100 })
  sortOrder: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
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
  MaterialEntity,
];
