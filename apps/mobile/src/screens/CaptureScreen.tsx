import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { MaterialType, WeighInPayload } from "@shared/types";
import { formatKg, weightProblem } from "@shared/integrity-copy";
import { colors, radius, space, type } from "../theme";
import type { DeviceIdentity, DeviceMeta } from "../lib/identity";
import { signWeighIn } from "../lib/identity";
import { enqueue, type QueuedWeighIn } from "../lib/queue";
import { appStore, hashPhotoFile, randomNonce } from "../lib/native";
import { getBackendUrl } from "../lib/api";
import {
  fallbackCatalogue,
  loadCatalogue,
  reconcileSelection,
  refreshCatalogue,
  type Catalogue,
} from "../lib/materials";

interface Props {
  identity: DeviceIdentity;
  device: DeviceMeta;
  onCaptured: () => void;
}

/**
 * The weigh-in screen.
 *
 * Order matters: photo, then fix, then sign, then persist. Nothing is written
 * until all four succeed, so a half-formed record can never enter the queue and
 * be counted later. Once persisted the collector is done — syncing happens on
 * its own schedule and never blocks the next weigh-in.
 */
export function CaptureScreen({ identity, device, onCaptured }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);

  const [weight, setWeight] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);

  /**
   * The catalogue starts as the compiled-in fallback so the picker has something
   * to render on the very first frame, then is replaced by the cached list and,
   * if there is a connection, by the operator's current one.
   */
  const [catalogue, setCatalogue] = useState<Catalogue>(() => fallbackCatalogue());
  const [material, setMaterial] = useState<MaterialType>(() => fallbackCatalogue().pickable[0].code);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const origin = await getBackendUrl(appStore);
      // Cache first so the picker updates without waiting on the network, then
      // the network. On a dead link the second call returns the cached list
      // again, so this is one extra render, not a flicker back to defaults.
      const cached = await loadCatalogue(appStore, origin);
      if (cancelled) return;
      setCatalogue(cached);
      setMaterial((current) => reconcileSelection(cached, current));

      const fresh = await refreshCatalogue(appStore, origin);
      if (cancelled) return;
      setCatalogue(fresh);
      setMaterial((current) => reconcileSelection(fresh, current));
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => catalogue.all.find((m) => m.code === material) ?? null,
    [catalogue, material],
  );

  const weightKg = useMemo(() => Number.parseFloat(weight.replace(",", ".")), [weight]);

  /**
   * The hub's own limits, recorded at enrolment.
   *
   * Not a constant: the ceiling belongs to the hub, and a phone that hardcodes
   * one either blocks weigh-ins a hub would have accepted or waves through ones
   * it will refuse at ingest — and a refusal at ingest arrives hours later, with
   * the material gone and the work unpaid. A device that never recorded them
   * enforces nothing and leaves the judgement to the server.
   */
  const bounds = useMemo(
    () => ({ minKg: device.minWeightKg ?? null, maxKg: device.maxWeightKg ?? null }),
    [device.maxWeightKg, device.minWeightKg],
  );

  const outOfRange = useMemo(() => weightProblem(weightKg, bounds), [bounds, weightKg]);

  /** Shown before a weight is typed, so the limit is planned around, not hit. */
  const rangeHint = useMemo(() => {
    if (bounds.minKg === null && bounds.maxKg === null) return null;
    if (bounds.minKg !== null && bounds.maxKg !== null) {
      return `This hub accepts ${formatKg(bounds.minKg)}–${formatKg(bounds.maxKg)} kg per weigh-in.`;
    }
    return bounds.maxKg !== null
      ? `This hub accepts up to ${formatKg(bounds.maxKg)} kg per weigh-in.`
      : `This hub accepts ${formatKg(bounds.minKg as number)} kg or more per weigh-in.`;
  }, [bounds]);
  const weightValid = Number.isFinite(weightKg) && weightKg > 0 && outOfRange === null;

  const capture = useCallback(async () => {
    if (!weightValid || busy) return;

    setBusy(true);
    try {
      setStep("Photographing");
      const photo = await camera.current?.takePictureAsync({ quality: 0.6, skipProcessing: true });
      if (!photo?.uri) throw new Error("camera returned no image");

      setStep("Hashing photo");
      const photoHash = await hashPhotoFile(photo.uri);

      setStep("Signing");
      const payload: WeighInPayload = {
        schema: "proofchain.weighin.v2",
        collectorId: device.collectorId,
        hubId: device.hubId,
        deviceId: device.deviceId,
        weightKg,
        material,
        capturedAt: new Date().toISOString(),
        photoHash,
        nonce: randomNonce(),
      };
      const signature = signWeighIn(payload, identity);

      setStep("Saving");
      const record: QueuedWeighIn = {
        id: `${Date.now()}-${payload.nonce.slice(0, 8)}`,
        payload,
        signature,
        photoUri: photo.uri,
        status: "queued",
        attempts: 0,
        lastError: null,
        createdAt: new Date().toISOString(),
        syncedAt: null,
        serverEventId: null,
        photoUploadedAt: null,
      };
      await enqueue(appStore, record);

      setWeight("");
      onCaptured();
    } catch (error) {
      // Loud, not silent: an unrecorded weigh-in is unpaid work, and the
      // collector can still redo it while the material is in front of them.
      Alert.alert("Weigh-in not recorded", (error as Error).message);
    } finally {
      setBusy(false);
      setStep(null);
    }
  }, [busy, device, identity, material, onCaptured, weightKg, weightValid]);

  if (!permission?.granted) {
    return (
      <View style={styles.permission}>
        <Text style={styles.permissionTitle}>Camera access needed</Text>
        <Text style={styles.permissionBody}>
          Every weigh-in is photographed. The photo stays on this phone — only its
          fingerprint is sent.
        </Text>
        <Pressable style={styles.primary} onPress={requestPermission}>
          <Text style={styles.primaryLabel}>Grant access</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <View style={styles.cameraFrame}>
        <CameraView ref={camera} style={styles.camera} facing="back" />
        <View style={styles.cameraBadge}>
          <Text style={styles.cameraBadgeText}>{device.hubName}</Text>
        </View>
      </View>

      <Text style={styles.label}>WEIGHT</Text>
      <View style={styles.weightRow}>
        <TextInput
          style={styles.weightInput}
          value={weight}
          onChangeText={setWeight}
          placeholder="0.00"
          placeholderTextColor={colors.textFaint}
          keyboardType="decimal-pad"
          maxLength={9}
        />
        <Text style={styles.unit}>kg</Text>
      </View>
      {/* The limit before it is hit, then the correction if it is. Both sit
          under the field the collector is typing in, not in an alert they have
          to dismiss with one hand while holding a sack with the other. */}
      {outOfRange ? (
        <Text style={styles.weightProblem}>{outOfRange}</Text>
      ) : rangeHint ? (
        <Text style={styles.hint}>{rangeHint}</Text>
      ) : null}

      <View style={styles.labelRow}>
        <Text style={styles.label}>MATERIAL</Text>
        {catalogue.isFallback ? <Text style={styles.labelNote}>default list</Text> : null}
      </View>
      <View style={styles.materials}>
        {catalogue.pickable.map((m) => {
          const active = m.code === material;
          return (
            <Pressable
              key={m.code}
              onPress={() => setMaterial(m.code)}
              style={[styles.chip, active && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={m.description ? `${m.name}. ${m.description}` : m.name}
            >
              {/* Name over code, not code alone: a collector recognises "Milk
                  jugs, crates" faster than "HDPE", but the code is what gets
                  signed and appears in the audit report, so it stays visible. */}
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{m.name}</Text>
              {m.name === m.code ? null : (
                <Text style={[styles.chipCode, active && styles.chipCodeActive]}>{m.code}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
      {selected?.description ? <Text style={styles.hint}>{selected.description}</Text> : null}

      {/* The products this material covers. Tags rather than a sentence: a
          collector is matching the object in their hand against a list, and
          separate tags survive a glance where prose has to be read. */}
      {selected && selected.examples.length > 0 ? (
        <View
          style={styles.products}
          accessible
          accessibilityLabel={`Counted as ${selected.name}: ${selected.examples.join(", ")}`}
        >
          {selected.examples.map((example) => (
            <View key={example} style={styles.product}>
              <Text style={styles.productText}>{example}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <Pressable
        style={[styles.primary, (!weightValid || busy) && styles.primaryDisabled]}
        onPress={capture}
        disabled={!weightValid || busy}
      >
        {busy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator color={colors.onAccent} />
            <Text style={styles.primaryLabel}>{step}</Text>
          </View>
        ) : (
          <Text style={styles.primaryLabel}>Record weigh-in</Text>
        )}
      </Pressable>

      <Text style={styles.footnote}>
        Recorded offline and signed on this phone. It syncs when there is a
        connection.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: space.md, paddingBottom: space.xl, gap: space.sm },
  cameraFrame: {
    height: 220,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  camera: { flex: 1 },
  cameraBadge: {
    position: "absolute",
    left: space.sm,
    bottom: space.sm,
    backgroundColor: "rgba(11,15,14,0.78)",
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
  },
  cameraBadgeText: { color: colors.text, fontSize: 12, fontWeight: "600" },

  label: {
    ...type.label,
    color: colors.textMuted,
    marginTop: space.md,
  },
  weightRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  weightInput: {
    flex: 1,
    color: colors.text,
    fontSize: type.display.fontSize,
    fontWeight: "700",
    paddingVertical: 0,
  },
  unit: { color: colors.textMuted, fontSize: 22, fontWeight: "600", paddingBottom: space.sm },

  materials: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 15, fontWeight: "700" },
  chipTextActive: { color: colors.onAccent },
  /** The signed code, under the human name. */
  chipCode: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.6,
    marginTop: 1,
  },
  // textFaint is tuned for the dark surface and disappears on the accent fill.
  chipCodeActive: { color: colors.onAccent, opacity: 0.75 },

  products: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.sm },
  product: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  productText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },

  labelRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  labelNote: { ...type.label, color: colors.textFaint, marginTop: space.md },
  /** Field guidance for the selected material: what actually counts as it. */
  hint: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: space.sm,
  },
  /**
   * A weight this hub will not accept. Same colour as a rejected record in the
   * queue, so the two states read as the same thing at a glance — one caught in
   * time, one caught too late.
   */
  weightProblem: {
    color: colors.rejected,
    fontSize: 13,
    lineHeight: 18,
    marginTop: space.sm,
  },

  primary: {
    marginTop: space.lg,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: space.md + 4,
    alignItems: "center",
  },
  primaryDisabled: { opacity: 0.4 },
  primaryLabel: { color: colors.onAccent, fontSize: 17, fontWeight: "700" },
  busyRow: { flexDirection: "row", alignItems: "center", gap: space.sm },

  footnote: {
    color: colors.textFaint,
    fontSize: 13,
    textAlign: "center",
    marginTop: space.md,
  },

  permission: { flex: 1, justifyContent: "center", padding: space.lg, gap: space.md },
  permissionTitle: { ...type.title, color: colors.text },
  permissionBody: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
});
