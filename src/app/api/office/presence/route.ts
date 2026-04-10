import { NextResponse } from "next/server";

import {
  fetchRemoteGatewayOfficePresenceSnapshot,
  fetchRemoteOfficePresenceSnapshot,
  loadOfficePresenceSnapshot,
  type OfficeAgentPresence,
  type OfficePresenceSnapshot,
} from "@/lib/office/presence";
import {
  loadLoopOfficePresenceSnapshot,
  resolveLoopGatewayUrl,
  resolveLoopMissionControlUrl,
} from "@/lib/loopOffice";
import { slugifyAgentName } from "@/lib/gateway/agentConfig";
import { loadStudioSettings } from "@/lib/studio/settings-store";
import { resolveOfficePreference } from "@/lib/studio/settings";

export const runtime = "nodejs";

const LOOP_PROFILE_ID = "loop-macbook";
const LOCAL_MISSION_CONTROL_AGENTS_TIMEOUT_MS = 4_000;
const LOCAL_MISSION_CONTROL_TASKS_TIMEOUT_MS = 1_000;
const CANONICAL_LOCAL_AGENT_IDS = new Set([
  "doc",
  "analista",
  "atualizador",
  "coder",
  "codex",
  "coordenador",
  "curador",
  "escritor",
  "pesquisador",
  "produtor-video",
]);
const CANONICAL_REMOTE_LOOP_AGENT_NAMES = new Set([
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

type MissionControlLocalAgent = {
  id?: string | null;
  name?: string | null;
  gateway_agent_id?: string | null;
  gateway_profile_id?: string | null;
  status?: string | null;
  source?: string | null;
};

type MissionControlTask = {
  assigned_agent_id?: string | null;
  status?: string | null;
};

const resolveLocalOfficeAgentId = (agent: MissionControlLocalAgent) => {
  const gatewayAgentId =
    typeof agent.gateway_agent_id === "string" ? agent.gateway_agent_id.trim() : "";
  if (gatewayAgentId) {
    return gatewayAgentId;
  }
  const name = typeof agent.name === "string" ? agent.name.trim() : "";
  if (name) {
    return slugifyAgentName(name);
  }
  return typeof agent.id === "string" ? agent.id.trim() : "";
};

const normalizeLocalAgentId = (value: string) => value.trim().toLowerCase();
const normalizeRemoteAgentName = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

const pruneCanonicalLocalPresence = (
  snapshot: { workspaceId: string; timestamp: string; agents: OfficeAgentPresence[] },
) => {
  const hasCanonicalDoc = snapshot.agents.some(
    (agent) => normalizeLocalAgentId(agent.agentId) === "doc",
  );
  const filtered = snapshot.agents.filter((agent) => {
    const normalizedId = normalizeLocalAgentId(agent.agentId);
    if (CANONICAL_LOCAL_AGENT_IDS.has(normalizedId)) return true;
    if (normalizedId === "main" && hasCanonicalDoc) return false;
    return normalizedId !== "main";
  });
  return {
    ...snapshot,
    agents: filtered,
  };
};

const pruneCanonicalRemoteLoopPresence = (snapshot: OfficePresenceSnapshot) => {
  const filtered = snapshot.agents.filter((agent) =>
    CANONICAL_REMOTE_LOOP_AGENT_NAMES.has(normalizeRemoteAgentName(agent.name || agent.agentId)),
  );
  return {
    ...snapshot,
    agents: filtered,
  };
};

const mergeLocalMissionControlAgents = async (
  snapshot: { workspaceId: string; timestamp: string; agents: OfficeAgentPresence[] },
) => {
  const mcLocalUrl = process.env.MISSION_CONTROL_URL?.trim() || "http://127.0.0.1:4000";
  const mcLocalToken = process.env.MC_API_TOKEN?.trim() || "";
  const fetchJson = async <T,>(pathname: string, timeoutMs: number): Promise<T | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${mcLocalUrl}${pathname}`, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(mcLocalToken ? { Authorization: `Bearer ${mcLocalToken}` } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  try {
    const [payload, tasks] = await Promise.all([
      fetchJson<MissionControlLocalAgent[]>("/api/agents", LOCAL_MISSION_CONTROL_AGENTS_TIMEOUT_MS),
      fetchJson<MissionControlTask[]>("/api/tasks", LOCAL_MISSION_CONTROL_TASKS_TIMEOUT_MS),
    ]);
    if (!payload) {
      return snapshot;
    }
    const statusByAgentId = new Map<string, OfficeAgentPresence["state"]>();
    const nameByAgentId = new Map<string, string>();
    const gatewayAgentIdByInternalId = new Map<string, string>();
    const normalizeLocalState = (value: string | null | undefined): OfficeAgentPresence["state"] => {
      const normalized = String(value || "").trim().toLowerCase();
      if (normalized === "working" || normalized === "active" || normalized === "meeting") {
        return "working";
      }
      if (normalized === "error") {
        return "error";
      }
      return "idle";
    };
    for (const entry of Array.isArray(payload) ? payload : []) {
      const loopProfileId =
        typeof entry.gateway_profile_id === "string" ? entry.gateway_profile_id.trim() : "";
      const source = typeof entry.source === "string" ? entry.source.trim() : "";
      if (loopProfileId === LOOP_PROFILE_ID) {
        continue;
      }
      if (source !== "gateway" && source !== "local") {
        continue;
      }
      if (source === "gateway") {
        const gatewayAgentId =
          typeof entry.gateway_agent_id === "string" ? entry.gateway_agent_id.trim() : "";
        if (!gatewayAgentId) {
          continue;
        }
      }
      const agentId = resolveLocalOfficeAgentId(entry);
      if (!agentId) {
        continue;
      }
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      const internalId = typeof entry.id === "string" ? entry.id.trim() : "";
      if (internalId) {
        gatewayAgentIdByInternalId.set(internalId, agentId);
      }
      if (name) {
        nameByAgentId.set(agentId, name);
      }
      statusByAgentId.set(agentId, normalizeLocalState(entry.status));
    }
    const activeTaskStatuses = new Set(["assigned", "in_progress", "testing", "review", "verification"]);
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const taskStatus = typeof task.status === "string" ? task.status.trim().toLowerCase() : "";
      if (!activeTaskStatuses.has(taskStatus)) {
        continue;
      }
      const assignedInternalId =
        typeof task.assigned_agent_id === "string" ? task.assigned_agent_id.trim() : "";
      const localAgentId = gatewayAgentIdByInternalId.get(assignedInternalId);
      if (localAgentId) {
        statusByAgentId.set(localAgentId, "working");
      }
    }
    const mergedAgents = snapshot.agents.map((agent) => ({
      ...agent,
      state: statusByAgentId.get(agent.agentId) ?? agent.state,
    }));
    const knownAgentIds = new Set(mergedAgents.map((agent) => agent.agentId));
    const additionalAgents = Array.from(statusByAgentId.entries())
      .filter(([agentId]) => !knownAgentIds.has(agentId))
      .map(([agentId, state]) => ({
        agentId,
        name: nameByAgentId.get(agentId) ?? agentId,
        state,
      } satisfies OfficeAgentPresence));
    return pruneCanonicalLocalPresence({
      ...snapshot,
      agents: [...mergedAgents, ...additionalAgents],
    });
  } catch {
    return pruneCanonicalLocalPresence(snapshot);
  }
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestOrigin = url.origin;
    const source = url.searchParams.get("source")?.trim() || "local";
    const workspaceId = url.searchParams.get("workspaceId")?.trim() || "default";
    if (source === "remote") {
      const settings = loadStudioSettings();
      const gatewayUrl = settings.gateway?.url?.trim() || "";
      const officePreference = resolveOfficePreference(settings, gatewayUrl);
      const stableLoopMissionControlUrl = resolveLoopMissionControlUrl();
      if (
        officePreference.remoteOfficeSourceKind === "openclaw_gateway" &&
        stableLoopMissionControlUrl
      ) {
        const snapshot = pruneCanonicalRemoteLoopPresence(await loadLoopOfficePresenceSnapshot());
        return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
      }
      if (
        !officePreference.remoteOfficeEnabled ||
        !officePreference.remoteOfficePresenceUrl.trim()
      ) {
        return NextResponse.json(
          {
            workspaceId: "remote",
            timestamp: new Date().toISOString(),
            agents: [],
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      const startedAt = Date.now();
      console.info("[office-presence] Fetching remote office presence.", {
        presenceUrl: officePreference.remoteOfficePresenceUrl,
        tokenConfigured: Boolean(officePreference.remoteOfficeToken?.trim()),
      });
      const snapshot = pruneCanonicalRemoteLoopPresence(await fetchRemoteOfficePresenceSnapshot({
        presenceUrl: officePreference.remoteOfficePresenceUrl,
        token: officePreference.remoteOfficeToken,
        timeoutMs: 15_000,
      }));
      console.info("[office-presence] Remote office presence loaded.", {
        presenceUrl: officePreference.remoteOfficePresenceUrl,
        elapsedMs: Date.now() - startedAt,
        agentCount: snapshot.agents.length,
      });
      return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
    }
    if (source === "remote-gateway") {
      const settings = loadStudioSettings();
      const gatewayUrl = settings.gateway?.url?.trim() || "";
      const officePreference = resolveOfficePreference(settings, gatewayUrl);
      const requestedGatewayUrl = officePreference.remoteOfficeGatewayUrl.trim();
      const stableLoopGatewayUrl = resolveLoopGatewayUrl();
      const isLoopOfficeGateway =
        requestedGatewayUrl.length > 0 &&
        (requestedGatewayUrl === stableLoopGatewayUrl ||
          requestedGatewayUrl.includes("tail") ||
          requestedGatewayUrl.includes("ngrok"));
      if (
        !officePreference.remoteOfficeEnabled ||
        officePreference.remoteOfficeSourceKind !== "openclaw_gateway" ||
        !requestedGatewayUrl
      ) {
        return NextResponse.json(
          {
            workspaceId: "remote-gateway",
            timestamp: new Date().toISOString(),
            agents: [],
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      const startedAt = Date.now();
      console.info("[office-presence] Fetching remote gateway office presence.", {
        gatewayUrl: requestedGatewayUrl,
        tokenConfigured: Boolean(officePreference.remoteOfficeToken?.trim()),
      });
      let snapshot;
      if (isLoopOfficeGateway) {
        try {
          snapshot = pruneCanonicalRemoteLoopPresence(await loadLoopOfficePresenceSnapshot());
          if (snapshot.agents.length === 0) {
            snapshot = pruneCanonicalRemoteLoopPresence(await fetchRemoteGatewayOfficePresenceSnapshot({
              gatewayUrl: requestedGatewayUrl,
              token: officePreference.remoteOfficeToken,
              workspaceId: "remote-gateway",
              origin: requestOrigin,
              isLoopGateway: true,
            }));
          }
        } catch {
          snapshot = pruneCanonicalRemoteLoopPresence(await fetchRemoteGatewayOfficePresenceSnapshot({
            gatewayUrl: requestedGatewayUrl,
            token: officePreference.remoteOfficeToken,
            workspaceId: "remote-gateway",
            origin: requestOrigin,
            isLoopGateway: true,
          }));
        }
      } else {
        snapshot = pruneCanonicalRemoteLoopPresence(await fetchRemoteGatewayOfficePresenceSnapshot({
          gatewayUrl: requestedGatewayUrl,
          token: officePreference.remoteOfficeToken,
          workspaceId: "remote-gateway",
          origin: requestOrigin,
          isLoopGateway: true,
        }));
      }
      console.info("[office-presence] Remote gateway office presence loaded.", {
        gatewayUrl: requestedGatewayUrl,
        elapsedMs: Date.now() - startedAt,
        agentCount: snapshot.agents.length,
      });
      return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
    }
    const snapshot = await mergeLocalMissionControlAgents(loadOfficePresenceSnapshot(workspaceId));
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load office presence.";
    console.error("[office-presence] Failed to load office presence.", {
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
