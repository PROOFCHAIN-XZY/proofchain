import "./styles.css";
import { type MaterialType, type WeighInPayload } from "@shared/types";
import { examplesLine, materialLabel } from "@shared/materials";
import {
  cachedCatalogue,
  catalogueFetchedAt,
  isUsingFallbackCatalogue,
  pickableMaterials,
  refreshCatalogue,
} from "./lib/materials";
import { hashPhoto, loadOrCreateIdentity, randomId, randomNonce, signWeighIn } from "./lib/identity";
import * as queue from "./lib/queue";
import {
  backendUrl,
  enrolDevice,
  fetchCollectors,
  fetchHubDirectory,
  fetchHubs,
  operatorLogin,
  setBackendUrl,
  syncPending,
} from "./lib/api";
import { connectScale, isSupported as scaleSupported, type ScaleConnection } from "./lib/scale";
import {
  boundsForHub,
  hubChoices,
  hubLabel,
  mergeHubSnapshot,
  selectHub,
  type HubOption,
} from "./lib/hubs";
import { formatKg, weightProblem } from "@shared/integrity-copy";

/**
 * ProofChain field capture.
 *
 * One screen, one job: turn a physical weigh-in into a signed, photographed
 * record that survives having no signal. Everything else — batching, anchoring,
 * reporting — happens elsewhere. The collector's only obligations are weight,
 * material and photo.
 */

interface Provisioning {
  collectorId: string;
  hubId: string;
  deviceId: string;
  collectorName: string;
  hubName: string;
  /**
   * Every hub this device may switch to, captured at enrolment.
   *
   * A field phone holds no operator token and `/hubs` requires one, so the list
   * cannot be fetched later — and fetching it would need signal, which this app
   * assumes it does not have. Optional because devices enrolled before this
   * existed have none; `hubChoices` renders their single hub instead.
   */
  hubs?: HubOption[];
}

const PROVISION_KEY = "proofchain.device.provisioning.v1";

const identity = loadOrCreateIdentity();
const app = document.querySelector<HTMLDivElement>("#app")!;

let provisioning: Provisioning | null = readProvisioning();
// Whatever the catalogue offers first, not a hardcoded "PET": an operator can
// retire PET, and defaulting to a retired code would have every collector who
// does not notice the picker sign an unusable material all day.
let material: MaterialType = pickableMaterials()[0].code;
let photo: Blob | null = null;
let photoHash: string | null = null;
let scale: ScaleConnection | null = null;
let notice: { tone: "good" | "bad" | "warn"; text: string } | null = null;

/**
 * The camera is a sensor behind its own permission and can fail on its own, so
 * it gets a dedicated status rather than sharing the one-line `notice`: a photo
 * that cannot be read must not erase an unrelated message, and must not leave
 * its own button disabled. Nothing in this section may throw past its handler.
 */
interface EvidenceSlot {
  busy: boolean;
  message: string | null;
  tone: "bad" | "warn" | null;
}

const idleSlot = (): EvidenceSlot => ({ busy: false, message: null, tone: null });

let photoSlot: EvidenceSlot = idleSlot();

function readProvisioning(): Provisioning | null {
  const raw = localStorage.getItem(PROVISION_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Provisioning;
  } catch {
    // Corrupt provisioning must not brick the app on boot. Falling back to the
    // pairing screen loses nothing: re-enrolling is cheap, and the signing key
    // itself lives under a different storage key and is untouched.
    return null;
  }
}

function saveProvisioning(value: Provisioning): void {
  localStorage.setItem(PROVISION_KEY, JSON.stringify(value));
  provisioning = value;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/**
 * Anything can end up in a `catch`, including strings and `undefined`. Turn it
 * into something worth showing a collector standing over a scale.
 */
function describeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || fallback;
}

/**
 * Bind a control, tolerating its absence and containing its failures.
 *
 * Two things this replaces a bare `getElementById(...)!.addEventListener` for.
 * A missing element used to throw mid-wiring and leave every control *after* it
 * dead — a screen where the buttons silently do nothing is far worse than the
 * one missing control. And an `async` handler that rejected used to surface only
 * as an unhandled rejection in a console no collector will ever open.
 */
