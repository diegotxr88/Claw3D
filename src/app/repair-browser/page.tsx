"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const LOCAL_STORAGE_KEYS = [
  "openclaw.device.auth.v1",
  "openclaw-device-identity-v1",
  "openclaw-office-atm-migration-v1",
  "openclaw-office-gym-room-migration-v3",
  "openclaw-office-camera-view-v1",
];

export default function RepairBrowserPage() {
  const router = useRouter();

  useEffect(() => {
    try {
      for (const key of LOCAL_STORAGE_KEYS) {
        window.localStorage.removeItem(key);
      }
      window.sessionStorage.clear();
    } catch {
      // Best-effort cleanup only.
    }

    router.replace("/office");
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-foreground">Repairing Claw3D browser state…</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Clearing saved local connection state and redirecting to the office.
        </p>
      </div>
    </main>
  );
}
