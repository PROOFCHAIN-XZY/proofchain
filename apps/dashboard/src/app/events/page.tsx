import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, formatKg, shortHash } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * The weigh-in feed, including quarantined records.
 *
 * Quarantined events are shown, never hidden: they are the raw material of fraud
 * detection and of the "% captured cleanly" pilot metric. An operator needs to
 * see a collector whose fixes keep landing outside the fence.
 */
export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ quarantined?: string }>;
}) {
  const { quarantined } = await searchParams;
  const onlyQuarantined = quarantined === "true";

  let events;
  try {
    events = await api.listEvents(
      onlyQuarantined ? "quarantined=true&limit=200" : "limit=200",
    );
  } catch (error) {
    const unauthorised = error instanceof ApiError && (error.status === 401 || error.status === 403);
    return (
      <main>
        <h1>Weigh-ins</h1>
        <p className="error">
          {unauthorised ? (
            <>
              Not signed in. <Link href="/login">Sign in</Link> to see weigh-ins.
            </>
          ) : (
            "Could not reach the backend."
          )}
        </p>
      </main>
    );
  }

  const clean = events.filter((e) => !e.quarantined).length;

  return (
    <main>
      <div className="page-head">
        <div>
          <p className="eyebrow">Field capture</p>
          <h1>Weigh-ins</h1>
        </div>
        <div className="actions no-print">
          <Link className="btn" href="/events">
            All
          </Link>
          <Link className="btn" href="/events?quarantined=true">
            Quarantined only
          </Link>
        </div>
      </div>

      <dl className="stats">
        <div className="stat">
          <dt>Shown</dt>
          <dd>{events.length}</dd>
        </div>
        <div className="stat">
          <dt>Clean</dt>
          <dd>{clean}</dd>
        </div>
        <div className="stat">
          <dt>Quarantined</dt>
          <dd>{events.length - clean}</dd>
        </div>
        <div className="stat">
          <dt>Capture rate</dt>
          <dd>
            {events.length === 0 ? "—" : ((clean / events.length) * 100).toFixed(1)}
            <small> %</small>
          </dd>
        </div>
      </dl>

      <h2>{onlyQuarantined ? "Quarantined weigh-ins" : "Recent weigh-ins"}</h2>

      {events.length === 0 ? (
        <p className="empty">Nothing captured yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Captured</th>
                <th className="num">Weight</th>
                <th>Material</th>
                <th>Integrity</th>
                <th>Failed checks</th>
                <th>Batch</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const failed = (e.integrity?.findings ?? []).filter((f) => f.outcome === "fail");
                return (
                  <tr key={e.id}>
                    <td className="hash">{formatDateTime(e.capturedAt)}</td>
                    <td className="num">{formatKg(e.weightKg)} kg</td>
                    <td>{e.material}</td>
                    <td>
                      <span
                        className="pill"
                        data-tone={
                          e.quarantined
                            ? "broken"
                            : e.integrity?.outcome === "warn"
                              ? "pending"
                              : "verified"
                        }
                      >
                        {e.quarantined ? "quarantined" : (e.integrity?.outcome ?? "unknown")}
                      </span>
                    </td>
                    <td className="hash">
                      {failed.length === 0
                        ? "—"
                        : failed.map((f) => f.check).join(", ")}
                    </td>
                    <td className="hash">
                      {e.batchId ? (
                        <Link href={`/batches/${e.batchId}`}>{e.batchId.slice(0, 8)}</Link>
                      ) : (
                        shortHash(null)
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
