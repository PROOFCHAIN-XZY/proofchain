export function formatKg(value: number | string): string {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

export function formatTonnes(kg: number | string): string {
  return (Number(kg) / 1000).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function shortHash(hash: string | null, chars = 10): string {
  if (!hash) return "—";
  return hash.length <= chars * 2 ? hash : `${hash.slice(0, chars)}…${hash.slice(-chars)}`;
}

/**
 * A batch is only "verified" once it is sealed AND anchored. Anything else is
 * pending — we never colour an unanchored batch as if it were proven.
 */
export function batchTone(status: string, anchored: boolean): "verified" | "pending" | "neutral" {
  if (anchored) return "verified";
  if (status === "open") return "neutral";
  return "pending";
}
