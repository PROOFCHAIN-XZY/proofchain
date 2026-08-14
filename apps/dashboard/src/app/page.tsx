import { Fragment } from "react";
import Link from "next/link";
import { api, ApiError, kg, type AnchorHealth } from "@/lib/api";
import { batchTone, formatDateTime, formatKg, shortHash } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function BatchesPage() {
  let batches;
  try {
    batches = await api.listBatches();
  } catch (error) {
    const unauthorised =
      error instanceof ApiError && (error.status === 401 || error.status === 403);
    return (
      <main>
        <div className="page-head">
          <div>
            <p className="eyebrow">Collection hub</p>
            <h1>Batches</h1>
          </div>
        </div>
        <p className="error">
          {unauthorised ? (
            <>
              Not signed in. <Link href="/login">Sign in</Link> to see batches.
            </>
          ) : (
            "Could not reach the backend. Is it running on :3000?"
          )}
        </p>
      </main>
    );
  }

  // A failing anchor pipeline is the one problem on this page that nobody
  // discovers by looking at it: a stuck batch and a freshly sealed one both
  // read as "awaiting anchor" in the table below. Fetched separately so a
  // failure here degrades the banner rather than the page.
  let health: AnchorHealth | null = null;
  try {
    health = await api.anchorHealth();
  } catch {
    health = null;
  }

  const anchored = batches.filter((b) => b.anchor).length;
  const totalKg = batches.reduce((sum, b) => sum + kg(b.totalWeightKg), 0);

  return (
    <main>
      <div className="page-head">
        <div>
          <p className="eyebrow">Collection hub</p>
          <h1>Batches</h1>
        </div>
        <p className="note" style={{ margin: 0 }}>
          A batch becomes evidence at seal. Anchoring puts its Merkle root on Stellar.
        </p>
      </div>

      <dl className="stats">
        <div className="stat">
          <dt>Batches</dt>
          <dd>{batches.length}</dd>
        </div>
        <div className="stat">
          <dt>Anchored</dt>
          <dd>
            {anchored}
            <small> / {batches.length}</small>
          </dd>
        </div>
        <div className="stat">
          <dt>Collected</dt>
          <dd>
            {formatKg(totalKg)}
            <small> kg</small>
          </dd>
        </div>
        <div className="stat">
          <dt>Tonnes</dt>
          <dd>{(totalKg / 1000).toFixed(4)}</dd>
        </div>
      </dl>

      {health && health.stuck > 0 && (
        <div className="proof" data-state="broken">
          <h3>
            {health.stuck} batch{health.stuck === 1 ? "" : "es"} cannot be anchored
          </h3>
          <dl>
            {health.batches
              .filter((b) => b.stuck)
              .map((b) => (
                <Fragment key={b.batchId}>
                  <dt>
                    <Link href={`/batches/${b.batchId}`} className="hash">
                      {b.batchId.slice(0, 8)}
                    </Link>
                  </dt>
                  <dd>
                    {b.failedAttempts} failed attempt{b.failedAttempts === 1 ? "" : "s"} ·{" "}
                    {b.lastDetail ?? "no detail recorded"}
                  </dd>
                </Fragment>
              ))}
          </dl>
          <p className="note">
            These batches are sealed and their weight cannot be sold until a root reaches the
            ledger. See the runbook for the usual causes.
          </p>
        </div>
      )}

      <h2>All batches</h2>

      {batches.length === 0 ? (
        <p className="empty">No batches yet. Open one once weigh-ins have been captured.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Batch</th>
                <th>Material</th>
                <th>Status</th>
                <th className="num">Weigh-ins</th>
                <th className="num">Weight</th>
                <th>Merkle root</th>
                <th>Proof</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link href={`/batches/${b.id}`} className="hash">
                      {b.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{b.material}</td>
                  <td>
                    <span className="pill" data-tone={batchTone(b.status, Boolean(b.anchor))}>
                      {b.status}
                    </span>
                  </td>
                  <td className="num">{b.eventCount}</td>
                  <td className="num">{formatKg(b.totalWeightKg)} kg</td>
                  <td className="hash">{shortHash(b.merkleRoot, 8)}</td>
                  <td>
                    {b.anchor ? (
                      <span className="pill" data-tone="verified">
                        on Stellar
                      </span>
                    ) : b.status === "open" ? (
                      <span className="pill" data-tone="neutral">
                        not sealed
                      </span>
                    ) : (
                      <span className="pill" data-tone="pending">
                        awaiting anchor
                      </span>
                    )}
                  </td>
                  <td className="hash">{formatDateTime(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