function on(
  id: string,
  event: string,
  handler: (event: Event) => void | Promise<void>,
): void {
  const node = document.getElementById(id);
  if (!node) return;

  node.addEventListener(event, (ev) => {
    try {
      void Promise.resolve(handler(ev)).catch((error) => reportUnexpected(id, error));
    } catch (error) {
      reportUnexpected(id, error);
    }
  });
}

function reportUnexpected(id: string, error: unknown): void {
  console.error(`[capture] handler for #${id} failed`, error);
  notice = { tone: "bad", text: describeError(error, `${id} failed unexpectedly`) };
  const current = document.querySelector(".notice");
  if (current) current.outerHTML = noticeHtml();
}

// -------------------------------------------------------------- catalogue

/**
 * The right-hand note on the Material label.
 *
 * Says nothing at all in the normal case. It speaks up only when the list on
 * screen might not be the operator's current one, because a collector choosing
 * from a stale catalogue is choosing from something that can be rejected later.
 */
function catalogueStatus(): string {
  if (isUsingFallbackCatalogue()) return "default list — not yet synced";

  const fetchedAt = catalogueFetchedAt();
  if (!fetchedAt) return "";

  const ageHours = (Date.now() - new Date(fetchedAt).getTime()) / 3_600_000;
  if (ageHours >= 24) {
    const days = Math.floor(ageHours / 24);
    return `list is ${days} day${days === 1 ? "" : "s"} old`;
  }
  return "";
}

/** Field guidance for the material currently selected, if the catalogue carries any. */
function selectedDescription(): string | null {
  return cachedCatalogue().find((m) => m.code === material)?.description ?? null;
}

/** The products the selected material covers, as the catalogue lists them. */
function selectedExamples(): string[] {
  return cachedCatalogue().find((m) => m.code === material)?.examples ?? [];
}

/**
 * The product tags for a material.
 *
 * Rendered as real list items rather than folded into the guidance sentence
 * because a collector holding a sack is matching an object against a list, not
 * reading prose — separate tags survive being glanced at, a comma-separated
 * clause does not.
 */
function productTags(examples: readonly string[]): string {
  return examples.map((e) => `<li>${escapeHtml(e)}</li>`).join("");
}

/**
 * Sync the guidance line to the current selection.
 *
 * Hidden rather than emptied when a material has no description, so the element
 * takes no vertical space and the chips do not shift as the collector taps
 * between materials.
 */
function updateMaterialHint(): void {
  const hint = document.getElementById("material-hint");
  if (!hint) return;

  const description = selectedDescription();
  hint.textContent = description ?? "";
  hint.hidden = description === null;

  const products = document.getElementById("material-products");
  if (!products) return;

  const examples = selectedExamples();
  products.innerHTML = productTags(examples);
  products.hidden = examples.length === 0;
}

/**
 * Keep the selection valid across a catalogue refresh.
 *
 * An operator can retire the material a collector has selected while the app is
 * open. Leaving it selected would let them sign a weigh-in the server accepts but
 * that can never be batched, so the selection moves to the first available code —
 * silently, because there is nothing for the collector to decide here.
 */
function reconcileSelection(): void {
  const pickable = pickableMaterials();
  if (!pickable.some((m) => m.code === material)) {
    material = pickable[0].code;
  }
}

// ---------------------------------------------------------------- rendering

/**
 * The blob URL backing the photo preview.
 *
 * Object URLs pin the whole image in memory until they are revoked, and this app
 * re-renders on a timer. Without revoking the previous one, a shift's worth of
 * multi-megabyte photos accumulates and eventually takes the tab down on exactly
 * the low-end hardware this app targets.
 */
let photoObjectUrl: string | null = null;

function photoPreviewUrl(): string {
  if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
  photoObjectUrl = URL.createObjectURL(photo!);
  return photoObjectUrl;
}

