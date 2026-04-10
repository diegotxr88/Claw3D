"use client";

import { Billboard, Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import * as THREE from "three";
import {
  CANVAS_H,
  CANVAS_W,
  SCALE,
  SNAP_GRID,
} from "@/features/retro-office/core/constants";
import {
  isRemoteOfficeAgentId,
  LOCAL_OFFICE_CANVAS_WIDTH,
  LOCAL_OFFICE_CANVAS_HEIGHT,
  REMOTE_OFFICE_ZONE,
} from "@/features/retro-office/core/district";
import { toWorld } from "@/features/retro-office/core/geometry";
import type {
  OfficeAgent,
  RenderAgent,
} from "@/features/retro-office/core/types";

const HEAT_COLS = Math.floor(CANVAS_W / SNAP_GRID);
const HEAT_ROWS = Math.floor(CANVAS_H / SNAP_GRID);

const getSceneDensity = (agents: RenderAgent[]) => {
  const total = agents.length;
  const active = agents.filter(
    (agent) => agent.status === "working" || agent.status === "error",
  ).length;
  return {
    total,
    active,
    crowded: total >= 10 || active >= 6,
    veryCrowded: total >= 14 || active >= 9,
  };
};

const getHierarchyBadge = (agentId: string, name: string) => {
  const normalized = `${agentId} ${name}`.toLowerCase();
  if (normalized.includes("doc")) {
    return { label: "Lead", color: "#ffe29a", bg: "#3b2a12", priority: 2 };
  }
  if (normalized.includes("loop")) {
    return { label: "Lead", color: "#b8f2ff", bg: "#143041", priority: 2 };
  }
  if (normalized.includes("coordenador")) {
    return { label: "Ops", color: "#fde68a", bg: "#3a2b12", priority: 1 };
  }
  return null;
};

const getRolePalette = (agentId: string, name: string) => {
  const normalized = `${agentId} ${name}`.toLowerCase();
  if (normalized.includes("doc")) {
    return { stripe: "#ffe29a", panel: "#3b2a12", text: "#fff1c7" };
  }
  if (normalized.includes("loop")) {
    return { stripe: "#b8f2ff", panel: "#143041", text: "#d7f9ff" };
  }
  if (normalized.includes("coordenador")) {
    return { stripe: "#fde68a", panel: "#3a2b12", text: "#fff3c4" };
  }
  if (normalized.includes("analista")) {
    return { stripe: "#c4b5fd", panel: "#22163c", text: "#e6ddff" };
  }
  if (normalized.includes("pesquisador")) {
    return { stripe: "#bfdbfe", panel: "#15263f", text: "#ddecff" };
  }
  if (normalized.includes("escritor")) {
    return { stripe: "#fbcfe8", panel: "#3a1628", text: "#ffe4f2" };
  }
  if (normalized.includes("coder") || normalized.includes("codex")) {
    return { stripe: "#fcd34d", panel: "#33220d", text: "#ffefb0" };
  }
  if (normalized.includes("janitor")) {
    return { stripe: "#bbf7d0", panel: "#163122", text: "#ddffe9" };
  }
  return { stripe: "#dbeafe", panel: "#17263b", text: "#e7f1ff" };
};

const resolveDeskActivityState = (
  agent: OfficeAgent,
  renderAgent: RenderAgent | null,
): "working_here" | "working_elsewhere" | "away" | "error" | "idle" => {
  if (agent.status === "error" || renderAgent?.status === "error") return "error";
  if (!renderAgent) return agent.status === "working" ? "working_elsewhere" : "idle";
  if (renderAgent.state === "away") return "away";
  if (
    renderAgent.status === "working" &&
    (renderAgent.interactionTarget === "desk" || renderAgent.state === "sitting")
  ) {
    return "working_here";
  }
  if (renderAgent.status === "working") return "working_elsewhere";
  return "idle";
};

const resolveInteractionContext = (
  renderAgent: RenderAgent | null,
): "meeting_room" | "desk" | "district" | "away" | "idle" => {
  if (!renderAgent) return "idle";
  if (renderAgent.state === "away") return "away";
  if (renderAgent.interactionTarget === "meeting_room") return "meeting_room";
  if (
    renderAgent.interactionTarget === "desk" ||
    renderAgent.state === "sitting"
  ) {
    return "desk";
  }
  if (renderAgent.status === "working") return "district";
  return "idle";
};

export function HeatmapSystem({
  agentsRef,
  heatmapMode,
  heatGridRef,
}: {
  agentsRef: RefObject<RenderAgent[]>;
  heatmapMode: boolean;
  heatGridRef: MutableRefObject<Uint16Array | null>;
}) {
  const frameRef = useRef(0);
  const cellsRef = useRef<{ x: number; z: number; v: number }[]>([]);
  const fallbackHeatGridRef = useRef<Uint16Array>(
    new Uint16Array(HEAT_COLS * HEAT_ROWS),
  );
  const [cells, setCells] = useState<{ x: number; z: number; v: number }[]>([]);

  useEffect(() => {
    cellsRef.current = cells;
  }, [cells]);

  useEffect(() => {
    if (heatGridRef.current == null) {
      heatGridRef.current = fallbackHeatGridRef.current;
    }
  }, [heatGridRef]);

  useFrame(() => {
    frameRef.current += 1;
    const grid = heatGridRef.current ?? fallbackHeatGridRef.current;
    if (heatGridRef.current == null) {
      heatGridRef.current = grid;
    }

    if (frameRef.current % (heatmapMode ? 30 : 45) === 0) {
      for (const agent of agentsRef.current ?? []) {
        const col = Math.floor(agent.x / SNAP_GRID);
        const row = Math.floor(agent.y / SNAP_GRID);
        if (col >= 0 && col < HEAT_COLS && row >= 0 && row < HEAT_ROWS) {
          grid[row * HEAT_COLS + col] = Math.min(
            65535,
            grid[row * HEAT_COLS + col] + 1,
          );
        }
      }
    }

    if (heatmapMode && frameRef.current % 120 === 0) {
      let maxValue = 1;
      for (let index = 0; index < grid.length; index += 1) {
        if (grid[index] > maxValue) maxValue = grid[index];
      }

      const nextCells: { x: number; z: number; v: number }[] = [];
      for (let row = 0; row < HEAT_ROWS; row += 1) {
        for (let col = 0; col < HEAT_COLS; col += 1) {
          const value = grid[row * HEAT_COLS + col];
          if (value === 0) continue;
          const [wx, , wz] = toWorld(
            col * SNAP_GRID + SNAP_GRID / 2,
            row * SNAP_GRID + SNAP_GRID / 2,
          );
          nextCells.push({ x: wx, z: wz, v: value / maxValue });
        }
      }

      setCells(nextCells);
    }

    if (!heatmapMode && cellsRef.current.length > 0) {
      setCells([]);
    }
  });

  if (!heatmapMode) return null;

  return (
    <>
      {cells.map((cell, index) => (
        <mesh
          key={index}
          position={[cell.x, 0.002, cell.z]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[SNAP_GRID * SCALE * 0.9, SNAP_GRID * SCALE * 0.9]} />
          <meshBasicMaterial
            color={
              cell.v < 0.4 ? "#f59e0b" : cell.v < 0.75 ? "#ef4444" : "#dc2626"
            }
            transparent
            opacity={0.15 + cell.v * 0.35}
            depthWrite={false}
          />
        </mesh>
      ))}
    </>
  );
}

type TrailPoint = { pos: THREE.Vector3; age: number; color: string };

export function TrailSystem({
  agentsRef,
  colorMap,
}: {
  agentsRef: RefObject<RenderAgent[]>;
  colorMap: Map<string, string>;
}) {
  const trailsRef = useRef<Map<string, TrailPoint[]>>(new Map());
  const frameRef = useRef(0);
  const [points, setPoints] = useState<TrailPoint[]>([]);

  useFrame(() => {
    frameRef.current += 1;
    const agents = agentsRef.current ?? [];
    const trails = trailsRef.current;

    if (frameRef.current % 12 === 0) {
      for (const agent of agents) {
        if (agent.state !== "walking") continue;
        const [wx, , wz] = toWorld(agent.x, agent.y);
        const existing = trails.get(agent.id) ?? [];
        existing.unshift({
          pos: new THREE.Vector3(wx, 0.01, wz),
          age: 0,
          color: colorMap.get(agent.id) ?? "#888",
        });
        if (existing.length > 6) existing.splice(6);
        trails.set(agent.id, existing);
      }
    }

    let changed = false;
    for (const [id, trailPoints] of trails) {
      for (const point of trailPoints) {
        point.age += 1;
      }
      for (let index = trailPoints.length - 1; index >= 0; index -= 1) {
        if (trailPoints[index].age < 48) continue;
        trailPoints.splice(index, 1);
        changed = true;
      }
      if (trailPoints.length === 0) {
        trails.delete(id);
        changed = true;
      }
    }

    if (frameRef.current % 8 === 0 || changed) {
      const nextPoints: TrailPoint[] = [];
      for (const trailPoints of trails.values()) nextPoints.push(...trailPoints);
      setPoints([...nextPoints]);
    }
  });

  return (
    <>
      {points.map((point, index) => (
        <mesh
          key={index}
          position={[point.pos.x, point.pos.y, point.pos.z]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <circleGeometry args={[0.05, 8]} />
          <meshBasicMaterial
            color={point.color}
            transparent
            opacity={Math.max(0, (1 - point.age / 48) * 0.45)}
            depthWrite={false}
          />
        </mesh>
      ))}
    </>
  );
}

export function DeskNameplates({
  deskLocations,
  agents,
  deskByAgentRef,
  renderAgentsRef,
}: {
  deskLocations: { x: number; y: number }[];
  agents: OfficeAgent[];
  deskByAgentRef: RefObject<Map<string, number>>;
  renderAgentsRef: RefObject<RenderAgent[]>;
}) {
  const [deskEntries, setDeskEntries] = useState<Array<[string, number]>>([]);
  const deskSignatureRef = useRef("");
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const renderAgentById = useMemo(
    () => new Map((renderAgentsRef.current ?? []).map((agent) => [agent.id, agent])),
    [renderAgentsRef.current],
  );
  const deskAgentByIndex = useMemo(
    () => new Map(deskEntries.map(([agentId, deskIndex]) => [deskIndex, agentId])),
    [deskEntries],
  );

  useEffect(() => {
    const syncDeskEntries = () => {
      const nextEntries = [...(deskByAgentRef.current?.entries() ?? [])].sort(
        (left, right) => left[0].localeCompare(right[0]),
      );
      const nextSignature = nextEntries
        .map(([agentId, deskIndex]) => `${agentId}:${deskIndex}`)
        .join("|");
      if (nextSignature === deskSignatureRef.current) {
        return;
      }
      deskSignatureRef.current = nextSignature;
      setDeskEntries(nextEntries);
    };
    syncDeskEntries();
    const intervalId = window.setInterval(syncDeskEntries, 400);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [deskByAgentRef]);

  return (
    <>
      {deskLocations.map((desk, index) => {
        const agentId = deskAgentByIndex.get(index);
        if (!agentId) return null;
        const agent = agentById.get(agentId);
        if (!agent) return null;
        const renderAgent = renderAgentById.get(agentId) ?? null;
        const [wx, , wz] = toWorld(desk.x, desk.y);
        const isRemote = isRemoteOfficeAgentId(agent.id);
        const rolePalette = getRolePalette(agent.id, agent.name);
        const deskActivityState = resolveDeskActivityState(agent, renderAgent);
        const statusStripe =
          deskActivityState === "error"
            ? "#ef4444"
            : deskActivityState === "working_here"
              ? isRemote
                ? "#67e8f9"
                : "#fbbf24"
              : deskActivityState === "working_elsewhere"
                ? isRemote
                  ? "#7dd3fc"
                  : "#d6b07d"
                : deskActivityState === "away"
                  ? "#64748b"
              : rolePalette.stripe;
        const panelBg =
          deskActivityState === "error"
            ? "#19070a"
            : deskActivityState === "working_here"
              ? isRemote
                ? "#0b2130"
                : "#1c1308"
              : deskActivityState === "working_elsewhere"
                ? isRemote
                  ? "#102838"
                  : "#2b1c0d"
                : deskActivityState === "away"
                  ? "#111827"
              : rolePalette.panel;

        return (
          <group key={`desk-status-${index}`}>
            <mesh position={[wx, 0.012, wz]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.12, 0.21, 24]} />
              <meshBasicMaterial
                color={statusStripe}
                transparent
                opacity={
                  deskActivityState === "working_here"
                    ? 0.22
                    : deskActivityState === "working_elsewhere"
                      ? 0.17
                      : deskActivityState === "away"
                        ? 0.1
                        : 0.12
                }
                depthWrite={false}
                side={2}
              />
            </mesh>
            <mesh position={[wx, 0.008, wz]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.085, 18]} />
              <meshBasicMaterial
                color={panelBg}
                transparent
                opacity={deskActivityState === "away" ? 0.09 : deskActivityState === "idle" ? 0.12 : 0.16}
                depthWrite={false}
              />
            </mesh>
            <Billboard position={[wx, 0.55, wz]}>
              <mesh position={[0, 0, -0.001]}>
                <planeGeometry args={[1.02, 0.16]} />
                <meshBasicMaterial
                  color={panelBg}
                  transparent
                  opacity={deskActivityState === "away" ? 0.54 : deskActivityState === "idle" ? 0.66 : 0.78}
                />
              </mesh>
              <mesh position={[-0.52, 0, 0]}>
                <planeGeometry args={[0.035, 0.16]} />
                <meshBasicMaterial color={statusStripe} />
              </mesh>
              <Text
                position={[0.02, 0, 0.001]}
                fontSize={0.084}
                color={
                  deskActivityState === "idle" || deskActivityState === "away"
                    ? rolePalette.text
                    : isRemote
                      ? "#d7f3ff"
                      : "#f3d59a"
                }
                anchorX="center"
                anchorY="middle"
                maxWidth={0.92}
                font={undefined}
                overflowWrap="break-word"
                whiteSpace="nowrap"
              >
                {agent.name.length > 14 ? agent.name.slice(0, 13) + "…" : agent.name}
              </Text>
            </Billboard>
          </group>
        );
      })}
    </>
  );
}

export function AgentStatusAuras({
  agentsRef,
}: {
  agentsRef: RefObject<RenderAgent[]>;
}) {
  const [activeAgents, setActiveAgents] = useState<
    Array<{
      id: string;
      x: number;
      z: number;
      status: RenderAgent["status"];
      remote: boolean;
      crowded: boolean;
      veryCrowded: boolean;
    }>
  >([]);

  useEffect(() => {
    const sync = () => {
      const allAgents = agentsRef.current ?? [];
      const density = getSceneDensity(allAgents);
      const next = allAgents
        .filter((agent) => agent.status === "working" || agent.status === "error")
        .map((agent) => {
          const [x, , z] = toWorld(agent.x, agent.y);
          return {
            id: agent.id,
            x,
            z,
            status: agent.status,
            remote: isRemoteOfficeAgentId(agent.id),
            crowded: density.crowded,
            veryCrowded: density.veryCrowded,
          };
        });
      setActiveAgents(next);
    };
    sync();
    const intervalId = window.setInterval(sync, 250);
    return () => window.clearInterval(intervalId);
  }, [agentsRef]);

  return (
    <>
      {activeAgents.map((agent) => {
        const ringColor =
          agent.status === "error"
            ? "#ef4444"
            : agent.remote
              ? "#67e8f9"
              : "#fbbf24";
        const coreColor =
          agent.status === "error"
            ? "#3b0a0f"
            : agent.remote
              ? "#0d2534"
              : "#2c1d08";
        return (
          <group key={`agent-aura-${agent.id}`}>
            <mesh position={[agent.x, 0.01, agent.z]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.16, agent.veryCrowded ? 0.23 : 0.25, 28]} />
              <meshBasicMaterial
                color={ringColor}
                transparent
                opacity={agent.veryCrowded ? 0.11 : agent.crowded ? 0.15 : 0.22}
                depthWrite={false}
                side={2}
              />
            </mesh>
            <mesh position={[agent.x, 0.008, agent.z]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[agent.veryCrowded ? 0.09 : 0.1, 20]} />
              <meshBasicMaterial
                color={coreColor}
                transparent
                opacity={agent.veryCrowded ? 0.07 : agent.crowded ? 0.1 : 0.15}
                depthWrite={false}
              />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

export function DeskOccupancyBeacons({
  deskLocations,
  agents,
  deskByAgentRef,
  renderAgentsRef,
}: {
  deskLocations: { x: number; y: number }[];
  agents: OfficeAgent[];
  deskByAgentRef: RefObject<Map<string, number>>;
  renderAgentsRef: RefObject<RenderAgent[]>;
}) {
  const [deskEntries, setDeskEntries] = useState<Array<[string, number]>>([]);
  const deskSignatureRef = useRef("");

  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const renderAgentById = useMemo(
    () => new Map((renderAgentsRef.current ?? []).map((agent) => [agent.id, agent])),
    [renderAgentsRef.current],
  );

  useEffect(() => {
    const syncDeskEntries = () => {
      const nextEntries = [...(deskByAgentRef.current?.entries() ?? [])].sort(
        (left, right) => left[0].localeCompare(right[0]),
      );
      const nextSignature = nextEntries
        .map(([agentId, deskIndex]) => `${agentId}:${deskIndex}`)
        .join("|");
      if (nextSignature === deskSignatureRef.current) return;
      deskSignatureRef.current = nextSignature;
      setDeskEntries(nextEntries);
    };
    syncDeskEntries();
    const intervalId = window.setInterval(syncDeskEntries, 400);
    return () => window.clearInterval(intervalId);
  }, [deskByAgentRef]);

  const occupancyByDesk = useMemo(() => {
    const local = new Map<number, OfficeAgent>();
    const remote = new Map<number, OfficeAgent>();
    for (const [agentId, deskIndex] of deskEntries) {
      const agent = agentById.get(agentId);
      if (!agent) continue;
      if (isRemoteOfficeAgentId(agentId)) {
        remote.set(deskIndex, agent);
      } else {
        local.set(deskIndex, agent);
      }
    }
    return { local, remote };
  }, [agentById, deskEntries]);

  const renderDeskBeacon = (
    desk: { x: number; y: number },
    deskIndex: number,
    mode: "local" | "remote",
  ) => {
    const assignedAgent =
      mode === "remote"
        ? occupancyByDesk.remote.get(deskIndex)
        : occupancyByDesk.local.get(deskIndex);
    const isRemote = mode === "remote";
    const renderAgent = assignedAgent ? renderAgentById.get(assignedAgent.id) ?? null : null;
    const deskActivityState = assignedAgent
      ? resolveDeskActivityState(assignedAgent, renderAgent)
      : "idle";
    const beaconColor = !assignedAgent
      ? isRemote
        ? "#7dd3fc"
        : "#f3d59a"
      : deskActivityState === "error"
        ? "#ef4444"
        : deskActivityState === "working_here"
          ? isRemote
            ? "#67e8f9"
            : "#fbbf24"
          : deskActivityState === "working_elsewhere"
            ? isRemote
              ? "#7dd3fc"
              : "#d6b07d"
            : deskActivityState === "away"
              ? "#64748b"
          : getRolePalette(assignedAgent.id, assignedAgent.name).stripe;
    const fillColor = !assignedAgent
      ? isRemote
        ? "#0d2230"
        : "#24170a"
      : deskActivityState === "error"
        ? "#2c0a0f"
        : deskActivityState === "working_here"
          ? isRemote
            ? "#0b2534"
            : "#2c1d08"
          : deskActivityState === "working_elsewhere"
            ? isRemote
              ? "#102838"
              : "#2b1c0d"
            : deskActivityState === "away"
              ? "#111827"
          : getRolePalette(assignedAgent.id, assignedAgent.name).panel;
    const offsetY = isRemote ? LOCAL_OFFICE_CANVAS_HEIGHT + 300 : 0;
    const [wx, , wz] = toWorld(desk.x, desk.y + offsetY);
    return (
      <group key={`desk-occupancy-${mode}-${deskIndex}`}>
        <mesh position={[wx, 0.011, wz]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry
            args={[
              deskActivityState === "working_here" ? 0.13 : 0.11,
              deskActivityState === "working_here" ? 0.22 : 0.18,
              24,
            ]}
          />
          <meshBasicMaterial
            color={beaconColor}
            transparent
            opacity={
              !assignedAgent
                ? 0.14
                : deskActivityState === "working_here"
                  ? 0.3
                  : deskActivityState === "working_elsewhere"
                    ? 0.2
                    : deskActivityState === "away"
                      ? 0.1
                      : 0.22
            }
            depthWrite={false}
            side={2}
          />
        </mesh>
        <mesh position={[wx, 0.009, wz]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[deskActivityState === "working_here" ? 0.09 : 0.075, 18]} />
          <meshBasicMaterial
            color={fillColor}
            transparent
            opacity={!assignedAgent ? 0.12 : deskActivityState === "away" ? 0.1 : 0.22}
            depthWrite={false}
          />
        </mesh>
      </group>
    );
  };

  return (
    <>
      {deskLocations.map((desk, deskIndex) => renderDeskBeacon(desk, deskIndex, "local"))}
      {deskLocations.map((desk, deskIndex) => renderDeskBeacon(desk, deskIndex, "remote"))}
    </>
  );
}

export function AgentHierarchyPins({
  agentsRef,
  agents,
  currentSpeakerAgentId = null,
}: {
  agentsRef: RefObject<RenderAgent[]>;
  agents: OfficeAgent[];
  currentSpeakerAgentId?: string | null;
}) {
  const [pins, setPins] = useState<
    Array<{
      id: string;
      x: number;
      z: number;
      label: string;
      color: string;
      bg: string;
      scale: "normal" | "focus";
    }>
  >([]);

  const hierarchyByAgentId = useMemo(() => {
    const next = new Map<
      string,
      { label: string; color: string; bg: string; priority: number }
    >();
    for (const agent of agents) {
      const badge = getHierarchyBadge(agent.id, agent.name);
      if (!badge) continue;
      next.set(agent.id, badge);
    }
    return next;
  }, [agents]);

  useEffect(() => {
    const sync = () => {
      const renderAgents = agentsRef.current ?? [];
      const density = getSceneDensity(renderAgents);
      const renderLookup = new Map(renderAgents.map((agent) => [agent.id, agent]));
      const nextPins: Array<{
        id: string;
        x: number;
        z: number;
        label: string;
        color: string;
        bg: string;
        scale: "normal" | "focus";
      }> = [];

      if (currentSpeakerAgentId) {
        const currentSpeaker = renderLookup.get(currentSpeakerAgentId);
        if (currentSpeaker) {
          const [x, , z] = toWorld(currentSpeaker.x, currentSpeaker.y);
          const isRemote = isRemoteOfficeAgentId(currentSpeakerAgentId);
          nextPins.push({
            id: `speaker:${currentSpeakerAgentId}`,
            x,
            z,
            label: "Speaking",
            color: isRemote ? "#d7f9ff" : "#fff3c4",
            bg: isRemote ? "#123246" : "#3b2a12",
            scale: "focus",
          });
        }
      }

      for (const [agentId, badge] of hierarchyByAgentId.entries()) {
        if (agentId === currentSpeakerAgentId) continue;
        if (density.veryCrowded && badge.priority < 2) continue;
        const renderAgent = renderLookup.get(agentId);
        if (!renderAgent) continue;
        const interactionContext = resolveInteractionContext(renderAgent);
        if (interactionContext === "away") continue;
        const [x, , z] = toWorld(renderAgent.x, renderAgent.y);
        nextPins.push({
          id: `hierarchy:${agentId}`,
          x,
          z,
          label: badge.label,
          color: badge.color,
          bg: badge.bg,
          scale: "normal",
        });
      }

      setPins(nextPins);
    };

    sync();
    const intervalId = window.setInterval(sync, 250);
    return () => window.clearInterval(intervalId);
  }, [agentsRef, currentSpeakerAgentId, hierarchyByAgentId]);

  return (
    <>
      {pins.map((pin) => (
        <Billboard
          key={pin.id}
          position={[pin.x, pin.scale === "focus" ? 1.38 : 1.22, pin.z]}
        >
          <mesh position={[0, 0, -0.001]}>
            <planeGeometry args={pin.scale === "focus" ? [0.56, 0.16] : [0.32, 0.14]} />
            <meshBasicMaterial color={pin.bg} transparent opacity={0.9} />
          </mesh>
          <Text
            position={[0, 0, 0.001]}
            fontSize={pin.scale === "focus" ? 0.082 : 0.068}
            color={pin.color}
            anchorX="center"
            anchorY="middle"
            maxWidth={pin.scale === "focus" ? 0.48 : 0.26}
            font={undefined}
          >
            {pin.label}
          </Text>
        </Billboard>
      ))}
    </>
  );
}

export function AgentCollaborationLinks({
  agentsRef,
}: {
  agentsRef: RefObject<RenderAgent[]>;
}) {
  const [links, setLinks] = useState<
    Array<{
      id: string;
      ax: number;
      az: number;
      bx: number;
      bz: number;
      mx: number;
      mz: number;
      color: string;
      opacity: number;
    }>
  >([]);

  useEffect(() => {
    const sync = () => {
      const workingAgents = (agentsRef.current ?? []).filter(
        (agent) => agent.status === "working",
      );
      const density = getSceneDensity(workingAgents);
      const candidates: Array<{
        id: string;
        ax: number;
        az: number;
        bx: number;
        bz: number;
        mx: number;
        mz: number;
        color: string;
        priority: number;
        distance: number;
        opacity: number;
      }> = [];
      const used = new Set<string>();

      for (let index = 0; index < workingAgents.length; index += 1) {
        const left = workingAgents[index];
        if (!left) continue;
        for (let inner = index + 1; inner < workingAgents.length; inner += 1) {
          const right = workingAgents[inner];
          if (!right) continue;
          const sameRemoteState =
            isRemoteOfficeAgentId(left.id) === isRemoteOfficeAgentId(right.id);
          if (!sameRemoteState) continue;
          const leftContext = resolveInteractionContext(left);
          const rightContext = resolveInteractionContext(right);
          if (leftContext === "away" || rightContext === "away") continue;
          const sameTarget =
            left.interactionTarget &&
            right.interactionTarget &&
            left.interactionTarget === right.interactionTarget;
          const deskCollaboration =
            leftContext === "desk" &&
            rightContext === "desk" &&
            !sameTarget;
          const distance = Math.hypot(left.x - right.x, left.y - right.y);
          if (!sameTarget && !deskCollaboration) continue;
          if (
            deskCollaboration &&
            distance > (density.crowded ? 70 : 90)
          ) {
            continue;
          }
          const leftKey = `${left.id}:${right.id}`;
          if (used.has(leftKey)) continue;
          used.add(leftKey);
          const [ax, , az] = toWorld(left.x, left.y);
          const [bx, , bz] = toWorld(right.x, right.y);
          const remote = isRemoteOfficeAgentId(left.id);
          const opacity = sameTarget
            ? density.veryCrowded
              ? 0.1
              : density.crowded
                ? 0.13
                : 0.16
            : density.veryCrowded
              ? 0.06
              : density.crowded
                ? 0.08
                : 0.1;
          candidates.push({
            id: leftKey,
            ax,
            az,
            bx,
            bz,
            mx: (ax + bx) / 2,
            mz: (az + bz) / 2,
            color: remote ? "#8fe3ff" : "#ffd166",
            priority: sameTarget ? 0 : 1,
            distance,
            opacity,
          });
        }
      }

      candidates.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.distance - b.distance;
      });
      const maxLinks = density.veryCrowded ? 4 : density.crowded ? 6 : 8;
      setLinks(candidates.slice(0, maxLinks));
    };

    sync();
    const intervalId = window.setInterval(sync, 300);
    return () => window.clearInterval(intervalId);
  }, [agentsRef]);

  return (
    <>
      {links.map((link) => {
        const dx = link.bx - link.ax;
        const dz = link.bz - link.az;
        const length = Math.hypot(dx, dz);
        const angle = Math.atan2(dx, dz);
        return (
          <group key={link.id}>
            <mesh
              position={[link.mx, 0.014, link.mz]}
              rotation={[-Math.PI / 2, 0, -angle]}
            >
              <planeGeometry args={[0.03, Math.max(0.12, length)]} />
              <meshBasicMaterial
                color={link.color}
                transparent
                opacity={link.opacity}
                depthWrite={false}
                side={2}
              />
            </mesh>
            <mesh position={[link.mx, 0.016, link.mz]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.05, 0.08, 20]} />
              <meshBasicMaterial
                color={link.color}
                transparent
                opacity={Math.min(0.16, link.opacity + 0.03)}
                depthWrite={false}
                side={2}
              />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

export function OfficeActivityPulse({
  agentsRef,
}: {
  agentsRef: RefObject<RenderAgent[]>;
}) {
  const [levels, setLevels] = useState({
    localRatio: 0,
    remoteRatio: 0,
    localErrorRatio: 0,
    remoteErrorRatio: 0,
  });

  useEffect(() => {
    const sync = () => {
      const agents = agentsRef.current ?? [];
      const localAgents = agents.filter((agent) => !isRemoteOfficeAgentId(agent.id));
      const remoteAgents = agents.filter((agent) => isRemoteOfficeAgentId(agent.id));
      const localWorking = localAgents.filter((agent) => agent.status === "working").length;
      const remoteWorking = remoteAgents.filter((agent) => agent.status === "working").length;
      const localErrors = localAgents.filter((agent) => agent.status === "error").length;
      const remoteErrors = remoteAgents.filter((agent) => agent.status === "error").length;
      setLevels({
        localRatio: localWorking / Math.max(localAgents.length, 1),
        remoteRatio: remoteWorking / Math.max(remoteAgents.length, 1),
        localErrorRatio: localErrors / Math.max(localAgents.length, 1),
        remoteErrorRatio: remoteErrors / Math.max(remoteAgents.length, 1),
      });
    };
    sync();
    const intervalId = window.setInterval(sync, 350);
    return () => window.clearInterval(intervalId);
  }, [agentsRef]);

  const [localExecutionX, , localExecutionZ] = toWorld(
    (60 + 840) / 2,
    (250 + 610) / 2,
  );
  const [remoteExecutionX, , remoteExecutionZ] = toWorld(
    LOCAL_OFFICE_CANVAS_WIDTH / 2,
    (REMOTE_OFFICE_ZONE.minY + REMOTE_OFFICE_ZONE.maxY) / 2,
  );

  return (
    <>
      <mesh position={[localExecutionX, 0.006, localExecutionZ]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry
          args={[1.58, 1.86 + levels.localRatio * 0.22 + levels.localErrorRatio * 0.08, 48]}
        />
        <meshBasicMaterial
          color={levels.localErrorRatio > 0.08 ? "#ef4444" : "#fbbf24"}
          transparent
          opacity={0.035 + levels.localRatio * 0.08 + levels.localErrorRatio * 0.05}
          depthWrite={false}
          side={2}
        />
      </mesh>
      <mesh position={[remoteExecutionX, 0.006, remoteExecutionZ]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry
          args={[1.58, 1.86 + levels.remoteRatio * 0.22 + levels.remoteErrorRatio * 0.08, 48]}
        />
        <meshBasicMaterial
          color={levels.remoteErrorRatio > 0.08 ? "#fb7185" : "#67e8f9"}
          transparent
          opacity={0.035 + levels.remoteRatio * 0.08 + levels.remoteErrorRatio * 0.05}
          depthWrite={false}
          side={2}
        />
      </mesh>
    </>
  );
}

export function AdaptiveDistrictLabels({
  agentsRef,
}: {
  agentsRef: RefObject<RenderAgent[]>;
}) {
  const [showLabels, setShowLabels] = useState({
    local: false,
    remote: false,
  });

  useEffect(() => {
    const sync = () => {
      const agents = agentsRef.current ?? [];
      const localCount = agents.filter((agent) => !isRemoteOfficeAgentId(agent.id)).length;
      const remoteCount = agents.filter((agent) => isRemoteOfficeAgentId(agent.id)).length;
      const localWorking = agents.filter(
        (agent) => !isRemoteOfficeAgentId(agent.id) && agent.status === "working",
      ).length;
      const remoteWorking = agents.filter(
        (agent) => isRemoteOfficeAgentId(agent.id) && agent.status === "working",
      ).length;
      setShowLabels({
        local: localCount >= 7 || localWorking >= 4,
        remote: remoteCount >= 5 || remoteWorking >= 3,
      });
    };
    sync();
    const intervalId = window.setInterval(sync, 400);
    return () => window.clearInterval(intervalId);
  }, [agentsRef]);

  const [conferenceX, , conferenceZ] = toWorld((0 + 340) / 2, 210);
  const [executionX, , executionZ] = toWorld((60 + 840) / 2, 610);
  const [qaX, , qaZ] = toWorld(1440, 250);
  const [remoteTitleX, , remoteTitleZ] = toWorld(
    LOCAL_OFFICE_CANVAS_WIDTH / 2,
    REMOTE_OFFICE_ZONE.minY + 90,
  );

  return (
    <>
      {showLabels.local ? (
        <>
          <Billboard position={[conferenceX, 0.24, conferenceZ]}>
            <mesh position={[0, 0, -0.001]}>
              <planeGeometry args={[0.72, 0.16]} />
              <meshBasicMaterial color="#24180c" transparent opacity={0.62} />
            </mesh>
            <Text fontSize={0.126} color="#f5deb3" anchorX="center" anchorY="middle">
              Conference
            </Text>
          </Billboard>
          <Billboard position={[executionX, 0.24, executionZ]}>
            <mesh position={[0, 0, -0.001]}>
              <planeGeometry args={[0.64, 0.16]} />
              <meshBasicMaterial color="#24180c" transparent opacity={0.56} />
            </mesh>
            <Text fontSize={0.124} color="#f8d07a" anchorX="center" anchorY="middle">
              Execution
            </Text>
          </Billboard>
          <Billboard position={[qaX, 0.24, qaZ]}>
            <mesh position={[0, 0, -0.001]}>
              <planeGeometry args={[0.54, 0.16]} />
              <meshBasicMaterial color="#181322" transparent opacity={0.58} />
            </mesh>
            <Text fontSize={0.124} color="#c4b5fd" anchorX="center" anchorY="middle">
              QA Lab
            </Text>
          </Billboard>
        </>
      ) : null}
      {showLabels.remote ? (
        <Billboard position={[remoteTitleX, 0.26, remoteTitleZ]}>
          <mesh position={[0, 0, -0.001]}>
            <planeGeometry args={[0.78, 0.17]} />
            <meshBasicMaterial color="#102838" transparent opacity={0.6} />
          </mesh>
          <Text fontSize={0.132} color="#b8f2ff" anchorX="center" anchorY="middle">
            Loop Office
          </Text>
        </Billboard>
      ) : null}
    </>
  );
}
