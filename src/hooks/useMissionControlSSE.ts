"use client";

import { useEffect, useRef } from "react";

/**
 * useMissionControlSSE
 * Conecta ao endpoint SSE do Mission Control (localhost:4000/api/events/sse)
 * e, ao receber evento 'agent_status_changed', executa um callback (ex: reload de agentes).
 *
 *用法:
 *   const reloadAgents = useMissionControlSSE(() => {
 *     // recarregar agentes
 *   });
 */
export function useMissionControlSSE(onAgentStatusChange: () => void) {
  const onChangeRef = useRef(onAgentStatusChange);
  onChangeRef.current = onAgentStatusChange;

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const connect = () => {
      if (destroyed) return;

      // Aponta para o MC local (mesma máquina onde o Claw3D roda)
      es = new EventSource("http://localhost:4000/api/events/stream");

      es.onopen = () => {
        console.log("[SSE] Conectado ao Mission Control");
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Recarrega presence em tempo real quando agente muda de status
          // Inclui agent_status_changed (dispatch) e task_status_changed (PATCH/complete)
          if (data?.type === 'agent_status_changed' || data?.type === 'task_status_changed') {
            console.log('[SSE] Evento de status recebido, recarregando presence...', data.type, data.payload);
            // Recarrega imediatamente — não espera o próximo polling de 5s
            onChangeRef.current();
          }
        } catch {
          // JSON inválido — ignorar
        }
      };

      es.onerror = () => {
        if (destroyed) return;
        console.warn("[SSE] Erro de conexão, reconectando em 5s...");
        es?.close();
        es = null;
        retryTimeout = setTimeout(connect, 5_000);
      };
    };

    connect();

    return () => {
      destroyed = true;
      es?.close();
      es = null;
      if (retryTimeout !== null) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }
    };
  }, []);
}