function releasePhotoPreview(): void {
  if (!photoObjectUrl) return;
  URL.revokeObjectURL(photoObjectUrl);
  photoObjectUrl = null;
}

// ------------------------------------------------------------ evidence

/**
 * The evidence field, in one place so the initial render and the in-place
 * repaints below cannot drift apart.
 *
 * Everything that changes when a photo arrives lives under a `photo-` id, so a
 * repaint provably cannot touch a node outside it. The file input sits outside:
 * it is the handle an open camera dialog will return to, and replacing it
 * mid-capture would drop the photo the collector just took.
 */
function evidenceFieldHtml(): string {
  return `
      <div class="field">
        <span class="label">Evidence</span>
        <div class="evidence">
          <div id="photo-thumb">${photoThumbHtml()}</div>
          <div class="meta">
            <span><strong>Photo</strong> <span id="photo-readout">${escapeHtml(photoReadout())}</span></span>
            ${slotNoteHtml("photo-note", photoSlot)}
          </div>
        </div>
        <div class="row">
          <button class="ghost" id="shoot" ${photoSlot.busy ? "disabled" : ""}>${escapeHtml(shootLabel())}</button>
        </div>
        <input id="camera" type="file" accept="image/*" capture="environment" class="visually-hidden" />
      </div>
`;
}

function photoThumbHtml(): string {
  return photo
    ? `<img src="${photoPreviewUrl()}" alt="Weigh-in photo" />`
    : `<div class="empty">no<br />photo</div>`;
}

function photoReadout(): string {
  if (photoSlot.busy) return "reading…";
  // Keyed on the hash, not on the blob: a photo whose bytes could not be hashed
  // cannot be signed, so showing it as captured would promise something commit
  // is about to refuse.
  if (!photoHash) return "not captured";
  return `${photoHash.slice(0, 16)}…`;
}

function shootLabel(): string {
  if (photoSlot.busy) return "Reading…";
  return photoHash ? "Retake photo" : "Take photo";
}

function slotNoteHtml(id: string, slot: EvidenceSlot): string {
  const tone = slot.tone ?? "bad";
  return `<span class="slot-note" id="${id}" data-tone="${tone}" role="status"${
    slot.message ? "" : " hidden"
  }>${escapeHtml(slot.message ?? "")}</span>`;
}

/**
 * Repaint the evidence field in place.
 *
 * A full `render()` would work, but it rebuilds the entire screen — including the
 * file input an open camera dialog is holding. Patching only the nodes that
 * actually changed keeps a half-typed weight and an open dialog alive. Every
 * lookup is null-tolerant: a repaint that races a screen change is a no-op,
 * never a throw.
 */
function paintEvidence(): void {
  const set = (id: string, text: string) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  const note = (id: string, slot: EvidenceSlot) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = slot.message ?? "";
    node.dataset.tone = slot.tone ?? "bad";
    node.hidden = slot.message === null;
  };
  const button = (id: string, label: string, busy: boolean) => {
    const node = document.getElementById(id) as HTMLButtonElement | null;
    if (!node) return;
    node.textContent = label;
    node.disabled = busy;
  };

  const thumb = document.getElementById("photo-thumb");
  if (thumb) thumb.innerHTML = photoThumbHtml();
  set("photo-readout", photoReadout());
  note("photo-note", photoSlot);
  button("shoot", shootLabel(), photoSlot.busy);
}

