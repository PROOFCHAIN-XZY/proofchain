import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api, ApiError, type CurrentUser, type Material } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * The material catalogue, administered.
 *
 * The one thing this page has to teach, and does so in the copy rather than in a
 * help doc: a material code is signed into weigh-in payloads and anchored on the
 * ledger, so it can be retired but never renamed or deleted once used. Every
 * control here is shaped by that. There is no rename field for a code. "Remove"
 * offers retirement first and outright deletion only where it is provably safe.
 */

async function addMaterial(formData: FormData) {
  "use server";

  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const examples = parseExamples(String(formData.get("examples") ?? ""));
  const sortOrder = String(formData.get("sortOrder") ?? "").trim();

  try {
    await api.createMaterial({
      code,
      name,
      ...(description ? { description } : {}),
      ...(examples.length > 0 ? { examples } : {}),
      ...(sortOrder ? { sortOrder: Number(sortOrder) } : {}),
    });
  } catch (error) {
    redirect(`/materials?error=${encodeURIComponent(messageOf(error))}`);
  }

  revalidatePath("/materials");
  redirect(`/materials?added=${encodeURIComponent(code.toUpperCase())}`);
}

async function editMaterial(formData: FormData) {
  "use server";

  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  // Sent unconditionally, unlike on create: the field is always in the form, so
  // an emptied box means "remove these products" and must reach the backend as
  // an empty array rather than being dropped as absent.
  const examples = parseExamples(String(formData.get("examples") ?? ""));

  try {
    await api.updateMaterial(code, { name, description, examples });
  } catch (error) {
    redirect(`/materials?error=${encodeURIComponent(messageOf(error))}`);
  }

  revalidatePath("/materials");
  redirect("/materials");
}

async function setActive(formData: FormData) {
  "use server";

  const code = String(formData.get("code") ?? "");
  const active = String(formData.get("active") ?? "") === "true";

  try {
    await api.updateMaterial(code, { active });
  } catch (error) {
    redirect(`/materials?error=${encodeURIComponent(messageOf(error))}`);
  }

  revalidatePath("/materials");
  redirect("/materials");
}

async function deleteMaterial(formData: FormData) {
  "use server";

  const code = String(formData.get("code") ?? "");

  try {
    await api.deleteMaterial(code);
  } catch (error) {
    // The expected failure: the code is in use. The backend's message names the
    // counts and points at retirement, so it is shown verbatim.
    redirect(`/materials?error=${encodeURIComponent(messageOf(error))}`);
  }

  revalidatePath("/materials");
  redirect(`/materials?deleted=${encodeURIComponent(code)}`);
}

/**
 * Split the one input an admin types into the product list the API takes.
 *
 * Commas and newlines both separate, because a comma-separated line and one
 * product per line are both obvious ways to fill this in and neither should be
 * the wrong guess. Bounds are the backend's to enforce — it normalises the same
 * list on arrival and says plainly what it rejected, and a second set of limits
 * here would only drift from that one.
 */
function parseExamples(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter((entry) => entry.length > 0);
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail ?? `Request failed (${error.status}).`;
  }
  return "Could not reach the backend.";
}

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; added?: string; deleted?: string }>;
}) {
  const { error, added, deleted } = await searchParams;

  /**
   * Who is asking has to be established separately, because `GET /materials` is
   * public — the capture apps hold no credentials and still need the catalogue.
   * Without this the page would render its Add and Retire controls to an
   * anonymous visitor, every one of which would then 403 on submit.
   *
   * The catalogue itself stays visible to any signed-in role: an auditor reading
   * a report legitimately wants to know that PS means polystyrene. Only the
   * controls are admin-gated, matching what the backend enforces.
   */
  let materials: Material[];
  let viewer: CurrentUser | null = null;
  try {
    [materials, viewer] = await Promise.all([api.materials(), api.me().catch(() => null)]);
  } catch {
    return (
      <main>
        <h1>Materials</h1>
        <p className="error">Could not reach the backend.</p>
      </main>
    );
  }

  if (!viewer) {
    return (
      <main>
        <h1>Materials</h1>
        <p className="error">
          Not signed in. <Link href="/login">Sign in</Link> to see the material catalogue.
        </p>
      </main>
    );
  }

  const canEdit = viewer.role === "admin";
  const active = materials.filter((m) => m.active);
  const retired = materials.filter((m) => !m.active);

  return (
    <main>
      <div className="page-head">
        <div>
          <p className="eyebrow">Catalogue</p>
          <h1>Materials</h1>
        </div>
      </div>

      <p className="note">
        A material <strong>code</strong> is signed into every weigh-in payload and hashed into the
        Merkle root anchored on the ledger. It can never be renamed or deleted once a collector has
        signed it — doing so would invalidate the audit report of every batch containing it. The{" "}
        <strong>name</strong>, the field guidance and the <strong>products</strong> list are
        presentation only and safe to change at any time — the products are what the capture apps
        show a collector so they can tell what a code covers without knowing the resin names.
        Retiring a material hides it from the capture apps and leaves every stored weigh-in
        untouched.
      </p>

      {error ? <p className="error">{error}</p> : null}
      {added ? <p className="note">Added {added}. It is now offered in the capture apps.</p> : null}
      {deleted ? <p className="note">Deleted {deleted}. It had never been used.</p> : null}

      <dl className="stats">
        <div className="stat">
          <dt>Offered</dt>
          <dd>{active.length}</dd>
        </div>
        <div className="stat">
          <dt>Retired</dt>
          <dd>{retired.length}</dd>
        </div>
      </dl>

      {canEdit ? null : (
        <p className="note">Read-only: changing the catalogue requires an administrator account.</p>
      )}

      <h2>Offered for capture</h2>
      {active.length === 0 ? (
        <p className="empty">
          Nothing is offered. The capture apps will fall back to their built-in list until at least
          one material is active.
        </p>
      ) : (
        <MaterialTable materials={active} canEdit={canEdit} />
      )}

      {retired.length > 0 ? (
        <>
          <h2>Retired</h2>
          <p className="note">
            Not offered for new capture. Still valid in every weigh-in and batch that already
            carries the code, and still verifiable by an auditor.
          </p>
          <MaterialTable materials={retired} canEdit={canEdit} />
        </>
      ) : null}

      {canEdit ? (
        <>
          <h2>Add a material</h2>
          <form action={addMaterial} className="confirm-body">
            <label htmlFor="code">
              Code — permanent, uppercase, 2–16 characters
              <input id="code" name="code" required maxLength={16} placeholder="PVC" />
            </label>
            <label htmlFor="name">
              Name — what collectors read, editable later
              <input
                id="name"
                name="name"
                required
                maxLength={120}
                placeholder="Pipe and profile"
              />
            </label>
            <label htmlFor="description">
              Field guidance (optional)
              <input
                id="description"
                name="description"
                maxLength={300}
                placeholder="Rigid pipe, window profile. Polyvinyl chloride, resin code 3."
              />
            </label>
            <label htmlFor="examples">
              Products (optional) — what collectors see, comma separated
              <input
                id="examples"
                name="examples"
                placeholder="Pipe offcuts, Window frames, Conduit"
              />
            </label>
            <label htmlFor="sortOrder">
              Display order (optional, lower shows first)
              <input
                id="sortOrder"
                name="sortOrder"
                type="number"
                min={0}
                max={10000}
                placeholder="70"
              />
            </label>
            <div className="actions">
              <button className="btn" data-variant="primary" type="submit">
                Add material
              </button>
            </div>
          </form>
        </>
      ) : null}
    </main>
  );
}

