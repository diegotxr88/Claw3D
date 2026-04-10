import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NextResponse } from "next/server";

import { AgentStatusCache } from "@/lib/office/agentStatusCache";
import { loadOfficePresenceSnapshot, type OfficePresenceSnapshot } from "@/lib/office/presence";
import { slugifyAgentName } from "@/lib/gateway/agentConfig";
import { loadStudioSettings } from "@/lib/studio/settings-store";

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const LOOP_PROFILE_ID = "loop-macbook";

// Configuração dos dois MCs
const MC_CONFIGS = [
  {
    name: "M2-Doc",
    url: "http://127.0.0.1:4000",
    token: process.env.MC_API_TOKEN?.trim() ?? "",
    isLocal: true,
  },
  {
    name: "i5-Loop", 
    url: "http://100.119.42.68:4000", // Tailscale IP atual do i5
    token: process.env.MC_I5_API_TOKEN?.trim() ?? process.env.MC_API_TOKEN?.trim() ?? "",
    isLocal: false,
  },
];

type MissionControlAgent = {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  gateway_agent_id?: string | null;
  gateway_profile_id?: string | null;
  avatar_emoji?: string | null;
  source?: string | null;
};

type MissionControlTask = {
  assigned_agent_id?: string | null;
  status?: string | null;
};

type AggregatedAgent = {
  name: string;
  status: string;
  gateway_agent_id: string;
  source: "local" | "loop";
  avatar_emoji: string;
  mcSource: string; // Identifica qual MC
};

const resolveMissionControlDbPath = () =>
  path.join(os.homedir(), "mission-control", "mission-control.db");
const SQLITE3_BIN = "/usr/bin/sqlite3";

const readSqliteJson = <T,>(sql: string): T[] => {
  try {
    const raw = execFileSync(
      SQLITE3_BIN,
      ["-json", resolveMissionControlDbPath(), sql],
      { encoding: "utf8" },
    ).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const loadLocalCatalogFromDb = () =>
  readSqliteJson<MissionControlAgent>(
    [
      "SELECT",
      " id, name, status, gateway_agent_id, gateway_profile_id, avatar_emoji, source",
      " FROM agents",
      " ORDER BY name COLLATE NOCASE ASC;",
    ].join(""),
  );

const loadLocalTasksFromDb = () =>
  readSqliteJson<MissionControlTask>(
    [
      "SELECT",
      " assigned_agent_id, status",
      " FROM tasks",
      " WHERE status IN ('assigned','in_progress','testing','review','verification');",
    ].join(""),
  );

const resolveLocalOfficeAgentId = (agent: MissionControlAgent) => {
  const gatewayAgentId = agent.gateway_agent_id?.trim() ?? "";
  if (gatewayAgentId) return gatewayAgentId;
  const slug = safeSlugifyAgentName(agent.name);
  if (slug) return slug;
  return agent.id?.trim() || "";
};

const fetchJsonWithTimeout = async (
  url: string,
  headers: HeadersInit,
  timeoutMs = FETCH_TIMEOUT_MS,
) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const normalizeStatus = (value: string | null | undefined) => {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "working" || normalized === "meeting") return "working";
  if (normalized === "error") return "error";
  if (normalized === "idle" || normalized === "standby" || normalized === "offline") {
    return "standby";
  }
  return "standby";
};

const safeSlugifyAgentName = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    return slugifyAgentName(trimmed);
  } catch {
    return "";
  }
};

const buildActiveTaskGatewayAgentIds = (
  tasks: MissionControlTask[],
  agents: MissionControlAgent[],
) => {
  const activeStatuses = new Set(["assigned", "in_progress", "testing", "review", "verification"]);
  const gatewayAgentIdByInternalId = new Map(
    agents.map((agent) => [
      String(agent.id ?? "").trim(),
      resolveLocalOfficeAgentId(agent),
    ]),
  );
  return new Set(
    tasks
      .filter((task) => activeStatuses.has(String(task.status ?? "").trim()))
      .map((task) => {
        const assignedId = String(task.assigned_agent_id ?? "").trim();
        return gatewayAgentIdByInternalId.get(assignedId) || assignedId;
      })
      .filter(Boolean),
  );
};