async function render(): Promise<void> {
  // Re-rendering replaces the whole subtree, which would discard a weight the
  // collector is part-way through typing — and this runs on a 60 s sync timer, so
  // it would silently eat input mid-shift. Carry the field across the swap.
  const previous = document.getElementById("weight") as HTMLInputElement | null;
  const carriedWeight = previous?.value ?? "";
  const hadFocus = previous !== null && document.activeElement === previous;

  let markup: string;
  try {
    markup = provisioning ? await captureScreen() : provisionScreen();
  } catch (error) {
    // captureScreen reads the queue out of IndexedDB, which is unavailable in
    // some private-browsing modes and can fail on a full disk. Rejecting here
    // would leave every `void render()` call site as an unhandled rejection and
    // freeze the screen on whatever it last showed — including a half-disabled
    // evidence button. Keep the screen it has and say what happened instead.
    reportUnexpected("render", error);
    return;
  }

  app.setAttribute("aria-busy", "false");
  app.innerHTML = markup;
  provisioning ? wireCapture() : wireProvision();

  if (carriedWeight) {
    const next = document.getElementById("weight") as HTMLInputElement | null;
    if (next) {
      next.value = carriedWeight;
      if (hadFocus) {
        next.focus();
        next.setSelectionRange(carriedWeight.length, carriedWeight.length);
      }
    }
  }
}

function masthead(): string {
  const online = navigator.onLine;
  return `
    <header class="masthead">
      <h1 class="wordmark">ProofChain <span>capture</span></h1>
      <span class="net" data-online="${online}">${online ? "online" : "offline"}</span>
    </header>`;
}

function noticeHtml(): string {
  if (!notice) return "";
  return `<p class="notice" data-tone="${notice.tone}" role="status">${escapeHtml(notice.text)}</p>`;
}

function provisionScreen(): string {
  return `
    ${masthead()}
    <main>
      <div class="field">
        <span class="label">Step 1 · Pair this phone</span>
        <p style="margin:0;font-size:0.9375rem">
          This device has generated its own signing key. An operator enrols the
          <strong>public</strong> half; the private half never leaves this phone.
        </p>
      </div>

      ${noticeHtml()}

      <div class="field">
        <span class="label">Device public key</span>
        <code class="meta" style="user-select:all">${escapeHtml(identity.publicKeyBase64)}</code>
      </div>

      <div class="field">
        <label class="label" for="backend">Backend URL</label>
        <input id="backend" type="text" value="${escapeHtml(backendUrl())}" inputmode="url" />
      </div>

      <div class="field">
        <label class="label" for="email">Operator email</label>
        <input id="email" type="email" autocomplete="username" placeholder="operator@proofchain.local" />
      </div>

      <div class="field">
        <label class="label" for="password">Operator password</label>
        <input id="password" type="password" autocomplete="current-password" />
      </div>

      <button class="action" id="load">Sign in &amp; load collectors</button>

      <div id="assign" hidden>
        <div class="field">
          <label class="label" for="collector">Collector</label>
          <select id="collector"></select>
        </div>
        <div class="field">
          <label class="label" for="hub">Hub</label>
          <select id="hub"></select>
        </div>
        <div class="field">
          <label class="label" for="label">Device label</label>
          <input id="label" type="text" value="Field phone" />
        </div>
        <button class="action" id="enrol" style="margin-top:0.75rem">Enrol this device</button>
      </div>
    </main>`;
}

/**
 * What this hub accepts for a single weigh-in.
 *
 * Shown before the weight is typed rather than after it is refused, so the limit
 * is a thing the collector plans around — split the load, weigh it in two —
 * instead of a thing they discover by losing a weigh-in to it. Rendered only
 * when the device actually knows the bounds; a phone whose snapshot predates
 * them says nothing rather than inventing a figure.
 */
function rangeHint(p: Provisioning): string {
  const { minKg, maxKg } = boundsForHub(hubChoices(p.hubs, p), p.hubId);
  if (minKg === null && maxKg === null) return "";

  const range =
    minKg !== null && maxKg !== null
      ? `${formatKg(minKg)}–${formatKg(maxKg)} kg`
      : minKg !== null
        ? `${formatKg(minKg)} kg or more`
        : `up to ${formatKg(maxKg as number)} kg`;

  return `<p class="hint">This hub accepts ${range} per weigh-in.</p>`;
}

