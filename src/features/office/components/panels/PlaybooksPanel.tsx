"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentState } from "@/features/agents/state/store";
import type { OfficeStandupController } from "@/features/office/hooks/useOfficeStandupController";
import {
  createCronJob,
  formatCronSchedule,
  listCronJobs,
  removeCronJob,
  runCronJobNow,
  sortCronJobsByUpdatedAt,
  type CronJobCreateInput,
  type CronJobSummary,
} from "@/lib/cron/types";
import type { GatewayClient, GatewayStatus } from "@/lib/gateway/GatewayClient";
import { isGatewayDisconnectLikeError } from "@/lib/gateway/GatewayClient";

type TemplateDefinition = {
  id: string;
  name: string;
  description: string;
  buildInput: (agent: AgentState, customName: string) => CronJobCreateInput;
};

const PLAYBOOK_TEMPLATES: TemplateDefinition[] = [
  {
    id: "daily-briefing",
    name: "Briefing Matinal Diario",
    description: "Todos os dias as 9h. Resume prioridades, bloqueios e o que mudou durante a noite.",
    buildInput: (agent, customName) => ({
      name: customName || "Briefing Matinal Diario",
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          "Crie um briefing matinal conciso para o QG. Resuma prioridades atuais, trabalhos bloqueados, mudancas recentes relevantes e os proximos passos recomendados.",
        thinking: "high",
      },
    }),
  },
  {
    id: "nightly-code-review",
    name: "Resumo Noturno de Revisao",
    description: "Todas as noites a meia-noite. Revise o dia e resuma mudancas arriscadas ou regressoes.",
    buildInput: (agent, customName) => ({
      name: customName || "Resumo Noturno de Revisao",
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          "Revise o trabalho mais recente disponivel e produza um resumo de mudancas arriscadas, questoes em aberto e recomendacoes de acompanhamento para a equipe.",
        thinking: "high",
      },
    }),
  },
  {
    id: "hourly-health-check",
    name: "Verificacao Horaria",
    description: "A cada 60 minutos. Relate a saude do runtime, falhas e qualquer coisa que precise de intervencao.",
    buildInput: (agent, customName) => ({
      name: customName || "Verificacao Horaria",
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "every", everyMs: 60 * 60 * 1000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          "Execute uma verificacao de saude. Resuma seu status atual, erros, tarefas bloqueadas, aprovacoes pendentes e se um humano precisa intervir.",
        thinking: "medium",
      },
    }),
  },
  {
    id: "weekly-progress-report",
    name: "Relatorio Semanal de Progresso",
    description: "Toda segunda as 8h. Consolide ganhos, trabalho pendente e proximos passos.",
    buildInput: (agent, customName) => ({
      name: customName || "Relatorio Semanal de Progresso",
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * 1" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          "Escreva um relatorio semanal de progresso para o QG. Inclua trabalhos concluidos, pendentes, riscos e os proximos passos mais importantes.",
        thinking: "high",
      },
    }),
  },
  {
    id: "continuous-monitor",
    name: "Monitor Continuo",
    description: "A cada 15 minutos. Observe desvios, falhas silenciosas ou qualquer coisa fora do normal.",
    buildInput: (agent, customName) => ({
      name: customName || "Monitor Continuo",
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          "Monitore seu contexto atual e relate apenas se detectar comportamento incomum, progresso bloqueado, falhas repetidas ou oportunidades que exijam atencao.",
        thinking: "medium",
      },
    }),
  },
];

