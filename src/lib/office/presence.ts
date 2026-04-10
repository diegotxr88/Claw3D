import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "@/lib/clawdbot/paths";
import { readConfigAgentList } from "@/lib/gateway/agentConfig";
import { NodeGatewayClient, buildAgentMainSessionKey } from "@/lib/gateway/nodeGatewayClient";
import type { OfficeAgentState } from "@/lib/office/schema";

export type OfficeAgentPresence = {
  agentId: string;
  name: string;
  state: OfficeAgentState;
  preferredDeskId?: string;
};

export type OfficePresenceSnapshot = {
  workspaceId: string;
  timestamp: string;
  agents: OfficeAgentPresence[];
};

type GatewayAgentsListEntry = {
  id?: string;
  name?: string;
  identity?: {
    name?: string;
  };
};

type GatewayAgentsListResult = {
  agents?: GatewayAgentsListEntry[] | null;
};

const OPENCLAW_CONFIG_FILENAME = "openclaw.json";

export const loadOfficePresenceSnapshot = (workspaceId: string): OfficePresenceSnapshot => {
  const configPath = path.join(resolveStateDir(), OPENCLAW_CONFIG_FILENAME);
  const timestamp = new Date().toISOString();
  if (!fs.existsSync(configPath)) {
    return {
      workspaceId,
      timestamp,
      agents: [],
    };
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const config =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  const agentList = readConfigAgentList(config);
  const agents: OfficeAgentPresence[] = agentList.map((entry) => {
    const id = entry.id.trim();
    const nameRaw = typeof entry.name === "string" ? entry.name : id;
    return {
      agentId: id,
      name: nameRaw,
      state: "idle",
      preferredDeskId: `desk-${id}`,
    };
  });
  return {
    workspaceId,
    timestamp,
    agents,
  };
};

type RemoteOfficePresenceOptions = {
  presenceUrl: string;
  token?: string | null;
  timeoutMs?: number;
};

export const fetchRemoteOfficePresenceSnapshot = async (options: RemoteOfficePresenceOptions): Promise<OfficePresenceSnapshot> => {
  const { presenceUrl, token, timeoutMs = 10_000 } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(presenceUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Remote presence fetch failed: ${response.status} ${text}`);
    }
    const payload = (await response.json()) as unknown;
    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      "agents" in payload &&
      Array.isArray((payload as Record<string, unknown>).agents)
    ) {
      const typed = payload as OfficePresenceSnapshot;
      return {
        workspaceId: typed.workspaceId || "remote",
        timestamp: typed.timestamp || new Date().toISOString(),
        agents: typed.agents || [],
      };
    }
    throw new Error("Invalid remote presence snapshot structure.");
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
};

type RemoteGatewayOfficePresenceOptions = {
  gatewayUrl: string;
  token?: string | null;
  timeoutMs?: number;
  workspaceId?: string;
  origin?: string;
  isLoopGateway?: boolean;
};

export const fetchRemoteGatewayOfficePresenceSnapshot = async (
  options: RemoteGatewayOfficePresenceOptions,
): Promise<OfficePresenceSnapshot> => {
  const {
    gatewayUrl,
    token,
    timeoutMs = 10_000,
    workspaceId = "gateway",
    origin,
  } = options;
  const client = new NodeGatewayClient();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await client.connect({
      gatewayUrl,
      token,
      origin,
    });
    const list = await client.request<GatewayAgentsListResult>("agents.list", {});
    clearTimeout(timeoutId);
    const timestamp = new Date().toISOString();
    return {
      workspaceId,
      timestamp,
      agents:
        list.agents?.map((entry) => {
          const id = (entry?.id ?? "").trim();
          const name =
            (entry?.name ?? "").trim() ||
            (entry?.identity?.name ?? "").trim() ||
            id;
          return {
            agentId: id,
            name: name || id,
            state: "idle",
            preferredDeskId: id ? `desk-${id}` : undefined,
          };
        }) ?? [],
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  } finally {
    client.close();
  }
};