async function captureScreen(): Promise<string> {
  const p = provisioning!;
  const tallies = await queue.counts();
  const records = (await queue.all()).slice(0, 25);

  return `
    ${masthead()}
    <main>
      <div class="field">
        <span class="label">
          <span>Collector</span>
        </span>
        <strong style="font-size:1.125rem">${escapeHtml(p.collectorName)}</strong>
      </div>

      <div class="field">
        <label class="label" for="active-hub">
          <span>Hub</span>
        </label>
        <select id="active-hub">
          ${hubChoices(p.hubs, p)
            .map(
              (h) =>
                `<option value="${escapeHtml(h.id)}"${h.id === p.hubId ? " selected" : ""}>${escapeHtml(
                  hubLabel(h),
                )}</option>`,
            )
            .join("")}
        </select>
      </div>

      ${noticeHtml()}

      <div class="field">
        <span class="label">
          <span>Weight</span>
          <span>${scaleSupported() ? (scale ? escapeHtml(scale.deviceName) : "scale not paired") : "manual entry"}</span>
        </span>
        <div class="readout">
          <input
            id="weight"
            type="text"
            inputmode="decimal"
            placeholder="0.000"
            aria-label="Weight in kilograms"
            autocomplete="off"
          />
          <span class="unit">kilograms</span>
        </div>
        ${rangeHint(p)}
        ${
          scaleSupported()
            ? `<button class="ghost" id="pair">${scale ? "Disconnect scale" : "Pair Bluetooth scale"}</button>`
            : ""
        }
      </div>

      <div class="field">
        <span class="label">
          <span>Material</span>
          <span>${escapeHtml(catalogueStatus())}</span>
        </span>
        <div class="chips" role="group" aria-label="Material type">
          ${pickableMaterials()
            .map((m) => {
              const selected = m.code === material;
              // The name is the label and the code is the subscript, not the
              // other way round. A collector sorting a sack recognises "Milk
              // jugs, crates" far faster than "HDPE" — but the code is what gets
              // signed, so it stays visible rather than being hidden behind a
              // friendly name nobody can cross-check against a report.
              const sub = m.name === m.code ? "" : `<small>${escapeHtml(m.code)}</small>`;
              return `<button
                class="chip"
                type="button"
                data-material="${escapeHtml(m.code)}"
                aria-pressed="${selected}"
                ${(() => {
                  // Long-press / hover text: guidance first, then the products,
                  // so the tooltip answers "what is this?" the same way the
                  // panel below the picker does.
                  const parts = [m.description, examplesLine(m.examples, m.examples.length)].filter(
                    (part): part is string => Boolean(part),
                  );
                  return parts.length > 0 ? `title="${escapeHtml(parts.join(" — "))}"` : "";
                })()}
              ><span>${escapeHtml(m.name)}</span>${sub}</button>`;
            })
            .join("")}
        </div>
        <p class="hint" id="material-hint" ${selectedDescription() ? "" : "hidden"}>${escapeHtml(
          selectedDescription() ?? "",
        )}</p>
        <ul
          class="products"
          id="material-products"
          aria-label="Products counted as this material"
          ${selectedExamples().length > 0 ? "" : "hidden"}
        >${productTags(selectedExamples())}</ul>
      </div>

      ${evidenceFieldHtml()}

      <button class="action" id="commit">Sign &amp; queue weigh-in</button>
    </main>

    <section class="queue" aria-labelledby="queue-title">
      <h2 class="panel-title" id="queue-title">Capture queue</h2>
      <div class="tallies">
        <span class="tally" data-kind="queued"><b>${tallies.queued + tallies.syncing}</b>waiting</span>
        <span class="tally" data-kind="synced"><b>${tallies.synced}</b>synced</span>
        <span class="tally" data-kind="rejected"><b>${tallies.rejected}</b>rejected</span>
      </div>
      <button class="ghost" id="sync" ${navigator.onLine ? "" : "disabled"}>
        ${navigator.onLine ? "Sync now" : "Offline — will sync automatically"}
      </button>
      <ul class="records">
        ${
          records.length === 0
            ? `<li style="border:0;color:var(--ink-soft)">No weigh-ins captured yet.</li>`
            : records
                .map(
                  (r) => `
          <li data-status="${r.status}">
            <span class="record-weight">${r.payload.weightKg.toFixed(3)} kg</span>
            <span class="meta">${escapeHtml(materialLabel(r.payload.material, cachedCatalogue()))} · ${new Date(r.createdAt).toLocaleTimeString()}</span>
            ${r.lastError ? `<span class="record-note">${escapeHtml(r.lastError)}</span>` : ""}
          </li>`,
                )
                .join("")
        }
      </ul>
    </section>`;
}

