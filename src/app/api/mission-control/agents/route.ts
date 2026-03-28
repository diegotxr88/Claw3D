import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Configuração de múltiplos Mission Controls (M2 + i5/Loop)
    const mcLocalUrl = process.env.MISSION_CONTROL_URL ?? "http://127.0.0.1:4000";
    // Tailscale é mais estável que ngrok (não expira)
    const mcLoopUrl = process.env.MISSION_CONTROL_LOOP_URL ?? "http://macbook-i5.taild0c287.ts.net:4000";
    const mcApiToken = process.env.MC_API_TOKEN;
    const mcLoopToken = process.env.MC_API_TOKEN_LOOP;

    const headersLocal: HeadersInit = { "cache": "no-store" };
    const headersLoop: HeadersInit = { "cache": "no-store" };
    
    if (mcApiToken) headersLocal["Authorization"] = `Bearer ${mcApiToken}`;
    if (mcLoopToken) headersLoop["Authorization"] = `Bearer ${mcLoopToken}`;

    // Busca de ambas as fontes em paralelo
    const [localRes, loopRes] = await Promise.allSettled([
      fetch(`${mcLocalUrl}/api/agents`, { headers: headersLocal }),
      fetch(`${mcLoopUrl}/api/agents`, { headers: headersLoop }),
    ]);

    let allAgents: Array<{
      name: string;
      status: string;
      gateway_agent_id: string;
      source: string;
    }> = [];

    // Processa M2 (local)
    if (localRes.status === "fulfilled" && localRes.value.ok) {
      const localAgents = await localRes.value.json() as Array<{
        name?: string | null;
        status?: string | null;
        gateway_agent_id?: string | null;
      }>;
      allAgents = allAgents.concat(
        localAgents.map((agent) => ({
          name: agent.name?.trim() ?? "Unknown",
          status: agent.status?.trim() ?? "standby",
          gateway_agent_id: agent.gateway_agent_id?.trim() ?? "",
          source: "local",
        }))
      );
    }

    // Processa i5 (Loop) - adiciona sufixo -Loop
    if (loopRes.status === "fulfilled" && loopRes.value.ok) {
      const loopAgents = await loopRes.value.json() as Array<{
        name?: string | null;
        status?: string | null;
        gateway_agent_id?: string | null;
      }>;
      allAgents = allAgents.concat(
        loopAgents.map((agent) => ({
          name: agent.name?.trim() ? `${agent.name.trim()}-Loop` : "Unknown-Loop",
          status: agent.status?.trim() ?? "standby",
          gateway_agent_id: agent.gateway_agent_id?.trim() ?? "",
          source: "loop",
        }))
      );
    }

    return NextResponse.json(allAgents);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to reach Mission Control";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}