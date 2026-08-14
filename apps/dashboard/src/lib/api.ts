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
  ) {
    super(message);
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
    throw new ApiError(`${init.method ?? "GET"} ${path} failed`, res.status);
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
  lat: number;
  lng: number;
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
  hub: { id: string; code: string; name: string; lat: number; lng: number };
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
    lat: number;
    lng: number;
    capturedAt: string;
    photoHash: string;
    payloadHash: string;
    leaf: string;
    integrityOutcome: string;
  }[];
  attestationNotes: string[];
}

export const api = {
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