// ---------------------------------------------------------------- wiring

function wireProvision(): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  let token = "";
  let loadedHubs: Awaited<ReturnType<typeof fetchHubs>> = [];

  $<HTMLButtonElement>("load").addEventListener("click", async () => {
    notice = null;
    try {
      setBackendUrl($<HTMLInputElement>("backend").value.trim());
      // The cached catalogue is keyed by origin, so pointing at a different
      // backend has just invalidated it. Fetch this one's before the collector
      // reaches the picker; a code from the old instance may not exist here.
      void syncCatalogue();
      token = await operatorLogin(
        $<HTMLInputElement>("email").value.trim(),
        $<HTMLInputElement>("password").value,
      );

      const [collectors, hubs] = await Promise.all([fetchCollectors(token), fetchHubs(token)]);
      loadedHubs = hubs;

      const collectorSelect = $<HTMLSelectElement>("collector");
      collectorSelect.innerHTML = collectors
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");

      const hubSelect = $<HTMLSelectElement>("hub");
      hubSelect.innerHTML = hubs
        .map((h) => `<option value="${h.id}">${escapeHtml(`${h.code} — ${h.name}`)}</option>`)
        .join("");

      $("assign").hidden = false;
      notice = { tone: "good", text: "Signed in. Choose the collector and hub for this phone." };
      const current = document.querySelector(".notice");
      if (current) current.outerHTML = noticeHtml();
    } catch (error) {
      notice = { tone: "bad", text: (error as Error).message };
      void render();
    }
  });

  $<HTMLButtonElement>("enrol").addEventListener("click", async () => {
    try {
      const collectorSelect = $<HTMLSelectElement>("collector");
      const hubSelect = $<HTMLSelectElement>("hub");

      const { deviceId } = await enrolDevice(token, {
        collectorId: collectorSelect.value,
        label: $<HTMLInputElement>("label").value.trim() || "Field phone",
        publicKeyBase64: identity.publicKeyBase64,
      });

      const hub = loadedHubs.find((h) => h.id === hubSelect.value);
      if (!hub) throw new Error("selected hub not found");

      saveProvisioning({
        collectorId: collectorSelect.value,
        hubId: hubSelect.value,
        deviceId,
        collectorName: collectorSelect.selectedOptions[0]?.textContent ?? "Collector",
        hubName: hubSelect.selectedOptions[0]?.textContent ?? "Hub",
        // Snapshot every hub while an operator token is still in hand: this is
        // the only moment the device can see the list, and it is what lets a
        // collector move between sites later without signal or a login.
        hubs: loadedHubs.map((h) => ({
          id: h.id,
          code: h.code,
          name: h.name,
          minWeightKg: h.minWeightKg,
          maxWeightKg: h.maxWeightKg,
        })),
      });

      notice = { tone: "good", text: "Device enrolled. Ready to capture." };
      void render();
    } catch (error) {
      notice = { tone: "bad", text: (error as Error).message };
      void render();
    }
  });
}

