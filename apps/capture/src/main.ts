import "./styles.css";
import { MATERIAL_TYPES, type MaterialType, type WeighInPayload } from "@shared/types";
import { hashPhoto, loadOrCreateIdentity, randomNonce, signWeighIn } from "./lib/identity";
import * as queue from "./lib/queue";
import {
  backendUrl,
  enrolDevice,
  fetchCollectors,
  fetchHubs,
  operatorLogin,
  setBackendUrl,
  syncPending,
} from "./lib/api";
import {
  getFix,
  INSECURE_CONTEXT_MESSAGE,
  isSecureContextAvailable,
  type Fix,
} from "./lib/location";
import { connectScale, isSupported as scaleSupported, type ScaleConnection } from "./lib/scale";
import { assessFix } from "./lib/fix-assessment";

/**
 * ProofChain field capture.
 *
 * One screen, one job: turn a physical weigh-in into a signed, geo-tagged,
 * photographed record that survives having no signal. Everything else — batching,
 * anchoring, reporting — happens elsewhere. The collector's only obligations are
 * weight, material, location and photo.
 */

interface Provisioning {
  collectorId: string;
  hubId: string;
  deviceId: string;
  collectorName: string;
  hubName: string;
  // Kept on the device so the collector learns a fix is unusable *before*
  // signing, instead of discovering it as a server-side quarantine hours later.
  hubLat: number;
  hubLng: number;
  geofenceRadiusM: number;
}

const PROVISION_KEY = "proofchain.device.provisioning.v1";

const identity = loadOrCreateIdentity();
const app = document.querySelector<HTMLDivElement>("#app")!;

let provisioning: Provisioning | null = readProvisioning();
let material: MaterialType = "PET";
let fix: Fix | null = null;
let photo: Blob | null = null;
let photoHash: string | null = null;
let scale: ScaleConnection | null = null;
let notice: { tone: "good" | "bad" | "warn"; text: string } | null = null;

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
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
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

