import Link from "next/link";
import { api, ApiError, BACKEND_URL } from "@/lib/api";
import { formatDateTime, formatKg, shortHash } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * The audit artifact.
 *
 * This page is the product. It is laid out to be printed to PDF and handed to a
 * PRO, verifier or credit buyer, so it states its own provenance, shows the
 * arithmetic, and is explicit about what the Stellar anchor does and does not
 * prove. Overclaiming here is the fastest way to lose a verifier's trust.
 */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let report;
  try {
    report = await api.report(id);
  } catch (error) {
    // This page is meant to be checkable by a third party who has no account, so
    // "no such batch" and "the backend is down" must not be collapsed into one
    // vague message — a verifier who cannot tell them apart cannot tell whether
    // the evidence is missing or merely unreachable.
    const status = error instanceof ApiError ? error.status : null;

    const explanation =
      status === 404
        ? "No batch exists with this identifier."
        : status === 401 || status === 403
          ? "This report is not publicly readable. Sign in as an operator to view it."
          : "The reporting service could not be reached. This says nothing about the validity of the batch — try again shortly.";

    return (
      <main>
        <h1>Audit report</h1>
        <p className="error">{explanation}</p>
        <p className="note">
          Batch <span className="hash">{id}</span>
          {status === null ? "" : ` · HTTP ${status}`}
        </p>
        <p className="no-print">
          <Link className="btn" href="/">
            ← All batches
          </Link>
        </p>
      </main>
    );
  }

  const proofState = !report.proof.merkleRoot
    ? "pending"
    : report.proof.rootMatchesSealedValue && report.proof.allProofsValid && report.onChain
      ? "verified"
      : report.proof.rootMatchesSealedValue && report.proof.allProofsValid
        ? "pending"
        : "broken";

  const csvHref = `${process.env.NEXT_PUBLIC_BACKEND_URL ?? BACKEND_URL}/batches/${id}/report/events.csv`;
  const jsonHref = `${process.env.NEXT_PUBLIC_BACKEND_URL ?? BACKEND_URL}/batches/${id}/report`;

  return (
    <main>
      <div className="page-head">
        <div>
          <p className="eyebrow">
            {report.reportVersion} · generated {formatDateTime(report.generatedAt)}
          </p>
          <h1>Chain-of-custody &amp; verification report</h1>
        </div>
        <div className="actions no-print">
          <Link className="btn" href={`/batches/${id}`}>
            ← Batch
          </Link>
          <a className="btn" href={csvHref}>
            CSV
          </a>
          <a className="btn" href={jsonHref} target="_blank" rel="noreferrer noopener">
            JSON
          </a>
        </div>
      </div>

      <p className="note no-print">
        Print this page (Ctrl/Cmd+P → Save as PDF) to produce the artifact for a verifier. Links
        expand to full URLs in print so the printed copy stays independently checkable.
      </p>

      <h2>Summary</h2>
      <dl className="stats">
        <div className="stat">
          <dt>Material</dt>
          <dd style={{ fontSize: "1.25rem" }}>{report.batch.material}</dd>
        </div>
        <div className="stat">
          <dt>Weigh-ins</dt>
          <dd>{report.batch.eventCount}</dd>
        </div>
        <div className="stat">
          <dt>Net weight</dt>
          <dd>
            {formatKg(report.batch.totalWeightKg)}
            <small> kg</small>
          </dd>
        </div>
        <div className="stat">
          <dt>Tonnes</dt>
          <dd>{report.batch.totalWeightTonnes.toFixed(4)}</dd>
        </div>
        <div className="stat">
          <dt>Sealed</dt>
          <dd style={{ fontSize: "0.8125rem" }}>{formatDateTime(report.batch.sealedAt)}</dd>
        </div>
      </dl>

      <h2>Verification</h2>
      <div className="proof" data-state={proofState}>
        <h3>
          {proofState === "verified"
            ? "Independently verifiable against the Stellar ledger"
            : proofState === "pending"
              ? "Sealed and internally consistent — not yet anchored on-chain"
              : proofState === "broken"
                ? "INCONSISTENT — do not rely on this batch"
                : "Not sealed"}
        </h3>
        <dl>
          <dt>Sealed root</dt>
          <dd>{report.proof.merkleRoot ?? "—"}</dd>
          <dt>Recomputed</dt>
          <dd>{report.proof.recomputedRoot ?? "—"}</dd>
          <dt>Roots agree</dt>
          <dd>{report.proof.rootMatchesSealedValue ? "yes" : "NO"}</dd>
          <dt>All proofs</dt>
          <dd>{report.proof.allProofsValid ? "valid" : "INVALID"}</dd>
          <dt>Leaf hash</dt>
          <dd>{report.proof.leafHashAlgorithm}</dd>
          <dt>Node hash</dt>
          <dd>{report.proof.nodeHashAlgorithm}</dd>
          <dt>Ordering</dt>
          <dd>{report.proof.ordering}</dd>
          {report.onChain ? (
            <>
              <dt>Network</dt>
              <dd>Stellar {report.onChain.network}</dd>
              <dt>Transaction</dt>
              <dd>
                <a href={report.onChain.explorerUrl} target="_blank" rel="noreferrer noopener">
                  {report.onChain.stellarTxHash}
                </a>
              </dd>
              <dt>Ledger</dt>
              <dd>{report.onChain.stellarLedger}</dd>
              <dt>Data entry</dt>
              <dd>{report.onChain.dataEntryKey}</dd>
              <dt>Anchored at</dt>
              <dd>{formatDateTime(report.onChain.anchoredAt)}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <h2>Collection hub</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <th style={{ width: "12rem" }}>Hub</th>
              <td>
                {report.hub.name} ({report.hub.code})
              </td>
            </tr>
            <tr>
              <th>Coordinates</th>
              <td className="hash">
                {report.hub.lat.toFixed(6)}, {report.hub.lng.toFixed(6)}
              </td>
            </tr>
            <tr>
              <th>Batch id</th>
              <td className="hash">{report.batch.id}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Collectors</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Collector</th>
              <th>KYC</th>
              <th className="num">Weigh-ins</th>
              <th className="num">Weight</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {report.collectors.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>
                  <span className="pill" data-tone={c.kycLevel === "none" ? "pending" : "neutral"}>
                    {c.kycLevel}
                  </span>
                </td>
                <td className="num">{c.eventCount}</td>
                <td className="num">{formatKg(c.weightKg)} kg</td>
                <td className="num">
                  {report.batch.totalWeightKg === 0
                    ? "—"
                    : `${((c.weightKg / report.batch.totalWeightKg) * 100).toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Chain of custody</h2>
      {report.chainOfCustody.length === 0 ? (
        <p className="empty">No custody transfers recorded for this batch.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Transferred</th>
                <th>From</th>
                <th>To</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th className="num">Variance</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {report.chainOfCustody.map((t) => (
                <tr key={t.id}>
                  <td className="hash">{formatDateTime(t.transferredAt)}</td>
                  <td>{t.fromParty}</td>
                  <td>{t.toParty}</td>
                  <td className="num">{formatKg(t.weightInKg)}</td>
                  <td className="num">{formatKg(t.weightOutKg)}</td>
                  <td className="num">
                    {formatKg(t.varianceKg)}
                    {t.variancePct === null ? "" : ` (${t.variancePct}%)`}
                  </td>
                  <td>{t.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Reconciliation</h2>
      <dl className="stats">
        <div className="stat">
          <dt>Collected in</dt>
          <dd>
            {formatKg(report.reconciliation.collectedKg)}
            <small> kg</small>
          </dd>
        </div>
        <div className="stat">
          <dt>Processed out</dt>
          <dd>
            {report.reconciliation.finalWeightOutKg === null
              ? "—"
              : formatKg(report.reconciliation.finalWeightOutKg)}
            <small> kg</small>
          </dd>
        </div>
        <div className="stat">
          <dt>Gap</dt>
          <dd>
            {report.reconciliation.gapKg === null ? "—" : formatKg(report.reconciliation.gapKg)}
            <small> kg</small>
          </dd>
        </div>
        <div className="stat">
          <dt>Gap %</dt>
          <dd>{report.reconciliation.gapPct === null ? "—" : `${report.reconciliation.gapPct}`}</dd>
        </div>
        <div className="stat">
          <dt>Explained</dt>
          <dd style={{ fontSize: "1.0625rem" }}>
            <span className="pill" data-tone={report.reconciliation.explained ? "verified" : "broken"}>
              {report.reconciliation.explained ? "yes" : "no"}
            </span>
          </dd>
        </div>
      </dl>

      <h2>Weigh-in log</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Captured (UTC)</th>
              <th>Collector</th>
              <th className="num">Weight</th>
              <th>Location</th>
              <th>Photo sha256</th>
              <th>Merkle leaf</th>
              <th>Integrity</th>
            </tr>
          </thead>
          <tbody>
            {report.events.map((e, index) => (
              <tr key={e.eventId}>
                <td className="num">{index + 1}</td>
                <td className="hash">{e.capturedAt}</td>
                <td>{e.collectorName}</td>
                <td className="num">{formatKg(e.weightKg)} kg</td>
                <td className="hash">
                  {e.lat.toFixed(6)}, {e.lng.toFixed(6)}
                </td>
                <td className="hash">{shortHash(e.photoHash, 8)}</td>
                <td className="hash">{shortHash(e.leaf, 8)}</td>
                <td>
                  <span
                    className="pill"
                    data-tone={e.integrityOutcome === "pass" ? "verified" : "pending"}
                  >
                    {e.integrityOutcome}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Basis of attestation</h2>
      <ol className="note" style={{ paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
        {report.attestationNotes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ol>

      <p className="note" style={{ marginTop: "2rem", borderTop: "1px solid var(--rule)", paddingTop: "1rem" }}>
        To verify independently: recompute each leaf as sha256(0x00 ‖ payloadHash), combine pairs as
        sha256(0x01 ‖ left ‖ right) in the stated order, and compare the resulting root against the
        memo hash of the Stellar transaction above. The full event list, including every payload
        hash, is available as CSV and JSON without an account.
      </p>
    </main>
  );
}
