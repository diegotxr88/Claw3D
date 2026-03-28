# Claw3D — Multi-Mission Control Configuration

## Visão Geral
O Claw3D agora suporta visualização unificada de agentes de múltiplos Mission Controls (M2 + i5/Loop).

## Configuração de Fontes

### M2 (Local)
- **URL:** `http://127.0.0.1:4000` (ou valor de `MISSION_CONTROL_URL`)
- **Token:** `MC_API_TOKEN` (opcional)
- **Identificação:** Sem sufixo (agentes aparecem como "Doc", "Coder", etc.)

### i5 (Loop)
- **URL:** `https://jillian-unliftable-suk.ngrok-free.dev` (ou valor de `MISSION_CONTROL_LOOP_URL`)
- **Token:** `MC_API_TOKEN_LOOP` (opcional)
- **Identificação:** Com sufixo "-Loop" (agentes aparecem como "Loop", "Builder Agent-Loop", etc.)

## Variáveis de Ambiente (.env.local)

```bash
# M2 (local)
MISSION_CONTROL_URL=http://127.0.0.1:4000
MC_API_TOKEN=seu_token_aqui

# i5 (Loop remoto)
MISSION_CONTROL_LOOP_URL=https://jillian-unliftable-suk.ngrok-free.dev
MC_API_TOKEN_LOOP=token_do_loop_se_houver
```

## Comportamento

1. **Busca paralela:** O endpoint `/api/mission-control/agents` busca de todas as fontes simultaneamente
2. **Sufixo automático:** Agentes do i5 recebem "-Loop" no nome automaticamente
3. **Deduplicação:** Se houver agentes com mesmo nome em ambas as fontes, apenas um é mantido
4. **Resiliência:** Se uma fonte falhar, a outra continua funcionando

## Teste

```bash
# Verificar se endpoint está retornando agentes de ambas as fontes
curl http://localhost:3000/api/mission-control/agents | jq '.[] | {name, source}'
```

## Troubleshooting

### Loop aparece como "offline"
- Verificar se URL do ngrok está acessível: `curl https://jillian-unliftable-suk.ngrok-free.dev/api/agents`
- Verificar se ngrok tunnel está ativo no i5
- Verificar logs do Claw3D: `npm run dev` e observar console

### Duplicatas de agentes
- Verificar se sufixo está sendo aplicado corretamente
- Verificar se IDs são únicos entre as fontes

### Performance lenta
- Busca paralela deve ser rápida, mas se uma fonte estiver lenta pode afetar o todo
- Considerar timeout específico por fonte se necessário

## Próximos Passos

- [ ] Adicionar indicador visual no Claw3D mostrando qual MC cada agente vem
- [ ] Adicionar filtros ("Mostrar apenas M2", "Mostrar apenas Loop", "Mostrar todos")
- [ ] Configurar cores diferentes para agentes de cada fonte
- [ ] Implementar retry automático se uma fonte falhar