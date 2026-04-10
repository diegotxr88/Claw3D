import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OfficeLayoutSnapshot } from "@/lib/office/layoutSnapshot";
import type { OfficeAgentPresence, OfficePresenceSnapshot } from "@/lib/office/presence";

const DEFAULT_LOOP_LAYOUT_WIDTH = 1800;
const DEFAULT_LOOP_LAYOUT_HEIGHT = 720;

type MissionControlAgent = {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  gateway_agent_id?: string | null;
};

const CANONICAL_LOOP_AGENT_NAMES = new Set([
  "analista",
  "analistamercado",
  "coder",
  "escritor",
  "escritor-financeiro",
  "image understanding",
  "monitor-financas",
  "loop",
  "manutencao",
  "pesquisador",
]);

const normalizeLoopAgentName = (value: string | null | undefined) =>
  (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

const normalizeOfficeState = (value: string | null | undefined) => {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (
    normalized === "working" ||
    normalized === "idle" ||
    normalized === "meeting" ||
    normalized === "error"
  ) {
    return normalized;
  }
  if (normalized === "online") return "idle";
  if (normalized === "offline") return "idle";
  if (normalized === "standby") return "idle";
  return "idle";
};

const normalizeLoopName = (value: string | null | undefined, fallback: string) => {
  const trimmed = value?.trim() ?? "";
  if (fallback.trim().toLowerCase() === "main" && trimmed.toLowerCase() === "doc") {
    return "Loop";
  }
  if (!trimmed) return fallback;
  return trimmed;
};

const fetchJsonWithTimeout = async (
  url: string,
  headers: HeadersInit = {},
  timeoutMs = 3_000,
) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}.`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeoutId);
  }
};

const readLoopConnectionMissionControlUrl = () => {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "config", "loop-connection.json");
    if (!fs.existsSync(configPath)) return "";
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      loop?: {
        remote?: {
          mission_control?: string | null;
          ngrok_url?: string | null;
        };
      };
    };
    return (
      parsed.loop?.remote?.mission_control?.trim() ||
      parsed.loop?.remote?.ngrok_url?.trim() ||
      ""
    );
  } catch {
    return "";
  }
};

const readLoopRemoteConnection = () => {
  try {
    const configPath = path.join(
      os.homedir(),
      ".openclaw",
      "config",
      "connections",
      "loop-remote.json",
    );
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      connection?: {
        remote?: {
          mission_control?: string | null;
          gateway?: string | null;
        };
      };
    };
    return {
      missionControlUrl: parsed.connection?.remote?.mission_control?.trim() || "",
      gatewayUrl: parsed.connection?.remote?.gateway?.trim() || "",
    };
  } catch {
    return null;
  }
};

export const resolveLoopMissionControlUrl = () =>
  process.env.MISSION_CONTROL_LOOP_URL?.trim() ||
  readLoopRemoteConnection()?.missionControlUrl ||
  readLoopConnectionMissionControlUrl();

export const resolveLoopGatewayUrl = () =>
  process.env.OPENCLAW_LOOP_GATEWAY_URL?.trim() ||
  readLoopRemoteConnection()?.gatewayUrl ||
  "";

const resolveLoopHeaders = () => {
  const headers: HeadersInit = { cache: "no-store" };
  const token = process.env.MC_API_TOKEN_LOOP?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

const mapMissionControlAgentsToPresence = (
  agents: MissionControlAgent[],
): OfficeAgentPresence[] => {
  const deduped = new Map<string, OfficeAgentPresence>();
  agents.forEach((agent, index) => {
    // Prefer the stable gateway id over the MC internal UUID so the office roster
    // does not treat the same remote agent as a separate person.
    const agentId =
      agent.gateway_agent_id?.trim() || agent.id?.trim() || `loop-${index + 1}`;
    if (!agentId) return;
    const resolvedName = normalizeLoopName(agent.name, agentId);
    const normalizedName = normalizeLoopAgentName(resolvedName);
    if (!CANONICAL_LOOP_AGENT_NAMES.has(normalizedName)) {
      return;
    }
    const canonicalKey = normalizedName || agentId.trim().toLowerCase();
    if (deduped.has(canonicalKey)) {
      return;
    }
    deduped.set(canonicalKey, {
      agentId,
      name: resolvedName,
      state: normalizeOfficeState(agent.status),
    });
  });
  return Array.from(deduped.values());
};

export const loadLoopOfficePresenceSnapshot = async (): Promise<OfficePresenceSnapshot> => {
  const timestamp = new Date().toISOString();
  const remoteMissionControlUrl = resolveLoopMissionControlUrl();

  if (remoteMissionControlUrl) {
    try {
      const payload = (await fetchJsonWithTimeout(
        `${remoteMissionControlUrl.replace(/\/$/, "")}/api/agents`,
        resolveLoopHeaders(),
      )) as MissionControlAgent[];
      if (Array.isArray(payload) && payload.length > 0) {
        return {
          workspaceId: "remote",
          timestamp,
          agents: mapMissionControlAgentsToPresence(payload),
        };
      }
    } catch {}
  }

  return {
    workspaceId: "remote",
    timestamp,
    agents: [],
  };
};

export const loadLoopOfficeLayoutSnapshot = (): OfficeLayoutSnapshot | null => {
  const layoutPath = path.join(os.homedir(), ".openclaw", "claw3d", "loop-office-layout.json");
  if (!fs.existsSync(layoutPath)) return null;
  try {
    const raw = fs.readFileSync(layoutPath, "utf8");
    const parsed = JSON.parse(raw) as OfficeLayoutSnapshot;
    return {
      gatewayUrl: "loop-office",
      timestamp: parsed.timestamp || new Date().toISOString(),
      width: parsed.width || DEFAULT_LOOP_LAYOUT_WIDTH,
      height: parsed.height || DEFAULT_LOOP_LAYOUT_HEIGHT,
      furniture: Array.isArray(parsed.furniture) ? parsed.furniture : [],
    };
  } catch {
    return null;
  }
};
