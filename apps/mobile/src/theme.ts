/**
 * Field-first visual language.
 *
 * This app is used outdoors, one-handed, often in direct sun and sometimes in
 * gloves. That drives every choice here: near-black ground with high-contrast
 * type for sunlight legibility, oversized touch targets, and status colours that
 * stay distinguishable for the most common forms of colour blindness — status is
 * never signalled by hue alone, always with a label beside it.
 */

export const colors = {
  ground: "#0B0F0E",
  surface: "#141A18",
  surfaceRaised: "#1D2422",
  border: "#2A3330",

  text: "#F2F5F4",
  textMuted: "#9BA8A4",
  textFaint: "#66736F",

  // Recovered-material green: the product's one saturated accent.
  accent: "#38E08A",
  accentPressed: "#26B76D",
  onAccent: "#062315",

  queued: "#F2B950",
  synced: "#38E08A",
  rejected: "#FF6B6B",
  syncing: "#5AB9F2",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 22,
} as const;

export const type = {
  display: { fontSize: 56, fontWeight: "700" },
  title: { fontSize: 24, fontWeight: "700" },
  body: { fontSize: 16, fontWeight: "400" },
  label: { fontSize: 13, fontWeight: "600", letterSpacing: 0.8 },
  mono: { fontSize: 12, fontWeight: "400" },
} as const;

export const statusColor: Record<string, string> = {
  queued: colors.queued,
  syncing: colors.syncing,
  synced: colors.synced,
  rejected: colors.rejected,
};