function wireCapture(): void {
  on("active-hub", "change", (event) => {
    const chosen = (event.target as HTMLSelectElement).value;
    const p = provisioning!;

    const assignment = selectHub(hubChoices(p.hubs, p), chosen);
    if (!assignment) {
      notice = {
        tone: "bad",
        text: "That hub is not on this device. Re-enrol to refresh the list.",
      };
      void render();
      return;
    }

    saveProvisioning({ ...p, ...assignment });

    notice = { tone: "good", text: `Capturing at ${assignment.hubName}.` };
    void render();
  });

  for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-material]")) {
    chip.addEventListener("click", () => {
      material = chip.dataset.material as MaterialType;
      for (const other of document.querySelectorAll<HTMLButtonElement>("[data-material]")) {
        other.setAttribute("aria-pressed", String(other === chip));
      }
      // Patched in place rather than by re-rendering, for the same reason the
      // pressed state above is: a full render would discard a weight the
      // collector is part-way through typing. Anything in this field that depends
      // on the selection has to be updated here too.
      updateMaterialHint();
    });
  }

  const camera = document.getElementById("camera") as HTMLInputElement | null;
  on("shoot", "click", () => {
    if (photoSlot.busy || !camera) return;
    camera.click();
  });

  camera?.addEventListener("change", async () => {
    const file = camera.files?.[0];
    // A cancelled picker fires `change` with no file on some browsers. That is
    // not a failure and must not clear a photo already captured.
    if (!file) return;

    photoSlot = { busy: true, message: null, tone: null };
    paintEvidence();

    try {
      // Hash first, adopt second. `photo` and `photoHash` are what commit signs
      // and what the queue uploads, so they may never disagree: a blob on screen
      // with no hash behind it reads as captured and then fails at signing.
      const hash = await hashPhoto(file);
      releasePhotoPreview();
      photo = file;
      photoHash = hash;
      photoSlot = { busy: false, message: null, tone: null };
    } catch (error) {
      // Whatever was captured before survives; this attempt simply did not land.
      photoSlot = {
        busy: false,
        message: describeError(error, "could not read that photo — try again"),
        tone: "bad",
      };
    } finally {
      photoSlot.busy = false;
      // Cleared so picking the same file twice fires `change` again. Without
      // this, a retry after a failed read is silently ignored.
      camera.value = "";
      paintEvidence();
    }
  });

  on("pair", "click", async () => {
    if (scale) {
      scale.disconnect();
      scale = null;
      void render();
      return;
    }
    try {
      scale = await connectScale((reading) => {
        const weight = document.getElementById("weight") as HTMLInputElement | null;
        if (weight) weight.value = reading.weightKg.toFixed(3);
      });
      notice = { tone: "good", text: `Paired with ${scale.deviceName}.` };
    } catch (error) {
      notice = { tone: "bad", text: (error as Error).message };
    }
    void render();
  });

  on("commit", "click", commit);
  on("sync", "click", runSync);
}

// ---------------------------------------------------------------- actions

async function commit(): Promise<void> {
  const p = provisioning!;
  const weightInput = document.getElementById("weight") as HTMLInputElement | null;
  const weightKg = Number(weightInput?.value ?? "");

  // Weight and photo are perishable: the sack gets tipped and the truck leaves,
  // and neither can be recovered ten minutes later. Both are refused up front
  // rather than banked incomplete.
  const problems: string[] = [];
  if (!Number.isFinite(weightKg) || weightKg <= 0) problems.push("a weight");
  if (!photoHash) problems.push("a photo");

  if (problems.length > 0) {
    notice = { tone: "bad", text: `Still needed: ${problems.join(", ")}.` };
    void render();
    return;
  }

  // The hub's own limits, checked before anything is signed. The server checks
  // them again at ingest and its answer is the authoritative one — but by then
  // the sack has been tipped, so a rejection there is unpaid work. Here it is
  // still a correction: re-weigh, or split the load.
  const outOfRange = weightProblem(weightKg, boundsForHub(hubChoices(p.hubs, p), p.hubId));
  if (outOfRange) {
    notice = { tone: "bad", text: outOfRange };
    void render();
    return;
  }

  const payload: WeighInPayload = {
    schema: "proofchain.weighin.v2",
    collectorId: p.collectorId,
    hubId: p.hubId,
    deviceId: p.deviceId,
    weightKg: Number(weightKg.toFixed(3)),
    material,
    capturedAt: new Date().toISOString(),
    photoHash: photoHash!,
    nonce: randomNonce(),
  };

  await queue.enqueue({
    id: randomId(),
    payload,
    signature: signWeighIn(payload, identity),
    photo,
    status: "queued",
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    syncedAt: null,
    serverEventId: null,
    photoUploadedAt: null,
  });

  // Reset only the per-weigh-in evidence; keep material, since the next sack is
  // nearly always the same material.
  photo = null;
  photoHash = null;
  photoSlot = idleSlot();
  releasePhotoPreview();
  // Cleared explicitly: render() deliberately carries the weight field across
  // re-renders, so a committed weigh-in must blank it or the next one inherits it.
  if (weightInput) weightInput.value = "";
  notice = { tone: "good", text: `Signed and queued ${payload.weightKg.toFixed(3)} kg.` };

  await render();
  void runSync();
}

