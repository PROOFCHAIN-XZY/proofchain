import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  api,
  ApiError,
  BACKEND_URL,
  TOKEN_COOKIE,
  kg,
  type AnchorAttempt,
  type AwaitingAnchor,
} from "@/lib/api";
import { batchTone, formatDateTime, formatKg, shortHash } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Operator actions live here as server actions so the token never leaves the
 * server. Sealing is irreversible, which the UI states plainly rather than
 * hiding behind a generic button.
 */
async function mutate(path: string, body?: unknown): Promise<string | null> {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });

  if (res.ok) return null;

  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { message?: string | string[] };
    const message = parsed.message;
    return Array.isArray(message) ? message.join("; ") : (message ?? text);
  } catch {
    return text.slice(0, 300);
  }
}

export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  async function sealBatch() {
    "use server";
    const failure = await mutate(`/batches/${id}/seal`);
    revalidatePath(`/batches/${id}`);
    if (failure) redirect(`/batches/${id}?error=${encodeURIComponent(failure)}`);
  }

  async function advance(formData: FormData) {
    "use server";
    const status = String(formData.get("status") ?? "");
    const failure = await mutate(`/batches/${id}/status`, { status });
    revalidatePath(`/batches/${id}`);
    if (failure) redirect(`/batches/${id}?error=${encodeURIComponent(failure)}`);
  }

  let batch;
  let events;
  try {
    [batch, events] = await Promise.all([api.getBatch(id), api.batchEvents(id)]);
  } catch (err) {
    const unauthorised = err instanceof ApiError && (err.status === 401 || err.status === 403);
    return (
      <main>
        <h1>Batch</h1>
        <p className="error">
          {unauthorised ? (
            <>
              Not signed in. <Link href="/login">Sign in</Link> to view this batch.
            </>
          ) : (
            "Batch not found, or the backend is unreachable."
          )}
        </p>
      </main>
    );
  }

  const anchored = Boolean(batch.anchor);

  // Only asked for when it can say something: an unsealed batch has nothing to
  // anchor yet. An *anchored* one still can — a batch that took nine attempts
  // is worth showing after it succeeds, which the health view cannot do because
  // it drops the batch on success.
  let awaiting: AwaitingAnchor | null = null;
  let attempts: AnchorAttempt[] = [];
  if (batch.merkleRoot) {
    try {
      attempts = await api.anchorAttempts(batch.id);
      if (!anchored) {
        const health = await api.anchorHealth();
        awaiting = health.batches.find((b) => b.batchId === batch.id) ?? null;
      }
    } catch {
      // Anchor history is context, never the point of the page.
      attempts = [];
    }
  }
  const collectedKg = events.reduce((sum, e) => sum + kg(e.weightKg), 0);

  return (
    <main>
      <div className="page-head">
        <div>
          <p className="eyebrow">Batch {batch.id}</p>
          <h1>
            {batch.material} · {formatKg(batch.totalWeightKg)} kg
          </h1>
        </div>
        <div className="actions no-print">
          <Link className="btn" href={`/batches/${batch.id}/report`}>
            Audit report
          </Link>
          {batch.status === "open" ? (
            /* Sealing freezes membership and fixes the Merkle root, and there is
               no unseal. The disclosure forces a second, deliberate click without
               dragging client-side JavaScript into an otherwise server-rendered
               page — which also means the guard still works with JS disabled. */
            <details className="confirm">
              <summary className="btn" data-variant="primary">
                Seal batch
              </summary>
              <div className="confirm-body">
                <p>
                  Sealing freezes this batch&rsquo;s {batch.eventCount} weigh-ins and computes the
                  Merkle root that will be anchored on-chain. It cannot be undone.
                </p>
                <form action={sealBatch}>
                  <button className="btn" data-variant="primary" type="submit">
                    Confirm seal
                  </button>
                </form>
              </div>
            </details>
          ) : null}
          {batch.status === "sealed" || batch.status === "processed" ? (
            <form action={advance}>
              <input
                type="hidden"
                name="status"
                value={batch.status === "sealed" ? "processed" : "sold"}
              />
              <button className="btn" type="submit">
                Mark {batch.status === "sealed" ? "processed" : "sold"}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {error ? <p className="error">{decodeURIComponent(error)}</p> : null}

      {batch.status === "open" ? (
        <p className="note no-print">
          Sealing freezes membership and computes the Merkle root. It cannot be undone — events
          cannot be added or removed afterwards, which is exactly what makes the root worth
          anchoring.
        </p>
      ) : null}

      <dl className="stats" style={{ marginTop: "1.5rem" }}>
        <div className="stat">
          <dt>Status</dt>
          <dd style={{ fontSize: "1.0625rem" }}>
            <span className="pill" data-tone={batchTone(batch.status, anchored)}>
              {batch.status}
            </span>
          </dd>
        </div>
        <div className="stat">
          <dt>Weigh-ins</dt>
          <dd>{events.length}</dd>
        </div>
        <div className="stat">
          <dt>Collected</dt>
          <dd>
            {formatKg(collectedKg)}
            <small> kg</small>
          </dd>
        </div>
        <div className="stat">
          <dt>Tonnes</dt>
          <dd>{(collectedKg / 1000).toFixed(4)}</dd>
        </div>
        <div className="stat">
          <dt>Sealed</dt>
          <dd style={{ fontSize: "0.8125rem" }}>{formatDateTime(batch.sealedAt)}</dd>
        </div>
      </dl>

      <h2>Proof status</h2>
      <div
        className="proof"
        data-state={
          anchored
            ? "verified"
            : awaiting?.stuck
              ? "broken"
              : batch.merkleRoot
                ? "pending"
                : undefined
        }
      >
        <h3>
          {anchored
            ? "Anchored on Stellar"
            : awaiting?.stuck
              ? "Sealed — anchoring is failing"
              : batch.merkleRoot
                ? "Sealed — awaiting the anchor worker"
                : "Not sealed"}
        </h3>
        <dl>
          <dt>Merkle root</dt>
          <dd>{batch.merkleRoot ?? "not computed until the batch is sealed"}</dd>
          {batch.anchor ? (
            <>
              <dt>Stellar tx</dt>
              <dd>
                <a
                  href={`https://stellar.expert/explorer/${batch.anchor.network === "public" ? "public" : "testnet"}/tx/${batch.anchor.stellarTxHash}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {batch.anchor.stellarTxHash}
                </a>
              </dd>
              <dt>Ledger</dt>
              <dd>{String(batch.anchor.stellarLedger)}</dd>
              <dt>Anchored</dt>
              <dd>{formatDateTime(batch.anchor.anchoredAt)}</dd>
            </>
          ) : null}
          {awaiting && awaiting.failedAttempts > 0 ? (
            <>
              <dt>Failed attempts</dt>
              <dd>{awaiting.failedAttempts}</dd>
              <dt>Last attempt</dt>
              <dd>
                {/*
                  The raw error, not a category. An operator chasing a stuck
                  batch needs what Horizon actually said — an unfunded account
                  and a bad sequence number are both "anchoring failed" and
                  have nothing else in common.
                */}
                {awaiting.lastOutcome} · {awaiting.lastDetail ?? "no detail recorded"}
                {awaiting.lastAttemptAt ? ` (${formatDateTime(awaiting.lastAttemptAt)})` : ""}
              </dd>
              <dt>Next attempt</dt>
              <dd>{awaiting.nextAttemptAt ? formatDateTime(awaiting.nextAttemptAt) : "due now"}</dd>
            </>
          ) : null}
        </dl>
      </div>

      {attempts.length > 0 && (
        <>
          <h2>Anchoring history</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>When</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.id}>
                    <td className="num">{a.attemptNumber}</td>
                    <td className="hash">{formatDateTime(a.occurredAt)}</td>
                    <td>
                      <span
                        className="pill"
                        data-tone={a.outcome === "succeeded" ? "verified" : "pending"}
                      >
                        {a.outcome}
                      </span>
                    </td>
                    <td>
                      {a.detail ?? "—"}
                      {/*
                        An unverified attempt may have cost a real fee and the
                        transaction may still settle, so the hash is the first
                        thing an operator needs to go and check.
                      */}
                      {a.stellarTxHash ? (
                        <>
                          {" "}
                          <span className="hash">{shortHash(a.stellarTxHash, 8)}</span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Weigh-ins in this batch</h2>
      {events.length === 0 ? (
        <p className="empty">No weigh-ins assigned to this batch yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Captured</th>
                <th className="num">Weight</th>
                <th>Location</th>
                <th>Integrity</th>
                <th>Payload hash</th>
                <th>Verify</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="hash">{formatDateTime(e.capturedAt)}</td>
                  <td className="num">{formatKg(e.weightKg)} kg</td>
                  <td className="hash">
                    {e.lat.toFixed(5)}, {e.lng.toFixed(5)}
                  </td>
                  <td>
                    <span
                      className="pill"
                      data-tone={e.integrity?.outcome === "pass" ? "verified" : "pending"}
                    >
                      {e.integrity?.outcome ?? "unknown"}
                    </span>
                  </td>
                  <td className="hash">{shortHash(e.payloadHash, 8)}</td>
                  <td>
                    {batch.merkleRoot ? (
                      <a
                        className="hash"
                        href={`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3000"}/batches/${batch.id}/verify/${e.id}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        proof →
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
