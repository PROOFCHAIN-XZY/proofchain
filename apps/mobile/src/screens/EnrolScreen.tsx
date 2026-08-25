import { useCallback, useState } from "react";
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
import { colors, radius, space, type } from "../theme";
import { enrolDevice, fetchCollectors, fetchHubs, getBackendUrl, operatorLogin, setBackendUrl } from "../lib/api";
import { saveDeviceMeta, type DeviceIdentity, type DeviceMeta } from "../lib/identity";
import { appStore, secureStore } from "../lib/native";

interface Props {
  identity: DeviceIdentity;
  onEnrolled: (meta: DeviceMeta) => void;
}

/**
 * One-time provisioning.
 *
 * An operator signs in here to bind this phone's public key to a collector. The
 * operator token is used for that single call and never stored: a shared field
 * phone must not carry standing credentials. After this, capture needs no login
 * at all — the device signature is the credential, which is precisely what lets
 * a collector work all day with no connection.
 */
export function EnrolScreen({ identity, onEnrolled }: Props) {
  const [backend, setBackend] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const [collectors, setCollectors] = useState<{ id: string; name: string }[]>([]);
  const [hubs, setHubs] = useState<
    { id: string; code: string; name: string; minWeightKg: number; maxWeightKg: number }[]
  >([]);
  const [token, setToken] = useState<string | null>(null);
  const [collectorId, setCollectorId] = useState<string | null>(null);
  const [hubId, setHubId] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    setBusy(true);
    try {
      if (backend.trim()) await setBackendUrl(appStore, backend);
      const url = await getBackendUrl(appStore);

      const accessToken = await operatorLogin(url, email.trim(), password);
      const [people, sites] = await Promise.all([
        fetchCollectors(url, accessToken),
        fetchHubs(url, accessToken),
      ]);

      setToken(accessToken);
      setCollectors(people);
      setHubs(sites);
      setCollectorId(people[0]?.id ?? null);
      setHubId(sites[0]?.id ?? null);
    } catch (error) {
      Alert.alert("Sign-in failed", (error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [backend, email, password]);

  const enrol = useCallback(async () => {
    if (!token || !collectorId || !hubId) return;

    setBusy(true);
    try {
      const url = await getBackendUrl(appStore);
      const { deviceId } = await enrolDevice(url, token, {
        collectorId,
        label: label.trim() || "field phone",
        publicKeyBase64: identity.publicKeyBase64,
      });

      const collector = collectors.find((c) => c.id === collectorId);
      const hub = hubs.find((h) => h.id === hubId);
      if (!hub) throw new Error("hub not found");

      const meta: DeviceMeta = {
        deviceId,
        collectorId,
        collectorName: collector?.name ?? "collector",
        hubId,
        hubName: hub.name,
        // Recorded now because this is the only moment the phone holds an
        // operator token; capture itself has no credential to fetch them with.
        minWeightKg: hub.minWeightKg,
        maxWeightKg: hub.maxWeightKg,
      };

      await saveDeviceMeta(secureStore, meta);
      onEnrolled(meta);
    } catch (error) {
      Alert.alert("Enrolment failed", (error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [collectorId, collectors, hubId, hubs, identity.publicKeyBase64, label, onEnrolled, token]);

  return (
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Enrol this phone</Text>
      <Text style={styles.body}>
        An operator signs in once to register this phone's signing key. The key was
        generated here and never leaves the device.
      </Text>

      {!token ? (
        <>
          <Field label="BACKEND URL" value={backend} onChange={setBackend} placeholder="http://10.0.2.2:3000" autoCapitalize="none" />
          <Field label="OPERATOR EMAIL" value={email} onChange={setEmail} placeholder="operator@proofchain.local" autoCapitalize="none" keyboardType="email-address" />
          <Field label="PASSWORD" value={password} onChange={setPassword} secure />

          <Pressable style={[styles.primary, busy && styles.disabled]} onPress={signIn} disabled={busy}>
            {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.primaryLabel}>Sign in</Text>}
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.label}>COLLECTOR</Text>
          <Options items={collectors.map((c) => ({ id: c.id, text: c.name }))} selected={collectorId} onSelect={setCollectorId} />

          <Text style={styles.label}>HUB</Text>
          <Options items={hubs.map((h) => ({ id: h.id, text: `${h.code} — ${h.name}` }))} selected={hubId} onSelect={setHubId} />

          <Field label="PHONE LABEL" value={label} onChange={setLabel} placeholder="field phone 1" />

          <Pressable style={[styles.primary, busy && styles.disabled]} onPress={enrol} disabled={busy}>
            {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.primaryLabel}>Enrol device</Text>}
          </Pressable>

          <Text style={styles.keyLabel}>PUBLIC KEY</Text>
          <Text style={styles.key}>{identity.publicKeyBase64}</Text>
        </>
      )}
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  autoCapitalize,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  autoCapitalize?: "none" | "sentences";
  keyboardType?: "email-address" | "default";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        secureTextEntry={secure}
        autoCapitalize={autoCapitalize ?? "sentences"}
        keyboardType={keyboardType ?? "default"}
      />
    </View>
  );
}

function Options({
  items,
  selected,
  onSelect,
}: {
  items: { id: string; text: string }[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <View style={styles.options}>
      {items.map((item) => {
        const active = item.id === selected;
        return (
          <Pressable
            key={item.id}
            style={[styles.option, active && styles.optionActive]}
            onPress={() => onSelect(item.id)}
          >
            <Text style={[styles.optionText, active && styles.optionTextActive]}>{item.text}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { padding: space.md, gap: space.sm, paddingBottom: space.xl },
  title: { ...type.title, color: colors.text },
  body: { color: colors.textMuted, fontSize: 15, lineHeight: 22, marginBottom: space.md },

  field: { marginTop: space.sm },
  label: { ...type.label, color: colors.textMuted, marginTop: space.sm },
  input: {
    marginTop: space.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    color: colors.text,
    fontSize: 16,
  },

  options: { gap: space.sm, marginTop: space.xs },
  option: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.md,
  },
  optionActive: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  optionText: { color: colors.textMuted, fontSize: 15, fontWeight: "600" },
  optionTextActive: { color: colors.text },

  primary: {
    marginTop: space.lg,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    alignItems: "center",
  },
  disabled: { opacity: 0.5 },
  primaryLabel: { color: colors.onAccent, fontSize: 17, fontWeight: "700" },

  keyLabel: { ...type.label, color: colors.textFaint, marginTop: space.lg },
  key: { color: colors.textFaint, fontSize: 12, fontFamily: "monospace", marginTop: space.xs },
});
