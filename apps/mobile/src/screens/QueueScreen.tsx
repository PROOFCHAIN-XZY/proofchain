import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { colors, radius, space, statusColor, type } from "../theme";
import { counts, recent, unsyncedWeightKg, type QueuedWeighIn } from "../lib/queue";
import { appStore } from "../lib/native";
import { useAutoSync } from "../lib/useAutoSync";

/**
 * What this phone still owes the hub.
 *
 * The headline number is unsynced weight, not record count, because that is what
 * the collector is paid for. Rejected records stay visible with their reason —
 * they are refused work, and a collector who learns why can often fix it.
 */
export function QueueScreen({ refreshKey }: { refreshKey: number }) {
  const [records, setRecords] = useState<QueuedWeighIn[]>([]);
  const [tally, setTally] = useState({ queued: 0, syncing: 0, synced: 0, rejected: 0 });
  const [owedKg, setOwedKg] = useState(0);

  const load = useCallback(async () => {
    setRecords(await recent(appStore));
    setTally(await counts(appStore));
    setOwedKg(await unsyncedWeightKg(appStore));
  }, []);

  // Background passes and the button below share one in-flight guard, so tapping
  // "Sync now" during an automatic pass cannot post the same records twice.
  const { syncNow, syncing, lastOutcome } = useAutoSync(load);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const note = lastOutcome
    ? lastOutcome.attempted === 0
      ? "Nothing to sync, or no connection right now."
      : `${lastOutcome.synced} accepted · ${lastOutcome.rejected} rejected · ${lastOutcome.failed} still waiting`
    : null;

  const sync = useCallback(async () => {
    await syncNow();
    await load();
  }, [load, syncNow]);

  return (
    <View style={styles.root}>
      <View style={styles.summary}>
        <Text style={styles.summaryLabel}>NOT YET SYNCED</Text>
        <Text style={styles.summaryValue}>
          {owedKg.toFixed(2)}
          <Text style={styles.summaryUnit}> kg</Text>
        </Text>
        <View style={styles.tallyRow}>
          <Tally label="Queued" value={tally.queued} tone={colors.queued} />
          <Tally label="Synced" value={tally.synced} tone={colors.synced} />
          <Tally label="Rejected" value={tally.rejected} tone={colors.rejected} />
        </View>
      </View>

      <Pressable style={[styles.sync, syncing && styles.syncBusy]} onPress={sync} disabled={syncing}>
        <Text style={styles.syncLabel}>{syncing ? "Syncing…" : "Sync now"}</Text>
      </Pressable>
      {note ? <Text style={styles.note}>{note}</Text> : null}

      <FlatList
        data={records}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={load} tintColor={colors.textMuted} />
        }
        ListEmptyComponent={<Text style={styles.empty}>No weigh-ins recorded on this phone yet.</Text>}
        renderItem={({ item }) => <Row record={item} />}
      />
    </View>
  );
}

function Tally({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <View style={styles.tally}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={styles.tallyValue}>{value}</Text>
      <Text style={styles.tallyLabel}>{label}</Text>
    </View>
  );
}

function Row({ record }: { record: QueuedWeighIn }) {
  const tone = statusColor[record.status] ?? colors.textMuted;
  const at = new Date(record.payload.capturedAt);

  return (
    <View style={styles.row}>
      <View style={[styles.rowBar, { backgroundColor: tone }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowWeight}>
            {record.payload.weightKg.toFixed(2)} kg
            <Text style={styles.rowMaterial}> · {record.payload.material}</Text>
          </Text>
          {/* Status is labelled, not just coloured. */}
          <Text style={[styles.rowStatus, { color: tone }]}>{record.status.toUpperCase()}</Text>
        </View>
        <Text style={styles.rowMeta}>
          {at.toLocaleString()}
        </Text>
        {record.lastError ? <Text style={styles.rowError}>{record.lastError}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: space.md },

  summary: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
  },
  summaryLabel: { ...type.label, color: colors.textMuted },
  summaryValue: { color: colors.text, fontSize: 44, fontWeight: "700", marginTop: space.xs },
  summaryUnit: { fontSize: 20, color: colors.textMuted, fontWeight: "600" },
  tallyRow: { flexDirection: "row", gap: space.lg, marginTop: space.md },
  tally: { flexDirection: "row", alignItems: "center", gap: space.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tallyValue: { color: colors.text, fontWeight: "700", fontSize: 15 },
  tallyLabel: { color: colors.textMuted, fontSize: 13 },

  sync: {
    marginTop: space.md,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: "center",
  },
  syncBusy: { opacity: 0.6 },
  syncLabel: { color: colors.onAccent, fontSize: 16, fontWeight: "700" },
  note: { color: colors.textMuted, fontSize: 13, textAlign: "center", marginTop: space.sm },

  list: { paddingTop: space.md, gap: space.sm },
  empty: { color: colors.textFaint, textAlign: "center", marginTop: space.xl },

  row: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowBar: { width: 4 },
  rowBody: { flex: 1, padding: space.md, gap: space.xs },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowWeight: { color: colors.text, fontSize: 17, fontWeight: "700" },
  rowMaterial: { color: colors.textMuted, fontSize: 14, fontWeight: "500" },
  rowStatus: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6 },
  rowMeta: { color: colors.textFaint, fontSize: 12 },
  rowError: { color: colors.rejected, fontSize: 12, marginTop: space.xs },
});
