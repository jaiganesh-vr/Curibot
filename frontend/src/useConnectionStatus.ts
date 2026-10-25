import { useCallback, useEffect, useState } from "react";
import { checkHealth, type HealthStatus } from "./api/client";

export type ConnectionStatus = "checking" | HealthStatus;

const POLL_INTERVAL_MS = 30_000;

/**
 * Track whether the backend is reachable while `enabled` is true.
 *
 * Polls the readiness endpoint while the tab is visible, re-checks when the
 * tab returns or the browser comes back online, and reports "offline"
 * immediately when the browser loses its network connection.
 */
export function useConnectionStatus(enabled: boolean) {
  const [status, setStatus] = useState<ConnectionStatus>("checking");

  const recheck = useCallback(async () => {
    setStatus(await checkHealth());
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    async function check() {
      const result = await checkHealth();

      if (!cancelled) {
        setStatus(result);
      }
    }

    function checkIfVisible() {
      if (document.visibilityState === "visible") {
        void check();
      }
    }

    function markOffline() {
      setStatus("offline");
    }

    void check();
    const interval = window.setInterval(checkIfVisible, POLL_INTERVAL_MS);
    window.addEventListener("online", checkIfVisible);
    window.addEventListener("offline", markOffline);
    document.addEventListener("visibilitychange", checkIfVisible);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("online", checkIfVisible);
      window.removeEventListener("offline", markOffline);
      document.removeEventListener("visibilitychange", checkIfVisible);
    };
  }, [enabled]);

  return { status, recheck };
}