const formatRelativeDateTime = (timestampMs?: number) => {
  if (!timestampMs || !Number.isFinite(timestampMs)) return "Desconhecido";
  return new Date(timestampMs).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export function PlaybooksPanel({
  client,
  status,
  agents,
  standup,
}: {
  client: GatewayClient;
  status: GatewayStatus;
  agents: AgentState[];
  standup: OfficeStandupController;
}) {
  const [jobs, setJobs] = useState<CronJobSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [nameOverride, setNameOverride] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [runBusyJobId, setRunBusyJobId] = useState<string | null>(null);
  const [deleteBusyJobId, setDeleteBusyJobId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.agentId, agent])),
    [agents]
  );

  const activeTemplate = useMemo(
    () => PLAYBOOK_TEMPLATES.find((template) => template.id === selectedTemplateId) ?? null,
    [selectedTemplateId]
  );
  const [standupAgentId, setStandupAgentId] = useState("");
  const [standupCronExpr, setStandupCronExpr] = useState("0 9 * * 1-5");
  const [standupTimezone, setStandupTimezone] = useState("UTC");
  const [standupSpeakerSeconds, setStandupSpeakerSeconds] = useState("8");
  const [standupAutoOpenBoard, setStandupAutoOpenBoard] = useState(true);
  const [standupScheduleEnabled, setStandupScheduleEnabled] = useState(false);
  const [jiraEnabled, setJiraEnabled] = useState(false);
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraApiToken, setJiraApiToken] = useState("");
  const [jiraApiTokenConfigured, setJiraApiTokenConfigured] = useState(false);
  const [jiraProjectKey, setJiraProjectKey] = useState("");
  const [jiraJql, setJiraJql] = useState("");
  const [manualTask, setManualTask] = useState("");
  const [manualBlockers, setManualBlockers] = useState("");
  const [manualNote, setManualNote] = useState("");
  const [manualJiraAssignee, setManualJiraAssignee] = useState("");

  useEffect(() => {
    if (!standup.config) return;
    setStandupScheduleEnabled(standup.config.schedule.enabled);
    setStandupCronExpr(standup.config.schedule.cronExpr);
    setStandupTimezone(standup.config.schedule.timezone);
    setStandupSpeakerSeconds(String(standup.config.schedule.speakerSeconds));
    setStandupAutoOpenBoard(standup.config.schedule.autoOpenBoard);
    setJiraEnabled(standup.config.jira.enabled);
    setJiraBaseUrl(standup.config.jira.baseUrl);
    setJiraEmail(standup.config.jira.email);
    setJiraApiToken(standup.config.jira.apiToken);
    setJiraApiTokenConfigured(standup.config.jira.apiTokenConfigured);
    setJiraProjectKey(standup.config.jira.projectKey);
    setJiraJql(standup.config.jira.jql);
  }, [standup.config]);

  useEffect(() => {
    if (standupAgentId || agents.length === 0) return;
    setStandupAgentId(agents[0]?.agentId ?? "");
  }, [agents, standupAgentId]);

  useEffect(() => {
    if (!standup.config || !standupAgentId) return;
    const manual = standup.config.manualByAgentId[standupAgentId];
    setManualTask(manual?.currentTask ?? "");
    setManualBlockers(manual?.blockers ?? "");
    setManualNote(manual?.note ?? "");
    setManualJiraAssignee(manual?.jiraAssignee ?? "");
  }, [standup.config, standupAgentId]);

  const loadJobs = useCallback(async () => {
    if (status !== "connected") {
      setJobs([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listCronJobs(client, { includeDisabled: true });
      setJobs(sortCronJobsByUpdatedAt(result.jobs));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha ao carregar rotinas.";
      setError(message);
      if (!isGatewayDisconnectLikeError(err)) {
        console.error(message);
      }
    } finally {
      setLoading(false);
    }
  }, [client, status]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const handleCreate = useCallback(async () => {
    if (!activeTemplate) return;
    const agent = agentById.get(selectedAgentId);
    if (!agent) {
      setError("Escolha um agente antes de iniciar uma rotina.");
      return;
    }

    setCreateBusy(true);
    setError(null);
    setActionMessage(null);
    try {
      await createCronJob(client, activeTemplate.buildInput(agent, nameOverride.trim()));
      setActionMessage(`Criado "${nameOverride.trim() || activeTemplate.name}".`);
      setSelectedTemplateId(null);
      setSelectedAgentId("");
      setNameOverride("");
      await loadJobs();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha ao criar rotina.";
      setError(message);
    } finally {
      setCreateBusy(false);
    }
  }, [activeTemplate, agentById, client, loadJobs, nameOverride, selectedAgentId]);

  const handleRunNow = useCallback(
    async (jobId: string) => {
      setRunBusyJobId(jobId);
      setError(null);
      setActionMessage(null);
      try {
        const result = await runCronJobNow(client, jobId);
        setActionMessage(result.ok ? "Rotina disparada." : "Falha ao disparar a rotina.");
        await loadJobs();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Falha ao executar a rotina.");
      } finally {
        setRunBusyJobId(null);
      }
    },
    [client, loadJobs]
  );

  const handleDelete = useCallback(
    async (jobId: string) => {
      setDeleteBusyJobId(jobId);
      setError(null);
      setActionMessage(null);
      try {
        const result = await removeCronJob(client, jobId);
        setActionMessage(result.ok && result.removed ? "Rotina removida." : "A rotina nao foi removida.");
        await loadJobs();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Falha ao excluir a rotina.");
      } finally {
        setDeleteBusyJobId(null);
      }
    },
    [client, loadJobs]
  );

  const handleSaveStandupConfig = useCallback(async () => {
    setError(null);
    setActionMessage(null);
    try {
      await standup.saveConfig({
        schedule: {
          enabled: standupScheduleEnabled,
          cronExpr: standupCronExpr.trim() || "0 9 * * 1-5",
          timezone: standupTimezone.trim() || "UTC",
          speakerSeconds: Number(standupSpeakerSeconds) || 8,
          autoOpenBoard: standupAutoOpenBoard,
        },
        jira: {
          enabled: jiraEnabled,
          baseUrl: jiraBaseUrl.trim(),
          email: jiraEmail.trim(),
          apiToken: jiraApiToken.trim(),
          projectKey: jiraProjectKey.trim().toUpperCase(),
          jql: jiraJql.trim(),
        },
      });
      setActionMessage("Configuracoes da reuniao salvas.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar as configuracoes da reuniao.");
    }
  }, [
    jiraApiToken,
    jiraBaseUrl,
    jiraEmail,
    jiraEnabled,
    jiraJql,
    jiraProjectKey,
    standup,
    standupAutoOpenBoard,
    standupCronExpr,
    standupScheduleEnabled,
    standupSpeakerSeconds,
    standupTimezone,
  ]);

  const handleSaveManualNotes = useCallback(async () => {
    if (!standupAgentId) {
      setError("Escolha um agente antes de salvar as anotacoes da reuniao.");
      return;
    }
    setError(null);
    setActionMessage(null);
    try {
      await standup.updateManualEntry(standupAgentId, {
        jiraAssignee: manualJiraAssignee.trim() || null,
        currentTask: manualTask.trim(),
        blockers: manualBlockers.trim(),
        note: manualNote.trim(),
      });
      setActionMessage("Anotacoes da reuniao salvas.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar as anotacoes da reuniao.");
    }
  }, [
    manualBlockers,
    manualJiraAssignee,
    manualNote,
    manualTask,
    standup,
    standupAgentId,
  ]);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="border-b border-cyan-500/10 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-white/70">
              Rotinas
            </div>
            <div className="mt-1 font-mono text-[11px] text-white/40">
              Dispare agendas reutilizaveis para todo o QG.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadJobs()}
            className="rounded border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200 transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
          >
            Atualizar
          </button>
        </div>
        {error ? <div className="mt-2 font-mono text-[11px] text-rose-300">{error}</div> : null}
        {actionMessage ? (
          <div className="mt-2 font-mono text-[11px] text-emerald-300">{actionMessage}</div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-cyan-500/10 px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
            Rotinas Ativas
          </div>
          <div className="mt-3 space-y-2">
            {loading ? (
              <div className="font-mono text-[11px] text-white/40">Carregando rotinas agendadas.</div>
            ) : jobs.length === 0 ? (
              <div className="font-mono text-[11px] text-white/35">Ainda nao ha rotinas ativas.</div>
            ) : (
              jobs.map((job) => {
                const agentName = agentById.get(job.agentId ?? "")?.name || job.agentId || "Desconhecido";
                return (
                  <div
                    key={job.id}
                    className="rounded border border-white/8 bg-white/[0.03] px-3 py-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-white/85">
                          {job.name}
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-white/45">{agentName}</div>
                      </div>
                      <div className="shrink-0 rounded border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan-200">
                        {job.state.lastStatus ?? "pronto"}
                      </div>
                    </div>

                    <div className="mt-3 space-y-1 font-mono text-[11px] text-white/65">
                      <div>{formatCronSchedule(job.schedule)}</div>
                      <div>Proxima execucao: {formatRelativeDateTime(job.state.nextRunAtMs)}</div>
                      <div>Ultima execucao: {formatRelativeDateTime(job.state.lastRunAtMs)}</div>
                    </div>

                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRunNow(job.id)}
                        disabled={runBusyJobId === job.id || deleteBusyJobId === job.id}
                        className="rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200 transition-colors hover:border-amber-400/50 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {runBusyJobId === job.id ? "Executando" : "Executar agora"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(job.id)}
                        disabled={deleteBusyJobId === job.id || runBusyJobId === job.id}
                        className="rounded border border-rose-500/25 bg-rose-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-rose-200 transition-colors hover:border-rose-400/50 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {deleteBusyJobId === job.id ? "Excluindo" : "Excluir"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="rounded border border-emerald-500/15 bg-emerald-500/[0.05] px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-200/85">
                  Reuniao Automatica
                </div>
                <div className="mt-1 font-mono text-[11px] leading-5 text-white/50">
                  Configure a reuniao diaria, a fonte Jira e o quadro de anotacoes manuais.
                </div>
              </div>
              <button
                type="button"
                onClick={() => void standup.startMeeting("manual")}
                className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-100 transition-colors hover:border-emerald-400/50 hover:text-white"
              >
                Iniciar agora
              </button>
            </div>

            <div className="mt-3 grid gap-3">
              <label className="flex items-center gap-2 font-mono text-[11px] text-white/75">
                <input
                  type="checkbox"
                  checked={standupScheduleEnabled}
                  onChange={(event) => setStandupScheduleEnabled(event.target.checked)}
                />
                Ativar reuniao agendada.
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  Expressao cron
                </span>
                <input
                  value={standupCronExpr}
                  onChange={(event) => setStandupCronExpr(event.target.value)}
                  className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  Fuso horario
                </span>
                <input
                  value={standupTimezone}
                  onChange={(event) => setStandupTimezone(event.target.value)}
                  className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  Segundos por participante
                </span>
                <input
                  value={standupSpeakerSeconds}
                  onChange={(event) => setStandupSpeakerSeconds(event.target.value)}
                  className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                />
              </label>

              <label className="flex items-center gap-2 font-mono text-[11px] text-white/75">
                <input
                  type="checkbox"
                  checked={standupAutoOpenBoard}
                  onChange={(event) => setStandupAutoOpenBoard(event.target.checked)}
                />
                Abrir automaticamente o quadro quando a reuniao comecar.
              </label>

              <label className="flex items-center gap-2 font-mono text-[11px] text-white/75">
                <input
                  type="checkbox"
                  checked={jiraEnabled}
                  onChange={(event) => setJiraEnabled(event.target.checked)}
                />
                Ativar fonte Jira.
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  URL base do Jira
                </span>
                <input
                  value={jiraBaseUrl}
                  onChange={(event) => setJiraBaseUrl(event.target.value)}
                  placeholder="https://company.atlassian.net"
                  className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none placeholder:text-white/20"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  Email do Jira
                </span>
                <input
                  value={jiraEmail}
                  onChange={(event) => setJiraEmail(event.target.value)}
                  className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  Token de API do Jira
                </span>
                <input
                  type="password"
                  value={jiraApiToken}
                  onChange={(event) => {
                    setJiraApiToken(event.target.value);
                    setJiraApiTokenConfigured(event.target.value.trim().length > 0);
                  }}
                  placeholder={
                    jiraApiTokenConfigured ? "Armazenado no host do Studio. Digite para substituir." : ""
                  }
                  className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                />
                {jiraApiTokenConfigured ? (
                  <span className="text-[10px] text-white/45">
                    Ja existe um token de API do Jira salvo no host do Studio.
                  </span>
                ) : null}
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  Chave do projeto Jira
                </span>
                <input
                  value={jiraProjectKey}
                  onChange={(event) => setJiraProjectKey(event.target.value)}
                  className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  JQL do Jira
                </span>
                <textarea
                  value={jiraJql}
                  onChange={(event) => setJiraJql(event.target.value)}
                  rows={3}
                  className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                />
              </label>

              <button
                type="button"
                onClick={() => void handleSaveStandupConfig()}
                disabled={standup.saving}
                className="rounded border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-100 transition-colors hover:border-emerald-400/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {standup.saving ? "Salvando configuracoes" : "Salvar configuracoes da reuniao"}
              </button>
            </div>

            <div className="mt-4 border-t border-white/10 pt-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                Entrada manual do quadro
              </div>
              <div className="mt-3 grid gap-3">
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                    Agent
                  </span>
                  <select
                    value={standupAgentId}
                    onChange={(event) => setStandupAgentId(event.target.value)}
                    className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                  >
                    <option value="">Selecione um agente</option>
                    {agents.map((agent) => (
                      <option key={agent.agentId} value={agent.agentId}>
                        {agent.name || agent.agentId}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                    Sugestao de responsavel no Jira
                  </span>
                  <input
                    value={manualJiraAssignee}
                    onChange={(event) => setManualJiraAssignee(event.target.value)}
                    className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                    Tarefa atual
                  </span>
                  <input
                    value={manualTask}
                    onChange={(event) => setManualTask(event.target.value)}
                    className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                    Bloqueios
                  </span>
                  <textarea
                    value={manualBlockers}
                    onChange={(event) => setManualBlockers(event.target.value)}
                    rows={3}
                    className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                    Anotacao manual
                  </span>
                  <textarea
                    value={manualNote}
                    onChange={(event) => setManualNote(event.target.value)}
                    rows={4}
                    className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => void handleSaveManualNotes()}
                  className="rounded border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-100 transition-colors hover:border-cyan-400/50 hover:text-white"
                >
                  Salvar anotacoes manuais
                </button>
              </div>
            </div>

            {standup.meeting ? (
              <div className="mt-4 rounded border border-white/8 bg-white/[0.03] px-3 py-3 font-mono text-[11px] text-white/65">
                <div>Fase da reuniao: {standup.meeting.phase}</div>
                <div>Participantes: {standup.meeting.participantOrder.length}</div>
                <div>
                  Participante atual: {standup.meeting.currentSpeakerAgentId ?? "Aguardando"}
                </div>
              </div>
            ) : null}
          </div>

          <div className="mt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
            Modelos
          </div>
          <div className="mt-3 space-y-2">
            {PLAYBOOK_TEMPLATES.map((template) => {
              const isSelected = template.id === selectedTemplateId;
              return (
                <div
                  key={template.id}
                  className={`rounded border px-3 py-3 transition-colors ${
                    isSelected
                      ? "border-cyan-400/30 bg-cyan-500/[0.06]"
                      : "border-white/8 bg-white/[0.03]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTemplateId((current) =>
                        current === template.id ? null : template.id
                      );
                      setError(null);
                      setActionMessage(null);
                    }}
                    className="w-full text-left"
                  >
                    <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-white/85">
                      {template.name}
                    </div>
                    <div className="mt-1 font-mono text-[11px] leading-5 text-white/50">
                      {template.description}
                    </div>
                  </button>

                  {isSelected ? (
                    <div className="mt-3 space-y-3 border-t border-cyan-500/10 pt-3">
                      <label className="flex flex-col gap-1">
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                          Agent
                        </span>
                        <select
                          value={selectedAgentId}
                          onChange={(event) => setSelectedAgentId(event.target.value)}
                          className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none"
                        >
                          <option value="">Selecione um agente</option>
                          {agents.map((agent) => (
                            <option key={agent.agentId} value={agent.agentId}>
                              {agent.name || agent.agentId}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-1">
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                          Name override
                        </span>
                        <input
                          value={nameOverride}
                          onChange={(event) => setNameOverride(event.target.value)}
                          placeholder={template.name}
                          className="rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-white/80 outline-none placeholder:text-white/20"
                        />
                      </label>

                      <button
                        type="button"
                        onClick={() => void handleCreate()}
                        disabled={createBusy}
                        className="w-full rounded border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-100 transition-colors hover:border-cyan-400/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {createBusy ? "Criando rotina" : "Iniciar rotina"}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
