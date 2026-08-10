import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { colors, radius, space, type } from "./src/theme";
import { CaptureScreen } from "./src/screens/CaptureScreen";
import { QueueScreen } from "./src/screens/QueueScreen";
import { EnrolScreen } from "./src/screens/EnrolScreen";
import { loadDeviceMeta, loadOrCreateIdentity, type DeviceIdentity, type DeviceMeta } from "./src/lib/identity";
import { randomBytes, secureStore } from "./src/lib/native";
import { pruneSynced } from "./src/lib/queue";
import { appStore } from "./src/lib/native";

type Tab = "capture" | "queue";

/**
 * Two tabs, because a collector only ever does two things: record a weigh-in,
 * and check what has not synced yet. Anything else belongs on the operator's
 * dashboard, not on a phone being used one-handed beside a scale.
 */
export default function App() {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [device, setDevice] = useState<DeviceMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("capture");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    void (async () => {
      const id = await loadOrCreateIdentity(secureStore, randomBytes);
      setIdentity(id);
      setDevice(await loadDeviceMeta(secureStore));
      // Bound storage growth without touching anything still owed to a collector.
      await pruneSynced(appStore);
      setReady(true);
    })();
  }, []);

  const onCaptured = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setTab("queue");
  }, []);

  if (!ready || !identity) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        {!device ? (
          <EnrolScreen identity={identity} onEnrolled={setDevice} />
        ) : (
          <>
            <View style={styles.header}>
              <View>
                <Text style={styles.collector}>{device.collectorName}</Text>
                <Text style={styles.hub}>{device.hubName}</Text>
              </View>
              <View style={styles.tabs}>
                <TabButton label="Weigh in" active={tab === "capture"} onPress={() => setTab("capture")} />
                <TabButton label="Queue" active={tab === "queue"} onPress={() => setTab("queue")} />
              </View>
            </View>

            {tab === "capture" ? (
              <CaptureScreen identity={identity} device={device} onCaptured={onCaptured} />
            ) : (
              <QueueScreen refreshKey={refreshKey} />
            )}
          </>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  boot: { flex: 1, backgroundColor: colors.ground, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  collector: { ...type.title, color: colors.text, fontSize: 20 },
  hub: { color: colors.textMuted, fontSize: 13, marginTop: 2 },

  tabs: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.md, padding: 3 },
  tab: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.sm },
  tabActive: { backgroundColor: colors.surfaceRaised },
  tabText: { color: colors.textMuted, fontSize: 14, fontWeight: "600" },
  tabTextActive: { color: colors.text },
});
