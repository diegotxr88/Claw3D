"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { OfficePresenceSnapshot } from "@/lib/office/presence";

type UseRemoteOfficePresenceParams = {
  enabled: boolean;
  sourceKind: "presence_endpoint" | "openclaw_gateway";
  presenceUrl: string;
  gatewayUrl: string;
  pollIntervalMs?: number;
};

type UseRemoteOfficePresenceResult = {
  error: string | null;
  loaded: boolean;
  snapshot: OfficePresenceSnapshot | null;
};

export const useRemoteOfficePresence = ({
  enabled,
  sourceKind,
  presenceUrl,
  gatewayUrl,
  pollIntervalMs = 5_000,
}: UseRemoteOfficePresenceParams): UseRemoteOfficePresenceResult => {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<OfficePresenceSnapshot | null>(null);
  const successLoggedRef = useRef(false);
  const lastLoggedErrorRef = useRef<string | null>(null);
  const active =
    enabled &&
    (sourceKind === "presence_endpoint"
      ? presenceUrl.trim().length > 0
      : gatewayUrl.trim().length > 0);
  const requestUrl = useMemo(() => {
    if (!active) return "";
    const searchParams = new URLSearchParams({
      source: sourceKind === "presence_endpoint" ? "remote" : "remote-gateway",
    });
    return `/api/office/presence?${searchParams.toString()}`;
  }, [active, sourceKind]);

  useEffect(() => {
    if (!active) return;
    console.info("[remote-office] Starting presence polling.", {
      sourceKind,
      configuredPresenceUrl: presenceUrl,
      configuredGatewayUrl: gatewayUrl,
      requestUrl,
      pollIntervalMs,
    });
    let cancelled = false;
    let intervalId: number | null = null;
    const loadSnapshot = async () => {
      try {
        const response = await fetch(requestUrl, { cache: "no-store" });
        const payload = (await response.json()) as
          | OfficePresenceSnapshot
          | { error?: string };
        if (!response.ok) {
          const errorMessage =
            typeof payload === "object" &&
            payload !== null &&
            "error" in payload &&
            typeof payload.error === "string"
              ? payload.error
              : "Failed to load remote office presence.";
          throw new Error(
            errorMessage
          );
        }
        if (cancelled) return;
        setSnapshot(payload as OfficePresenceSnapshot);
        setError(null);
        if (!successLoggedRef.current) {
          const resolvedSnapshot = payload as OfficePresenceSnapshot;
          console.info("[remote-office] Presence polling succeeded.", {
            configuredPresenceUrl: presenceUrl,
            configuredGatewayUrl: gatewayUrl,
            agentCount: resolvedSnapshot.agents.length,
            timestamp: resolvedSnapshot.timestamp,
          });
          successLoggedRef.current = true;
          lastLoggedErrorRef.current = null;
        }
      } catch (loadError) {
        if (cancelled) return;
        const message =
          loadError instanceof Error
            ? loadError.message
            : "Failed to load remote office presence.";
        setError(message);
        if (lastLoggedErrorRef.current !== message) {
          console.warn("[remote-office] Presence polling failed.", {
            configuredPresenceUrl: presenceUrl,
            configuredGatewayUrl: gatewayUrl,
            error: message,
          });
          lastLoggedErrorRef.current = message;
          successLoggedRef.current = false;
        }
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    };
    void loadSnapshot();
    intervalId = window.setInterval(() => {
      void loadSnapshot();
    }, Math.max(1_000, pollIntervalMs));
    return () => {
      cancelled = true;
      successLoggedRef.current = false;
      lastLoggedErrorRef.current = null;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [active, gatewayUrl, pollIntervalMs, presenceUrl, requestUrl, sourceKind]);

  return {
    error: active ? error : null,
    loaded: active ? loaded : false,
    snapshot: active ? snapshot : null,
  };
};
