import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

type GatewayClientLike = {
  start: () => void;
  stop?: () => void;
  close?: () => void;
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};

type GatewayClientConstructor = new (opts: Record<string, unknown>) => GatewayClientLike;

type DeviceIdentity = unknown;

let openClawGatewayClientCtorPromise: Promise<GatewayClientConstructor> | null = null;
let openClawReadScopePromise: Promise<string> | null = null;
let openClawDeviceIdentityPromise: Promise<DeviceIdentity | null> | null = null;

const resolveOpenClawDistFile = (prefix: string): string => {
  const distDir = "/opt/homebrew/lib/node_modules/openclaw/dist";
  const entry =
    fs.readdirSync(distDir).find((name) => name.startsWith(prefix) && name.endsWith(".js")) ?? null;
  if (!entry) {
    throw new Error(`OpenClaw dist module not found for prefix: ${prefix}`);
  }
  return path.join(distDir, entry);
};

const importOpenClawDistModule = async (prefix: string): Promise<Record<string, unknown>> => {
  const filePath = resolveOpenClawDistFile(prefix);
  return (await import(/* webpackIgnore: true */ filePath)) as Record<string, unknown>;
};

const loadOfficialGatewayClientCtor = async (): Promise<GatewayClientConstructor> => {
  if (!openClawGatewayClientCtorPromise) {
    openClawGatewayClientCtorPromise = (async () => {
      const mod = await importOpenClawDistModule("method-scopes-");
      const ctor = mod.u;
      if (typeof ctor !== "function") {
        throw new Error("Failed to load OpenClaw GatewayClient constructor.");
      }
      return ctor as GatewayClientConstructor;
    })();
  }
  return openClawGatewayClientCtorPromise;
};

const loadOfficialReadScope = async (): Promise<string> => {
  if (!openClawReadScopePromise) {
    openClawReadScopePromise = (async () => {
      const mod = await importOpenClawDistModule("method-scopes-");
      const readScope = mod.a;
      if (typeof readScope !== "string" || !readScope.trim()) {
        throw new Error("Failed to load OpenClaw READ_SCOPE.");
      }
      return readScope;
    })();
  }
  return openClawReadScopePromise;
};

const loadOfficialDeviceIdentity = async (): Promise<DeviceIdentity | null> => {
  if (!openClawDeviceIdentityPromise) {
    openClawDeviceIdentityPromise = (async () => {
      try {
        const mod = await importOpenClawDistModule("device-identity-");
        const loadOrCreateDeviceIdentity = mod.loadOrCreateDeviceIdentity;
        if (typeof loadOrCreateDeviceIdentity !== "function") {
          return null;
        }
        return (await loadOrCreateDeviceIdentity()) as DeviceIdentity;
      } catch {
        return null;
      }
    })();
  }
  return openClawDeviceIdentityPromise;
};

export const buildAgentMainSessionKey = (agentId: string, mainKey: string) => {
  const trimmedAgent = agentId.trim();
  const trimmedKey = mainKey.trim() || "main";
  return `agent:${trimmedAgent}:${trimmedKey}`;
};

export class NodeGatewayClient {
  private client: GatewayClientLike | null = null;

  async connect(params: { gatewayUrl: string; token?: string | null; origin?: string | null }) {
    const gatewayUrl = params.gatewayUrl.trim();
    if (!gatewayUrl) {
      throw new Error("Remote office gateway URL is not configured.");
    }
    if (this.client) {
      throw new Error("Node gateway client is already connected.");
    }

    const [GatewayClient, readScope, deviceIdentity] = await Promise.all([
      loadOfficialGatewayClientCtor(),
      loadOfficialReadScope(),
      loadOfficialDeviceIdentity(),
    ]);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          gatewayClient.stop?.();
        } catch {}
        reject(new Error("Remote gateway connect handshake timed out."));
      }, 12_000);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        fn();
      };

      const gatewayClient = new GatewayClient({
        url: gatewayUrl,
        token: params.token?.trim() || undefined,
        scopes: [readScope],
        clientName: "cli",
        clientVersion: "dev",
        mode: "probe",
        instanceId: randomUUID(),
        deviceIdentity: deviceIdentity ?? undefined,
        onConnectError: (error: unknown) => {
          const message =
            error instanceof Error ? error.message : `Remote gateway connection failed: ${String(error)}`;
          settle(() => reject(new Error(message)));
        },
        onClose: (code: number, reason: string) => {
          settle(() =>
            reject(new Error(`Remote gateway connection closed (${code})${reason ? `: ${reason}` : "."}`)),
          );
        },
        onHelloOk: () => {
          this.client = gatewayClient;
          settle(() => resolve());
        },
      });

      gatewayClient.start();
    });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.client) {
      throw new Error("Remote gateway is not connected.");
    }
    return await this.client.request<T>(method, params);
  }

  close() {
    if (!this.client) return;
    try {
      this.client.stop?.();
      this.client.close?.();
    } finally {
      this.client = null;
    }
  }
}
