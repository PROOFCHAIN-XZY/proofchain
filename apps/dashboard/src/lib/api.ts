import { cookies } from "next/headers";

/**
 * Server-side backend client.
 *
 * All reads happen in server components so the operator's token stays in an
 * httpOnly cookie and never reaches client JavaScript. The dashboard shows
 * evidence about saleable credits; a token in localStorage would put that
 * behind any XSS on the page.
 */

export const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
export const TOKEN_COOKIE = "proofchain_token";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The backend's own explanation, when it sent one worth showing a person. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

/**
 * Nest's exception filter sends `{ message }`, sometimes as an array of
 * validation failures. Anything unreadable yields undefined rather than dumping
 * a stringified body onto the page.
 */
async function detailOf(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return undefined;

    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.filter((m) => typeof m === "string").join("; ");
    return undefined;
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;

  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    // Evidence must never be served stale: a report page showing a pre-anchor
    // state after anchoring would undermine the whole point.
    cache: "no-store",
  });

  if (!res.ok) {
    // Carry the backend's own message through. Several of these are the only
    // useful thing on screen — "material PS is used by 240 event(s) … retire it
    // instead" tells an operator what to do, whereas "DELETE /materials/PS
    // failed" tells them to guess.
    throw new ApiError(`${init.method ?? "GET"} ${path} failed`, res.status, await detailOf(res));
  }
  return (await res.json()) as T;
}

export interface Batch {
  id: string;
  hubId: string;
  material: string;
  status: "open" | "sealed" | "processed" | "sold";
  totalWeightKg: string | number;
  eventCount: number;
  merkleRoot: string | null;
  sealedAt: string | null;
  createdAt: string;
  anchor: {
    stellarTxHash: string;
    stellarLedger: string | number;
    network: string;
    anchoredAt: string;
  } | null;
}

export interface CollectionEvent {
  id: string;
  collectorId: string;
  hubId: string;
  batchId: string | null;
  weightKg: string | number;
  material: string;
  capturedAt: string;
  receivedAt: string;
  photoHash: string;
  payloadHash: string;
  quarantined: boolean;
  integrity: {
    outcome: "pass" | "warn" | "fail";
    findings: { check: string; outcome: string; detail?: string }[];
  };
}

export interface AuditReport {
  reportVersion: string;
  generatedAt: string;
  batch: {
    id: string;
    status: string;
    material: string;
    totalWeightKg: number;
    totalWeightTonnes: number;
    eventCount: number;
    sealedAt: string | null;
    createdAt: string;
  };
  hub: {
    id: string;
    code: string;
    name: string;
    /** OSM-derived place name; descriptive only, never part of the proof. */
  };
  collectors: {
    id: string;
    name: string;
    kycLevel: string;
    eventCount: number;
    weightKg: number;
  }[];
  chainOfCustody: {
    id: string;
    fromParty: string;
    toParty: string;
    weightInKg: number;
    weightOutKg: number;
    varianceKg: number;
    variancePct: number | null;
    reason: string | null;
    transferredAt: string;
  }[];
  reconciliation: {
    collectedKg: number;
    finalWeightOutKg: number | null;
    gapKg: number | null;
    gapPct: number | null;
    explained: boolean;
  };
  proof: {
    merkleRoot: string | null;
    recomputedRoot: string | null;
    rootMatchesSealedValue: boolean;
    allProofsValid: boolean;
    leafHashAlgorithm: string;
    nodeHashAlgorithm: string;
    ordering: string;
  };
  onChain: {
    network: string;
    stellarTxHash: string;
    stellarLedger: number;
    dataEntryKey: string;
    anchoredAt: string;
    explorerUrl: string;
    /** What Horizon said when the report was rendered; null means we could not ask. */
    ledgerConfirmation: {
      rootMatchesLedger: boolean | null;
      memoMatches: boolean;
      dataEntryMatches: boolean;
      checkedAt: string;
      detail: string;
    };
  } | null;
  events: {
    eventId: string;
    collectorName: string;
    weightKg: number;
    material: string;
    capturedAt: string;
    photoHash: string;
    photoAvailable: boolean;
    /** Relative to the backend origin; null until the bytes are uploaded. */
    photoUrl: string | null;
    payloadHash: string;
    leaf: string;
    integrityOutcome: string;
  }[];
  attestationNotes: string[];
}

export interface AwaitingAnchor {
  batchId: string;
  sealedAt: string | null;
  totalWeightKg: number;
  eventCount: number;
  failedAttempts: number;
  lastOutcome: "failed" | "unverified" | "succeeded" | null;
  lastAttemptAt: string | null;
  lastDetail: string | null;
  nextAttemptAt: string | null;
  stuck: boolean;
}

export interface AnchorHealth {
  checkedAt: string;
  awaitingAnchor: number;
  stuck: number;
  unanchoredWeightKg: number;
  batches: AwaitingAnchor[];
}

export interface AnchorAttempt {
  id: string;
  attemptNumber: number;
  outcome: "failed" | "unverified" | "succeeded";
  detail: string | null;
  stellarTxHash: string | null;
  occurredAt: string;
}

export interface Material {
  code: string;
  name: string;
  description: string | null;
  /** Products a collector would recognise this material as. Never null. */
  examples: string[];
  active: boolean;
  sortOrder: number;
}

export interface CurrentUser {
  id: string;
  email: string;
  role: "admin" | "operator" | "auditor";
}

export const api = {
  anchorHealth: () => request<AnchorHealth>("/batches/anchor-health"),
  me: () => request<CurrentUser>("/auth/me"),
  materials: () => request<Material[]>("/materials"),
  createMaterial: (body: {
    code: string;
    name: string;
    description?: string;
    examples?: string[];
    sortOrder?: number;
  }) => request<Material>("/materials", { method: "POST", body: JSON.stringify(body) }),
  updateMaterial: (
    code: string,
    body: {
      name?: string;
      description?: string;
      examples?: string[];
      active?: boolean;
      sortOrder?: number;
    },
  ) => request<Material>(`/materials/${code}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteMaterial: (code: string) =>
    request<{ code: string; deleted: true }>(`/materials/${code}`, { method: "DELETE" }),
  anchorAttempts: (id: string) => request<AnchorAttempt[]>(`/batches/${id}/anchor-attempts`),
  listBatches: (status?: string) =>
    request<Batch[]>(`/batches${status ? `?status=${status}` : ""}`),
  getBatch: (id: string) => request<Batch>(`/batches/${id}`),
  batchEvents: (id: string) => request<CollectionEvent[]>(`/batches/${id}/events`),
  listEvents: (query: string) => request<CollectionEvent[]>(`/events?${query}`),
  report: (id: string) => request<AuditReport>(`/batches/${id}/report`),
  hubs: () => request<{ id: string; code: string; name: string }[]>("/hubs"),
  collectors: () => request<{ id: string; name: string }[]>("/collectors"),
};

export function kg(value: string | number): number {
  return Number(value);
}