// Busca agentes de um MC específico
async function fetchMCAgents(
  mcConfig: typeof MC_CONFIGS[0]
): Promise<{ agents: MissionControlAgent[]; tasks: MissionControlTask[]; success: boolean }> {
  const headers: HeadersInit = { cache: "no-store" };
  if (mcConfig.token) headers.Authorization = `Bearer ${mcConfig.token}`;

  try {
    const [agentsRes, tasksRes] = await Promise.all([
      fetchJsonWithTimeout(`${mcConfig.url}/api/agents`, headers),
      fetchJsonWithTimeout(`${mcConfig.url}/api/tasks`, headers),
    ]);

    const agents = agentsRes.ok ? await agentsRes.json() : [];
    const tasks = tasksRes.ok ? await tasksRes.json() : [];

    return { agents, tasks, success: agentsRes.ok && tasksRes.ok };
  } catch (error) {
    console.error(`[MC ${mcConfig.name}] Failed to fetch:`, error);
    return { agents: [], tasks: [], success: false };
  }
}

export async function GET() {
  try {
    const allAgents: AggregatedAgent[] = [];
    const processedAgentIds = new Set<string>();

    // Buscar de ambos os MCs em paralelo
    const mcResults = await Promise.all(
      MC_CONFIGS.map(async (mcConfig) => {
        const result = await fetchMCAgents(mcConfig);
        return { ...result, mcConfig };
      })
    );

    for (const { agents, tasks, success, mcConfig } of mcResults) {
      if (!success) {
        console.warn(`[MC ${mcConfig.name}] Unavailable, skipping...`);
        continue;
      }

      const activeTaskAgentIds = buildActiveTaskGatewayAgentIds(tasks, agents);

      for (const agent of agents) {
        const gatewayAgentId = resolveLocalOfficeAgentId(agent);
        if (!gatewayAgentId) continue;

        // Cria ID único combinando gateway_agent_id com a fonte do MC
        const uniqueId = `${gatewayAgentId}@${mcConfig.name}`;
        
        // Evita duplicatas
        if (processedAgentIds.has(uniqueId)) continue;
        processedAgentIds.add(uniqueId);

        // Define o status: se tiver tarefa ativa = working, senão = status do agente
        const hasActiveTask = activeTaskAgentIds.has(gatewayAgentId);
        const finalStatus = hasActiveTask ? "working" : normalizeStatus(agent.status);

        allAgents.push({
          name: agent.name?.trim() || "Unknown",
          status: finalStatus,
          gateway_agent_id: gatewayAgentId,
          source: mcConfig.isLocal ? "local" : "loop",
          avatar_emoji: agent.avatar_emoji?.trim() ?? "",
          mcSource: mcConfig.name,
        });
      }
    }

    // Fallback: se nenhum MC respondeu, tentar banco local
    if (allAgents.length === 0) {
      console.warn("[MC Agents] No MCs responded, falling back to local DB");
      const localCatalog = loadLocalCatalogFromDb();
      const localTasks = loadLocalTasksFromDb();
      const localTaskAgentIds = buildActiveTaskGatewayAgentIds(localTasks, localCatalog);

      for (const agent of localCatalog) {
        const gatewayAgentId = resolveLocalOfficeAgentId(agent);
        if (!gatewayAgentId) continue;

        const hasActiveTask = localTaskAgentIds.has(gatewayAgentId);
        const finalStatus = hasActiveTask ? "working" : normalizeStatus(agent.status);

        allAgents.push({
          name: agent.name?.trim() || "Unknown",
          status: finalStatus,
          gateway_agent_id: gatewayAgentId,
          source: "local",
          avatar_emoji: agent.avatar_emoji?.trim() ?? "",
          mcSource: "local-db",
        });
      }
    }

    // Ordenar: working primeiro, depois por nome
    allAgents.sort((a, b) => {
      if (a.status === "working" && b.status !== "working") return -1;
      if (a.status !== "working" && b.status === "working") return 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json(allAgents);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to reach Mission Control";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
