import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { syncPending, type SyncOutcome } from "./api";
import { appStore, isOnline } from "./native";

/**
 * Drain the queue without the collector having to think about it.
 *
 * Relying on a manual "Sync now" tap means a phone can end a shift holding
 * unsynced weight simply because nobody pressed the button — that is unpaid
 * work. So we attempt a sync on mount, whenever the app returns to the
 * foreground (the moment a phone is most likely to have just regained signal),
 * and on a slow timer as a backstop.
 *
 * A single in-flight guard matters more than it looks: two overlapping passes
 * would both read the same pending records and post them twice. The server
 * deduplicates on payload hash, so this would not corrupt data, but it would
 * waste a field connection that is often metered and slow.
 */
const SYNC_INTERVAL_MS = 60_000;

export function useAutoSync(onSynced: () => void) {
  const [lastOutcome, setLastOutcome] = useState<SyncOutcome | null>(null);
  const [syncing, setSyncing] = useState(false);
  const inFlight = useRef(false);
  // Kept in a ref so the interval and subscription never rebind on re-render.
  const notify = useRef(onSynced);
  notify.current = onSynced;

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSyncing(true);

    try {
      const outcome = await syncPending(appStore, { isOnline });
      setLastOutcome(outcome);
      if (outcome.synced > 0 || outcome.rejected > 0) notify.current();
    } catch {
      // Never surface a background failure as an alert: the collector did not
      // ask for this pass, and the records stay queued for the next one.
    } finally {
      inFlight.current = false;
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void run();

    const timer = setInterval(() => void run(), SYNC_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void run();
    });

    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [run]);

  return { syncNow: run, syncing, lastOutcome };
}