/**
 * Guards against overlapping sync passes.
 *
 * Four things trigger a sync: the button, the 60 s timer, the `online` event and
 * a fresh commit. Two overlapping passes both read the same pending records —
 * the server deduplicates on payload hash so nothing is double-counted, but the
 * phone would spend a metered field connection sending the same weigh-ins twice.
 */
let syncInFlight = false;

async function runSync(): Promise<void> {
  if (!navigator.onLine || syncInFlight) return;
  syncInFlight = true;

  try {
    await drainQueue();
  } finally {
    syncInFlight = false;
  }
}

async function drainQueue(): Promise<void> {
  const outcome = await syncPending();
  if (outcome.attempted > 0) {
    const parts = [`${outcome.synced} synced`];
    if (outcome.rejected > 0) parts.push(`${outcome.rejected} rejected`);
    if (outcome.failed > 0) parts.push(`${outcome.failed} still queued`);
    notice = {
      tone: outcome.rejected > 0 ? "warn" : "good",
      text: parts.join(", "),
    };
  }
  await render();
}

// ---------------------------------------------------------------- lifecycle

/**
 * Pull the catalogue and re-render only if it actually changed.
 *
 * Unconditionally re-rendering here would swap the DOM out from under a collector
 * every time this runs, and it runs on a timer. `refreshCatalogue` reports whether
 * anything moved so the common case — nothing changed — costs nothing on screen.
 */
async function syncCatalogue(): Promise<void> {
  const changed = await refreshCatalogue();
  if (!changed) return;

  reconcileSelection();
  await render();
}

/**
 * Refresh the hub list from the public directory.
 *
 * A phone enrolled before a hub existed would otherwise never see it, and
 * re-pairing in the field means finding someone with an operator login. Silent
 * on failure: the device already holds a usable list, and a collector mid-shift
 * has nothing to do about the directory being unreachable.
 *
 * Re-renders only when something actually changed, for the same reason
 * syncCatalogue does — this runs on a timer and would otherwise swap the DOM out
 * from under whoever is typing.
 */
async function syncHubs(): Promise<void> {
  const p = provisioning;
  if (!p) return;

  let directory: HubOption[];
  try {
    directory = await fetchHubDirectory();
  } catch {
    return;
  }

  const merged = mergeHubSnapshot(directory, p);
  const listChanged = JSON.stringify(merged.hubs) !== JSON.stringify(hubChoices(p.hubs, p));
  if (!listChanged && !merged.assignment) return;

  saveProvisioning({ ...p, ...(merged.assignment ?? {}), hubs: merged.hubs });

  // An operator renamed the hub this device is capturing against.
  if (merged.assignment) {
    notice = {
      tone: "warn",
      text: `This hub is now called ${merged.assignment.hubName}.`,
    };
  }

  await render();
}

window.addEventListener("online", () => {
  void runSync();
  void syncCatalogue();
  void syncHubs();
});
window.addEventListener("offline", () => {
  void render();
});

// Opportunistic drain: a phone that sits in a pocket with intermittent signal
// still empties its queue without the collector doing anything.
setInterval(() => {
  void runSync();
}, 60_000);

// Far less often than the queue drain: a catalogue changes when an operator
// decides it does, which is a matter of weeks, not minutes.
setInterval(() => {
  void syncCatalogue();
  void syncHubs();
}, 15 * 60_000);

void queue.pruneSynced();
void render();
void syncCatalogue();
void syncHubs();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
