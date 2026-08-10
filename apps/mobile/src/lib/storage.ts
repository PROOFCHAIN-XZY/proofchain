/**
 * Storage ports.
 *
 * The queue and enrolment logic depend on these interfaces, never on
 * AsyncStorage or SecureStore directly. That keeps the parts that can lose a
 * collector's unpaid work testable in Node, and it documents the one distinction
 * that actually matters here: the device private key belongs in the hardware
 * keystore, while the weigh-in queue only needs durable app storage.
 */

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** In-memory implementation used by tests. */
export function createMemoryStore(seed: Record<string, string> = {}): KeyValueStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}
