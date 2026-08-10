import { useCallback, useMemo, useRef, useState } from "react";
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
import { colors, radius, space, type } from "../theme";
import type { DeviceIdentity, DeviceMeta } from "../lib/identity";
import { signWeighIn } from "../lib/identity";
import { enqueue, type QueuedWeighIn } from "../lib/queue";
import { appStore, currentFix, hashPhotoFile, randomNonce } from "../lib/native";

const MATERIALS: MaterialType[] = ["PET", "HDPE", "LDPE", "PP", "MIXED"];

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
  const [material, setMaterial] = useState<MaterialType>("PET");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);

  const weightKg = useMemo(() => Number.parseFloat(weight.replace(",", ".")), [weight]);
  const weightValid = Number.isFinite(weightKg) && weightKg > 0 && weightKg <= 500;

  const capture = useCallback(async () => {
    if (!weightValid || busy) return;

    setBusy(true);
    try {
      setStep("Photographing");
      const photo = await camera.current?.takePictureAsync({ quality: 0.6, skipProcessing: true });
      if (!photo?.uri) throw new Error("camera returned no image");

      setStep("Hashing photo");
      const photoHash = await hashPhotoFile(photo.uri);

      setStep("Getting GPS fix");
      const fix = await currentFix();

      setStep("Signing");
      const payload: WeighInPayload = {
        schema: "proofchain.weighin.v1",
        collectorId: device.collectorId,
        hubId: device.hubId,
        deviceId: device.deviceId,
        weightKg,
        material,
        lat: fix.lat,
        lng: fix.lng,
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
          maxLength={7}
        />
        <Text style={styles.unit}>kg</Text>
      </View>

      <Text style={styles.label}>MATERIAL</Text>
      <View style={styles.materials}>
        {MATERIALS.map((m) => {
          const active = m === material;
          return (
            <Pressable
              key={m}
              onPress={() => setMaterial(m)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{m}</Text>
            </Pressable>
          );
        })}
      </View>

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
