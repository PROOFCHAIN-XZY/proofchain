/**
 * The material catalogue.
 *
 * A material code is part of the signed weigh-in payload, so it is hashed into
 * the Merkle leaf and anchored on the ledger. That has a consequence which
 * shapes everything in this file: **a code that has been signed can never be
 * renamed or deleted.** An audit report replays the exact string the device
 * signed, and a buyer recomputing the root from the event list must get the same
 * digest years later. Rewriting "PS" to "POLYSTYRENE" in the database would not
 * migrate history — it would silently invalidate every batch that contained it.
 *
 * So the catalogue separates three things that are easy to conflate:
 *
 * - **code** — the signed identifier. Append-only, immutable, `PET`-shaped.
 * - **name** — what a human reads. Presentation only, freely editable, never
 *   signed and never hashed.
 * - **active** — whether the code may be chosen for *new* capture. Retiring a
 *   material hides it from the pickers; it does not touch a single stored event.
 *
 * "Removing a material" therefore means retiring it. The one exception is a code
 * that has never been used by any event or batch — a typo added minutes ago —
 * which the backend does allow to be deleted outright, because deleting it
 * cannot invalidate anything.
 */

/**
 * Shape of a code. Deliberately narrow: uppercase alphanumerics with internal
 * separators, 2–16 characters. Codes travel through a canonical JSON
 * serialisation and end up in a Stellar data-entry key, so they must be stable
 * under transport and free of anything needing escaping. The narrowness is also
 * a guard against an operator typing a display name into the code field and
 * permanently minting `Clear bottle plastic` as a signed identifier.
 */
export const MATERIAL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,15}$/;

export function isMaterialCode(value: string): boolean {
  return MATERIAL_CODE_PATTERN.test(value);
}

/** Longest code the backend will store, and the column width in the migration. */
export const MATERIAL_CODE_MAX_LENGTH = 16;
export const MATERIAL_NAME_MAX_LENGTH = 120;
export const MATERIAL_DESCRIPTION_MAX_LENGTH = 300;

/**
 * Bounds on the product examples.
 *
 * Short, because they are read at a scale in daylight on a phone-width screen:
 * "milk jugs", not "high-density polyethylene containers for dairy products".
 * Few, because a list a collector has to scan defeats the point of showing it —
 * the examples are meant to settle a question in a second, and beyond about
 * half a dozen the picker is asking them to read rather than to recognise.
 */
export const MATERIAL_EXAMPLE_MAX_LENGTH = 60;
export const MATERIAL_EXAMPLES_MAX = 8;

/** A catalogue entry as the API returns it. */
export interface Material {
  code: string;
  /** Human-readable label. Presentation only — never signed. */
  name: string;
  /** Optional field guidance: what actually counts as this material. */
  description: string | null;
  /**
   * The everyday products made of this material, as a collector would name them
   * — "milk jugs", "bottle caps". Presentation only, like `name`: never signed,
   * never hashed, safe to edit at any time.
   *
   * Always an array. An entry with nothing to show is `[]`, never null, so no
   * caller has to write `examples?.length` and no picker has two empty states to
   * render.
   */
  examples: string[];
  /** False means retired: not offered for new capture, still valid in history. */
  active: boolean;
  /** Ascending display order in the pickers. Ties fall back to code. */
  sortOrder: number;
}

/**
 * The six codes the pilot shipped with, now seeded into the database by the
 * Materials migration.
 *
 * Two jobs beyond seeding. It is the offline fallback for the capture apps: a
 * phone that has never once reached the backend still has to show a usable
 * picker, because a collector standing at a scale with no signal is the normal
 * case, not the edge case. And it is the floor for `MATERIAL_TYPES` below.
 *
 * Do not edit a `code` here. Adding an entry is fine but pointless — the
 * database is the live catalogue, and a new material belongs there.
 */