async function render(): Promise<void> {
  // Re-rendering replaces the whole subtree, which would discard a weight the
  // collector is part-way through typing — and this runs on a 60 s sync timer, so
  // it would silently eat input mid-shift. Carry the field across the swap.
  const previous = document.getElementById("weight") as HTMLInputElement | null;
  const carriedWeight = previous?.value ?? "";
  const hadFocus = previous !== null && document.activeElement === previous;

  app.setAttribute("aria-busy", "false");
  app.innerHTML = provisioning ? await captureScreen() : provisionScreen();
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

/**
 * Shown for as long as the page is served insecurely. Unlike `notice`, this is
 * not dismissible by retrying: every weigh-in captured here will fail its GPS
 * step, so the blocker belongs on screen permanently rather than appearing only
 * after the collector has already tried.
 */
function insecureBannerHtml(): string {
  if (isSecureContextAvailable()) return "";
  return `<p class="notice" data-tone="bad" role="alert">${escapeHtml(INSECURE_CONTEXT_MESSAGE)}</p>`;
}

function noticeHtml(): string {
  if (!notice) return "";
  return `<p class="notice" data-tone="${notice.tone}" role="status">${escapeHtml(notice.text)}</p>`;
}

function provisionScreen(): string {
  return `
    ${masthead()}
    <main>
      ${insecureBannerHtml()}
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

async function captureScreen(): Promise<string> {
  const p = provisioning!;
  const tallies = await queue.counts();
  const records = (await queue.all()).slice(0, 25);

  return `
    ${masthead()}
    <main>
      ${insecureBannerHtml()}
      <div class="field">
        <span class="label">
          <span>Collector</span>
          <span>${escapeHtml(p.hubName)}</span>
        </span>
        <strong style="font-size:1.125rem">${escapeHtml(p.collectorName)}</strong>
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
        ${
          scaleSupported()
            ? `<button class="ghost" id="pair">${scale ? "Disconnect scale" : "Pair Bluetooth scale"}</button>`
            : ""
        }
      </div>

      <div class="field">
        <span class="label">Material</span>
        <div class="chips" role="group" aria-label="Material type">
          ${MATERIAL_TYPES.map(
            (m) =>
              `<button class="chip" type="button" data-material="${m}" aria-pressed="${m === material}">${m}</button>`,
          ).join("")}
        </div>
      </div>

      <div class="field">
        <span class="label">Evidence</span>
        <div class="evidence">
          ${
            photo
              ? `<img src="${photoPreviewUrl()}" alt="Weigh-in photo" />`
              : `<div class="empty">no<br />photo</div>`
          }
          <div class="meta">
            <span><strong>GPS</strong> ${
              fix
                ? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)} ±${fix.accuracyM} m`
                : "not captured"
            }</span>
            <span><strong>Photo</strong> ${photoHash ? `${photoHash.slice(0, 16)}…` : "not captured"}</span>
          </div>
        </div>
        <div class="row">
          <button class="ghost" id="locate">${fix ? "Refresh GPS" : "Get GPS fix"}</button>
          <button class="ghost" id="shoot">${photo ? "Retake photo" : "Take photo"}</button>
        </div>
        <input id="camera" type="file" accept="image/*" capture="environment" class="visually-hidden" />
      </div>

      <button class="action" id="commit">Sign &amp; queue weigh-in</button>
    </main>

    <section class="queue" aria-label="Capture queue">
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
            <span class="meta">${r.payload.material} · ${new Date(r.createdAt).toLocaleTimeString()}</span>
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
        hubLat: hub.lat,
        hubLng: hub.lng,
        geofenceRadiusM: hub.geofenceRadiusM,
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
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-material]")) {
    chip.addEventListener("click", () => {
      material = chip.dataset.material as MaterialType;
      for (const other of document.querySelectorAll<HTMLButtonElement>("[data-material]")) {
        other.setAttribute("aria-pressed", String(other === chip));
      }
    });
  }

  $<HTMLButtonElement>("locate").addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("locate");
    button.disabled = true;
    button.textContent = "Locating…";
    try {
      const candidate = await getFix();
      const assessment = assessFix(candidate, provisioning);

      if (assessment.usable) {
        fix = candidate;
        notice = assessment.message ? { tone: "warn", text: assessment.message } : null;
      } else {
        // Refused, not merely flagged: an unusable fix is not weak evidence, it
        // is no evidence. Signing one would put a coordinate into the permanent
        // record that cannot support the claim being made about it.
        fix = null;
        notice = { tone: "bad", text: assessment.message ?? "unusable fix" };
      }
    } catch (error) {
      notice = { tone: "bad", text: (error as Error).message };
    }
    void render();
  });

  const camera = $<HTMLInputElement>("camera");
  $<HTMLButtonElement>("shoot").addEventListener("click", () => camera.click());
  camera.addEventListener("change", async () => {
    const file = camera.files?.[0];
    if (!file) return;
    photo = file;
    photoHash = await hashPhoto(file);
    void render();
  });

  const pair = document.getElementById("pair");
  pair?.addEventListener("click", async () => {
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

  $<HTMLButtonElement>("commit").addEventListener("click", commit);
  $<HTMLButtonElement>("sync").addEventListener("click", runSync);
}

// ---------------------------------------------------------------- actions

async function commit(): Promise<void> {
  const p = provisioning!;
  const weightInput = document.getElementById("weight") as HTMLInputElement;
  const weightKg = Number(weightInput.value);

  // Refuse to sign an incomplete record. A weigh-in missing GPS or a photo will
  // be quarantined server-side anyway; better the collector learns now, while
  // the material is still on the scale.
  const problems: string[] = [];
  if (!Number.isFinite(weightKg) || weightKg <= 0) problems.push("a weight");
  if (!fix) problems.push("a GPS fix");
  if (!photoHash) problems.push("a photo");

  if (problems.length > 0) {
    notice = { tone: "bad", text: `Still needed: ${problems.join(", ")}.` };
    void render();
    return;
  }

  const payload: WeighInPayload = {
    schema: "proofchain.weighin.v1",
    collectorId: p.collectorId,
    hubId: p.hubId,
    deviceId: p.deviceId,
    weightKg: Number(weightKg.toFixed(3)),
    material,
    lat: fix!.lat,
    lng: fix!.lng,
    capturedAt: new Date().toISOString(),
    photoHash: photoHash!,
    nonce: randomNonce(),
  };

  await queue.enqueue({
    id: crypto.randomUUID(),
    payload,
    signature: signWeighIn(payload, identity),
    photo,
    status: "queued",
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    syncedAt: null,
    serverEventId: null,
  });

  // Reset only the per-weigh-in evidence; keep material and the GPS fix, since
  // the next sack is nearly always the same material at the same spot.
  photo = null;
  photoHash = null;
  releasePhotoPreview();
  // Cleared explicitly: render() deliberately carries the weight field across
  // re-renders, so a committed weigh-in must blank it or the next one inherits it.
  weightInput.value = "";
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

window.addEventListener("online", () => {
  void runSync();
});
window.addEventListener("offline", () => {
  void render();
});

// Opportunistic drain: a phone that sits in a pocket with intermittent signal
// still empties its queue without the collector doing anything.
setInterval(() => {
  void runSync();
}, 60_000);

void queue.pruneSynced();
void render();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
