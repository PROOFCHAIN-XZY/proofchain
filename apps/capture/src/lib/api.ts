import * as queue from "./queue";
import type { QueuedWeighIn } from "./queue";

/**
 * Sync: drain the offline queue to the backend.
 *
 * Retries are safe by construction. The server keys events on the payload hash
 * with a unique index, so re-sending a record it already holds returns the
 * original event rather than creating a duplicate — which means we can retry
 * aggressively without ever double-counting a tonne.
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

export function backendUrl(): string {
  return localStorage.getItem("proofchain.backendUrl") ?? "http://localhost:3000";
}

export function setBackendUrl(url: string): void {
  localStorage.setItem("proofchain.backendUrl", url.replace(/\/+$/, ""));
}

export interface SyncOutcome {
  attempted: number;
  synced: number;
  rejected: number;
  failed: number;
  /** Photos successfully handed over after their weigh-in was accepted. */
  photosUploaded: number;
}

/**
 * Send the photo bytes for an accepted weigh-in.
 *
 * Separate from the weigh-in POST on purpose. The signed record is a few
 * hundred bytes and the photo is several megabytes; on a field link the record
 * must be able to land on its own, because it is the part that carries the
 * weight, the location and the signature. Sending them together would mean a
 * collector on a bad connection ends the day with nothing recorded at all.
 *
 * The server accepts these bytes only if they hash to the photoHash already
 * signed into the payload, so no credential is needed and a corrupted upload
 * is rejected rather than stored.
 */
export async function uploadPhoto(eventId: string, photo: Blob): Promise<void> {
  const controller = new AbortController();
  // Longer than the weigh-in timeout: this is megabytes over a link that may
  // be barely usable, and giving up early would retry the whole transfer.
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(`${backendUrl()}/events/${eventId}/photo`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: photo,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`photo upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncPending(): Promise<SyncOutcome> {
  const outcome: SyncOutcome = {
    attempted: 0,
    synced: 0,
    rejected: 0,
    failed: 0,
    photosUploaded: 0,
  };

  if (!navigator.onLine) return outcome;

  const records = await queue.pending();

  for (const record of records) {
    outcome.attempted += 1;
    await queue.update(record.id, { status: "syncing" });

    try {
      const response = await postWeighIn(record);

      if (response.quarantined && !response.duplicate) {
        // The server took the record but will never let it into a batch. Surface
        // it to the collector: a rejected weigh-in is unpaid work they can still
        // fix (move inside the fence, re-weigh) if they learn about it now.
        await queue.update(record.id, {
          status: "rejected",
          serverEventId: response.eventId,
          syncedAt: new Date().toISOString(),
          lastError: failureSummary(response),
        });
        outcome.rejected += 1;
        continue;
      }

      // The weigh-in is safe on the server before the photo is attempted. The
      // record is marked synced either way: a missing photo is a weaker piece
      // of evidence, not a lost tonne, and re-posting the weigh-in to retry the
      // photo would be spending a field connection on a duplicate.
      const photoUploaded = await tryUploadPhoto(record, response.eventId);

      await queue.update(record.id, {
        status: "synced",
        serverEventId: response.eventId,
        syncedAt: new Date().toISOString(),
        photoUploadedAt: photoUploaded ? new Date().toISOString() : null,
        lastError: photoUploaded ? null : "weigh-in synced; photo upload still pending",
      });
      outcome.synced += 1;
      if (photoUploaded) outcome.photosUploaded += 1;
    } catch (error) {
      await queue.update(record.id, {
        status: "queued",
        attempts: record.attempts + 1,
        lastError: (error as Error).message,
      });
      outcome.failed += 1;
    }
  }

  return outcome;
}

/** Never throws: a failed photo must not undo an accepted weigh-in. */
async function tryUploadPhoto(record: QueuedWeighIn, eventId: string): Promise<boolean> {
  if (!record.photo || record.photoUploadedAt) return Boolean(record.photoUploadedAt);

  try {
    await uploadPhoto(eventId, record.photo);
    return true;
  } catch {
    return false;
  }
}

function failureSummary(response: IngestResponse): string {
  return response.integrity.findings
    .filter((f) => f.outcome === "fail")
    .map((f) => `${f.check}${f.detail ? `: ${f.detail}` : ""}`)
    .join("; ");
}

async function postWeighIn(record: QueuedWeighIn): Promise<IngestResponse> {
  const controller = new AbortController();
  // A field link can hang open indefinitely; fail fast and retry later instead.
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(`${backendUrl()}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: record.payload, signature: record.signature }),
      signal: controller.signal,
    });

    if (res.status === 400 || res.status === 422) {
      // Malformed for this server version; retrying will never help.
      const body = await res.text();
      throw new Error(`rejected as invalid (${res.status}): ${body.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`server returned ${res.status}`);
    }

    return (await res.json()) as IngestResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Device provisioning.
 *
 * An operator signs in once, on this phone, to enrol its public key. The token
 * lives only for the duration of that provisioning step and is never persisted —
 * a shared field phone must not carry standing operator credentials, and the
 * weigh-in path deliberately does not need any (the device signature is the
 * credential, which is also what keeps capture working offline).
 */
export async function operatorLogin(email: string, password: string): Promise<string> {
  const res = await fetch(`${backendUrl()}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("operator sign-in failed");

  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken;
}

async function authedGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${backendUrl()}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

export function fetchCollectors(token: string): Promise<{ id: string; name: string }[]> {
  return authedGet("/collectors", token);
}

export function fetchHubs(
  token: string,
): Promise<
  { id: string; code: string; name: string; lat: number; lng: number; geofenceRadiusM: number }[]
> {
  return authedGet("/hubs", token);
}

export async function enrolDevice(
  token: string,
  input: { collectorId: string; label: string; publicKeyBase64: string },
): Promise<{ deviceId: string }> {
  const res = await fetch(`${backendUrl()}/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`enrolment failed: ${await res.text()}`);

  const device = (await res.json()) as { id: string };
  return { deviceId: device.id };
}