export const SEED_MATERIALS: readonly Material[] = [
  {
    code: "PET",
    name: "PET",
    description: "Clear drink bottles. Polyethylene terephthalate, resin code 1.",
    examples: ["Water bottles", "Soft-drink bottles", "Cooking-oil bottles", "Clear food punnets"],
    active: true,
    sortOrder: 10,
  },
  {
    code: "HDPE",
    name: "HDPE",
    description: "Milk jugs, detergent bottles, crates. High-density polyethylene, resin code 2.",
    examples: ["Milk jugs", "Detergent bottles", "Bleach bottles", "Shampoo bottles", "Crates"],
    active: true,
    sortOrder: 20,
  },
  {
    code: "LDPE",
    name: "LDPE",
    description: "Film, carrier bags, squeeze bottles. Low-density polyethylene, resin code 4.",
    examples: ["Carrier bags", "Bread bags", "Pallet wrap", "Squeeze bottles", "Sachet film"],
    active: true,
    sortOrder: 30,
  },
  {
    code: "PP",
    name: "PP",
    description: "Caps, tubs, woven sacks. Polypropylene, resin code 5.",
    examples: ["Bottle caps", "Yoghurt tubs", "Margarine tubs", "Woven sacks", "Drinking straws"],
    active: true,
    sortOrder: 40,
  },
  {
    code: "PS",
    name: "PS",
    description: "Rigid cups, food trays, foam. Polystyrene, resin code 6.",
    examples: ["Foam takeaway packs", "Disposable cups", "Meat trays", "Yoghurt pots", "CD cases"],
    active: true,
    sortOrder: 50,
  },
  {
    code: "MIXED",
    name: "Mixed plastic",
    description: "Unsorted or unidentifiable plastic. Lowest credit value — sort where possible.",
    examples: [
      "Multi-layer sachets",
      "Unmarked offcuts",
      "Toys and housewares",
      "Unsorted sweepings",
    ],
    active: true,
    sortOrder: 60,
  },
];

/**
 * The codes that existed before the catalogue became a database table.
 *
 * Kept because tests, fixtures and the demo script reference them, and because
 * it documents what the pilot's first anchored batches could possibly contain.
 * It is **not** the validation allowlist any more — see `MaterialType`.
 */
export const MATERIAL_TYPES = SEED_MATERIALS.map((m) => m.code) as readonly string[];

/**
 * Clean whatever claims to be a product list into the shape `Material.examples`
 * promises: an array of short, non-empty, distinct strings.
 *
 * Applied on both sides of the wire, deliberately. On the way in, an operator
 * pasting "milk jugs, milk jugs ,  " must not mint a picker full of blanks and
 * repeats. On the way out, a device reads this list from a cache it wrote months
 * ago and from a backend that may be older or newer than it is — an entry that
 * arrives as `null`, a number, or the literal string a database driver hands
 * back for an empty array must degrade to "no examples", never to a crash in the
 * one screen a collector cannot do their job without.
 *
 * Duplicates are matched case-insensitively and the first spelling wins, since
 * "Bottle caps" and "bottle caps" are the same product to the person reading it.
 * Over-long entries are truncated rather than dropped: a truncated example still
 * helps identify a sack, whereas a silently missing one just looks like the
 * catalogue forgot something.
 */
export function normaliseExamples(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") continue;

    const cleaned = entry.replace(/\s+/g, " ").trim().slice(0, MATERIAL_EXAMPLE_MAX_LENGTH).trim();
    if (!cleaned) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(cleaned);
    if (out.length === MATERIAL_EXAMPLES_MAX) break;
  }

  return out;
}

/**
 * Parse the comma-separated form an admin types into a single input.
 *
 * A textarea of one product per line is the other natural way to write this, so
 * newlines separate too — an operator should not have to learn which one this
 * particular box wanted.
 */
export function parseExamples(input: string): string[] {
  return normaliseExamples(input.split(/[,\n]/));
}

/** The admin-facing round trip of `parseExamples`, for pre-filling an edit form. */
export function formatExamples(examples: readonly string[]): string {
  return examples.join(", ");
}

/**
 * The one-line rendering used under a picker: "Milk jugs · Detergent bottles".
 *
 * Capped independently of `MATERIAL_EXAMPLES_MAX` because a phone at arm's
 * length has less room than an admin table, and a line that wraps to three rows
 * pushes the capture button off the screen. The overflow is counted rather than
 * dropped silently, so a collector can tell the list is longer than what is
 * shown and open the catalogue if they need the rest.
 */
export function examplesLine(examples: readonly string[], limit = 4): string {
  const shown = examples.slice(0, limit);
  if (shown.length === 0) return "";

  const rest = examples.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} +${rest} more` : shown.join(" · ");
}

/** Active entries first by `sortOrder`, then code; retired entries last. */
export function sortMaterials(materials: readonly Material[]): Material[] {
  return [...materials].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.code.localeCompare(b.code);
  });
}

export function activeMaterials(materials: readonly Material[]): Material[] {
  return sortMaterials(materials.filter((m) => m.active));
}

/**
 * How to label a code in a UI, given whatever catalogue is to hand.
 *
 * Falls back to the raw code rather than to "Unknown". A historical event whose
 * material was retired and later dropped from a cached catalogue must still
 * render as the thing it was signed as — the code is the fact, the name is a
 * convenience, and showing "Unknown" where the ledger says "PS" would misreport
 * the record.
 */
export function materialLabel(code: string, catalogue: readonly Material[]): string {
  const found = catalogue.find((m) => m.code === code);
  if (!found) return code;
  return found.name === code ? code : `${code} · ${found.name}`;
}
