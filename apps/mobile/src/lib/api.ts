import * as queue from "./queue";
import type { QueuedWeighIn } from "./queue";
import type { KeyValueStore } from "./storage";

/**
 * Backend contract — identical in shape to the PWA's client. Both surfaces talk
 * to the same endpoints with the same retry semantics; divergence between them
 * would show up as weigh-ins that sync from one device type and not the other.
 */

export interface IngestResponse {
  eventId: string;
  payloadHash: string;
  quarantined: boolean;
  duplicate: boolean;
  integrity: {
    outcome: "pass" | "warn" | "fail";
    findings: { check: string; outcome: string; detail?: string }[];
  };
}

export interface SyncOutcome {
  attempted: number;
  synced: number;
  rejected: number;
  failed: number;
}

const BACKEND_KEY = "proofchain.backendUrl";
const DEFAULT_BACKEND = "http://10.0.2.2:3000"; // Android emulator's host loopback

export async function getBackendUrl(store: KeyValueStore): Promise<string> {
  return (await store.getItem(BACKEND_KEY)) ?? DEFAULT_BACKEND;
}

export async function setBackendUrl(store: KeyValueStore, url: string): Promise<void> {
  await store.setItem(BACKEND_KEY, url.trim().replace(/\/+$/, ""));
}

/** A field link can hang open indefinitely; fail fast and retry on the next pass. */
async function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function postWeighIn(
  backendUrl: string,
  record: Pick<QueuedWeighIn, "payload" | "signature">,
): Promise<IngestResponse> {
  const res = await postJson(`${backendUrl}/events`, {
    payload: record.payload,
    signature: record.signature,
  });

  if (res.status === 400 || res.status === 422) {
    // Malformed for this server version; retrying will never help.
    const body = await res.text();
    throw new Error(`rejected as invalid (${res.status}): ${body.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`server returned ${res.status}`);

  return (await res.json()) as IngestResponse;
}

function failureSummary(response: IngestResponse): string {
  return response.integrity.findings
    .filter((f) => f.outcome === "fail")
    .map((f) => `${f.check}${f.detail ? `: ${f.detail}` : ""}`)
    .join("; ");
}

/**
 * Drain the queue.
 *
 * A quarantined record is a settled answer, not a transport failure: the server
 * holds it but will never let it into a batch. It is marked rejected and shown
 * to the collector, because unpaid work they learn about now is work they can
 * still redo — re-weigh, or move inside the hub fence.
 */
export async function syncPending(
  store: KeyValueStore,
  deps: {
    isOnline: () => Promise<boolean>;
    post?: (backendUrl: string, record: QueuedWeighIn) => Promise<IngestResponse>;
  },
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { attempted: 0, synced: 0, rejected: 0, failed: 0 };

  if (!(await deps.isOnline())) return outcome;

  const backendUrl = await getBackendUrl(store);
  const post = deps.post ?? ((url, record) => postWeighIn(url, record));
  const records = await queue.pending(store);

  for (const record of records) {
    outcome.attempted += 1;
    await queue.update(store, record.id, { status: "syncing" });

    try {
      const response = await post(backendUrl, record);

      if (response.quarantined && !response.duplicate) {
        await queue.update(store, record.id, {
          status: "rejected",
          serverEventId: response.eventId,
          syncedAt: new Date().toISOString(),
          lastError: failureSummary(response),
        });
        outcome.rejected += 1;
        continue;
      }

      await queue.update(store, record.id, {
        status: "synced",
        serverEventId: response.eventId,
        syncedAt: new Date().toISOString(),
        lastError: null,
      });
      outcome.synced += 1;
    } catch (error) {
      // Back to `queued`, never dropped: the next pass will try again.
      await queue.update(store, record.id, {
        status: "queued",
        attempts: record.attempts + 1,
        lastError: (error as Error).message,
      });
      outcome.failed += 1;
    }
  }

  return outcome;
}

/**
 * Device provisioning.
 *
 * An operator signs in once, on this phone, to enrol its public key. The token is
 * used for that step and never persisted: a shared field phone must not carry
 * standing operator credentials. The weigh-in path needs none — the device
 * signature is the credential, which is also what lets capture work offline.
 */
export async function operatorLogin(
  backendUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await postJson(`${backendUrl}/auth/login`, { email, password });
  if (!res.ok) throw new Error("operator sign-in failed");

  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken;
}

async function authedGet<T>(backendUrl: string, path: string, token: string): Promise<T> {
  const res = await fetch(`${backendUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

export function fetchCollectors(
  backendUrl: string,
  token: string,
): Promise<{ id: string; name: string }[]> {
  return authedGet(backendUrl, "/collectors", token);
}

export function fetchHubs(
  backendUrl: string,
  token: string,
): Promise<{ id: string; code: string; name: string; lat: number; lng: number }[]> {
  return authedGet(backendUrl, "/hubs", token);
}

export async function enrolDevice(
  backendUrl: string,
  token: string,
  input: { collectorId: string; label: string; publicKeyBase64: string },
): Promise<{ deviceId: string }> {
  const res = await postJson(`${backendUrl}/devices`, input, token);
  if (!res.ok) throw new Error(`enrolment failed: ${await res.text()}`);

  const device = (await res.json()) as { id: string };
  return { deviceId: device.id };
}
