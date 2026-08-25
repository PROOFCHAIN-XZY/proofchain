/**
 * Bluetooth scale integration (Web Bluetooth).
 *
 * Reads the standard Bluetooth SIG Weight Scale service (0x181D), which the
 * off-the-shelf industrial scales the plan calls for typically expose. Buying
 * reliability beats building load-cell hardware in v1.
 *
 * Two things this deliberately does NOT do:
 *   - It does not treat a scale reading as trusted. A Bluetooth reading is a
 *     convenience over typing; a tampered scale produces a tampered number
 *     either way. Source-level assurance comes from the enrolled-device
 *     signature and photo, not from the transport.
 *   - It does not block capture. If pairing fails or the browser lacks Web
 *     Bluetooth, manual entry stays available — a hub cannot stop working
 *     because a phone will not pair.
 */

const WEIGHT_SCALE_SERVICE = 0x181d;
const WEIGHT_MEASUREMENT_CHARACTERISTIC = 0x2a9d;

export interface ScaleReading {
  weightKg: number;
  stable: boolean;
  at: string;
}

export function isSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/**
 * Parse a Weight Measurement characteristic value.
 *
 * Flags bit 0 selects units: 0 = SI (kg, 5 mg resolution), 1 = Imperial
 * (pounds, 0.01 lb resolution).
 */
export function parseWeightMeasurement(view: DataView): ScaleReading {
  const flags = view.getUint8(0);
  const imperial = (flags & 0x01) === 1;
  const raw = view.getUint16(1, /* littleEndian */ true);

  const weightKg = imperial ? raw * 0.01 * 0.45359237 : raw * 0.005;

  return {
    weightKg: Number(weightKg.toFixed(3)),
    // Bit 1 is "timestamp present" in the spec; scales commonly reuse a vendor
    // bit for stability. Absent a vendor profile, treat every reading as final
    // and let the collector confirm before signing.
    stable: true,
    at: new Date().toISOString(),
  };
}

export interface ScaleConnection {
  deviceName: string;
  disconnect: () => void;
}

export async function connectScale(
  onReading: (reading: ScaleReading) => void,
): Promise<ScaleConnection> {
  if (!isSupported()) {
    throw new Error("this browser does not support Web Bluetooth — use manual entry");
  }

  const bluetooth = (navigator as Navigator & { bluetooth: any }).bluetooth;

  const device = await bluetooth.requestDevice({
    filters: [{ services: [WEIGHT_SCALE_SERVICE] }],
    optionalServices: [WEIGHT_SCALE_SERVICE],
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(WEIGHT_SCALE_SERVICE);
  const characteristic = await service.getCharacteristic(WEIGHT_MEASUREMENT_CHARACTERISTIC);

  const listener = (event: Event) => {
    const value = (event.target as unknown as { value: DataView }).value;
    try {
      onReading(parseWeightMeasurement(value));
    } catch {
      // A malformed frame must not kill the notification subscription.
    }
  };

  characteristic.addEventListener("characteristicvaluechanged", listener);
  await characteristic.startNotifications();

  return {
    deviceName: device.name ?? "Bluetooth scale",
    disconnect: () => {
      characteristic.removeEventListener("characteristicvaluechanged", listener);
      try {
        device.gatt.disconnect();
      } catch {
        // Already gone; nothing to do.
      }
    },
  };
}
