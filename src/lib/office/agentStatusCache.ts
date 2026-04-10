import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Agent Status Cache
 * Mantém cache em memória dos status de agentes recebidos via webhook do Mission Control.
 * Fornece acesso instantâneo ao status mais recente sem polling.
 */

export type AgentStatus = "working" | "idle" | "standby" | "meeting" | "error";

export interface CachedAgentStatus {
  status: AgentStatus;
  workspaceId: string;
  taskId?: string;
  timestamp: string;
}

const CACHE_DIR = path.join(os.homedir(), ".openclaw", "claw3d");
const CACHE_FILE = path.join(CACHE_DIR, "agent-status-cache.json");

class AgentStatusCacheClass {
  private cache = new Map<string, CachedAgentStatus>();

  private snapshotRecord(): Record<string, CachedAgentStatus> {
    const result: Record<string, CachedAgentStatus> = {};
    for (const [id, data] of this.cache.entries()) {
      result[id] = data;
    }
    return result;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(CACHE_FILE)) return;
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw) as Record<string, CachedAgentStatus>;
      this.cache = new Map(Object.entries(parsed));
    } catch (error) {
      console.warn("[AgentStatusCache] Failed to load cache file", error);
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(this.snapshotRecord()), "utf8");
    } catch (error) {
      console.warn("[AgentStatusCache] Failed to persist cache file", error);
    }
  }

  set(agentId: string, data: CachedAgentStatus): void {
    this.loadFromDisk();
    this.cache.set(agentId, data);
    this.persistToDisk();
  }

  get(agentId: string): CachedAgentStatus | undefined {
    this.loadFromDisk();
    return this.cache.get(agentId);
  }

  getAll(): Map<string, CachedAgentStatus> {
    this.loadFromDisk();
    return new Map(this.cache);
  }

  has(agentId: string): boolean {
    this.loadFromDisk();
    return this.cache.has(agentId);
  }

  delete(agentId: string): boolean {
    this.loadFromDisk();
    const deleted = this.cache.delete(agentId);
    if (deleted) this.persistToDisk();
    return deleted;
  }

  clear(): void {
    this.cache.clear();
    try {
      if (fs.existsSync(CACHE_FILE)) {
        fs.unlinkSync(CACHE_FILE);
      }
    } catch (error) {
      console.warn("[AgentStatusCache] Failed to clear cache file", error);
    }
  }

  size(): number {
    this.loadFromDisk();
    return this.cache.size;
  }

  /**
   * Retorna um registro pronto para serialização
   */
  toRecord(): Record<string, CachedAgentStatus> {
    this.loadFromDisk();
    return this.snapshotRecord();
  }
}

// Singleton global — persiste entre requisições em produção (Edge/Node)
const globalCache = globalThis as typeof globalThis & {
  __agentStatusCache?: AgentStatusCacheClass;
};

export const AgentStatusCache: AgentStatusCacheClass =
  globalCache.__agentStatusCache ?? (globalCache.__agentStatusCache = new AgentStatusCacheClass());