function MaterialTable({ materials, canEdit }: { materials: Material[]; canEdit: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Field guidance</th>
            <th>Products</th>
            <th className="num">Order</th>
            <th>Status</th>
            {canEdit ? <th className="no-print">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {materials.map((m) => (
            <tr key={m.code}>
              <td className="hash">{m.code}</td>
              <td>{m.name}</td>
              <td>{m.description ?? "—"}</td>
              <td>
                {m.examples.length === 0
                  ? "—"
                  : m.examples.map((example) => (
                      <span key={example} className="pill" data-tone="neutral">
                        {example}
                      </span>
                    ))}
              </td>
              <td className="num">{m.sortOrder}</td>
              <td>
                <span className="pill" data-tone={m.active ? "verified" : "neutral"}>
                  {m.active ? "offered" : "retired"}
                </span>
              </td>
              {canEdit ? (
                <td className="no-print">
                  <div className="actions">
                    <form action={setActive}>
                      <input type="hidden" name="code" value={m.code} />
                      <input type="hidden" name="active" value={m.active ? "false" : "true"} />
                      <button className="btn" type="submit">
                        {m.active ? "Retire" : "Restore"}
                      </button>
                    </form>

                    <details className="confirm">
                      <summary className="btn">Edit labels</summary>
                      <form action={editMaterial} className="confirm-body">
                        <input type="hidden" name="code" value={m.code} />
                        <p>
                          The code <strong>{m.code}</strong> cannot change — it is already signed
                          into payloads. Only what people read changes here.
                        </p>
                        <label htmlFor={`name-${m.code}`}>
                          Name
                          <input
                            id={`name-${m.code}`}
                            name="name"
                            defaultValue={m.name}
                            required
                            maxLength={120}
                          />
                        </label>
                        <label htmlFor={`desc-${m.code}`}>
                          Field guidance
                          <input
                            id={`desc-${m.code}`}
                            name="description"
                            defaultValue={m.description ?? ""}
                            maxLength={300}
                          />
                        </label>
                        <label htmlFor={`examples-${m.code}`}>
                          Products — comma separated, empty to clear
                          <input
                            id={`examples-${m.code}`}
                            name="examples"
                            defaultValue={m.examples.join(", ")}
                          />
                        </label>
                        <div className="actions">
                          <button className="btn" data-variant="primary" type="submit">
                            Save
                          </button>
                        </div>
                      </form>
                    </details>

                    <details className="confirm">
                      <summary className="btn">Delete</summary>
                      <form action={deleteMaterial} className="confirm-body">
                        <input type="hidden" name="code" value={m.code} />
                        <p>
                          Deleting only works if <strong>{m.code}</strong> has never been used by a
                          weigh-in or a batch. If it has, the request is refused and you will be
                          told how many records carry it — retire it instead, which is almost always
                          what you want.
                        </p>
                        <div className="actions">
                          <button className="btn" type="submit">
                            Delete if unused
                          </button>
                        </div>
                      </form>
                    </details>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
