import { NextResponse } from "next/server";
import { AgentStatusCache, type AgentStatus } from "@/lib/office/agentStatusCache";

export const dynamic = "force-dynamic";

const LOOP_PROFILE_ID = "loop-macbook";

const resolveCacheKey = (params: {
  agentId: string;
  source?: unknown;
  gatewayProfileId?: unknown;
}) => {
  const agentId = params.agentId.trim();
  const source =
    typeof params.source === "string" ? params.source.trim().toLowerCase() : "";
  const gatewayProfileId =
    typeof params.gatewayProfileId === "string"
      ? params.gatewayProfileId.trim()
      : "";
  if (source === "loop" || gatewayProfileId === LOOP_PROFILE_ID) {
    return `remote:${agentId}`;
  }
  return agentId;
};

/**
 * POST /api/webhook/agent-status
 *
 * Recebe notificações de status do Mission Control quando um agente
 * entra ou sai de um estado "working" (luz verde no Claw3D).
 *
 * Body:
 * {
 *   "agentId": "codex",
 *   "status": "working" | "idle" | "standby",
 *   "workspaceId": "default",
 *   "taskId": "9e2ece00...",
 *   "timestamp": "2026-03-30T03:15:00.000Z"
 * }
 *
 * O Claw3D frontend pode consultar GET /api/webhook/agent-status?agentId=codex
 * para obter o status em cache (sem polling no MC).
 */
export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 400 });
    }

    const body = await request.json();
    const { agentId, status, workspaceId, taskId, timestamp, source, gatewayProfileId } = body;

    if (!agentId || typeof agentId !== "string") {
      return NextResponse.json({ error: "agentId is required" }, { status: 400 });
    }
    if (!status || typeof status !== "string") {
      return NextResponse.json({ error: "status is required" }, { status: 400 });
    }

    const validStatuses: AgentStatus[] = ["working", "idle", "standby", "meeting", "error"];
    if (!validStatuses.includes(status as AgentStatus)) {
      return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
    }

    const now = timestamp || new Date().toISOString();
    const normalizedAgentId = agentId.trim();
    const cacheKey = resolveCacheKey({
      agentId: normalizedAgentId,
      source,
      gatewayProfileId,
    });

    // Update cache
    AgentStatusCache.set(cacheKey, {
      status: status as AgentStatus,
      workspaceId: (typeof workspaceId === "string" ? workspaceId : "default").trim(),
      taskId: typeof taskId === "string" ? taskId.trim() : undefined,
      timestamp: now,
    });

    console.log(`[webhook/agent-status] Status update: ${cacheKey} → ${status}`);

    return NextResponse.json({
      success: true,
      agentId: normalizedAgentId,
      cacheKey,
      status,
      cached: true,
    });
  } catch (error) {
    console.error("[webhook/agent-status] Error:", error);
    return NextResponse.json(
      { error: "Failed to process agent status webhook" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/webhook/agent-status?agentId=codex
 *
 * Consulta o status em cache de um agente específico.
 * Retorna o último status recebido via webhook.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId");
  const source = url.searchParams.get("source");
  const gatewayProfileId = url.searchParams.get("gatewayProfileId");

  if (!agentId) {
    // Return all cached statuses
    return NextResponse.json({
      cached: true,
      count: AgentStatusCache.size(),
      agents: AgentStatusCache.toRecord(),
    });
  }

  const normalizedAgentId = agentId.trim();
  const cacheKey = resolveCacheKey({
    agentId: normalizedAgentId,
    source,
    gatewayProfileId,
  });
  const cached = AgentStatusCache.get(cacheKey);
  if (!cached) {
    return NextResponse.json({
      agentId: normalizedAgentId,
      cacheKey,
      cached: false,
      status: null,
    });
  }

  return NextResponse.json({
    agentId: normalizedAgentId,
    cacheKey,
    cached: true,
    ...cached,
  });
}
