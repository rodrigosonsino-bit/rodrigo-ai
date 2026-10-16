# Auditoria de Plano T7 — OpenCode

- **Data:** 2026-10-16
- **Ferramenta:** `opencode run`
- **Modelo efetivo:** `google/gemini-2.5-flash`
- **Entrada principal:** `docs/plans/t7-personaplex-spike-e-integracao.md`
- **Contexto adicional enviado no prompt:** invariantes minimos do projeto (pipeline classico textual, audio local no estado atual, loopback-only, plano remoto opcional e chat-only)
- **Status:** concluida com resposta

## Prompt usado

```text
Audite adversarialmente, em modo read-only, o plano anexado. Contexto minimo: pipeline atual = audio -> STT local -> classificacao/roteamento/ferramentas -> geracao textual -> TTS; hoje o audio do usuario nao sai da maquina; o app e loopback-only; o plano propoe PersonaPlex remoto opcional e chat-only. Procure falhas de desenho, regressao arquitetural, riscos de privacidade, conflitos com esses invariantes e criterios de aceite insuficientes. Responda em portugues com VEREDITO, achados numerados por gravidade com evidencia e recomendacao, e perguntas abertas se houver.
```

## Resultado bruto

### VEREDITO

**CONDICIONAL (Aprovado com ressalvas arquiteturais e de seguranca).** O plano acerta ao propor o PersonaPlex como uma trilha paralela e isolada (default-off, sem tentar deformar o `IVoiceProvider` ou o pipeline classico), mas **omite controles criticos de seguranca de rede (`outboundGuard`), especificacao do protocolo de transporte de streaming e garantias contra vazamento de estado/memoria**. Nao deve ser implementado antes de fechar as lacunas de seguranca de egress e de especificar a mediacao do streaming full-duplex no Node.

### ACHADOS (Por Gravidade)

#### 1. [Critico] Ausencia de integracao com o `outboundGuard` e validacao de egress para audio bruto

- **Evidencia:** O plano menciona flags como `RODRIGO_PERSONAPLEX=0|1` e atualizacoes em `privacy.ts`, mas ignora o subsistema de guarda de saida recem-criado na trilha OpenJarvis (`src/backend/privacy/outboundGuard.ts` e `scripts/worker/outbound_guard.py`).
- **Risco:** O invariante do projeto e que nenhum dado sensivel vaza indevidamente. O PersonaPlex exige envio de audio bruto do usuario pela rede para um host remoto (`RODRIGO_PERSONAPLEX_URL`). Se o `outboundGuard` nao estiver ciente e configurado para autorizar esse destino especifico, ou se houver vazamento de tokens/metadados da sessao classica para o host remoto, isso violara a politica de privacidade estrita do projeto.
- **Recomendacao:** Exigir explicitamente que `RODRIGO_PERSONAPLEX_URL` seja listado em uma allowlist estrita validada pelo `outboundGuard` na inicializacao, falhando fechado caso a URL seja generica ou nao autorizada.

#### 2. [Critico] Indefinicao do protocolo de transporte full-duplex no backend Node

- **Evidencia:** O plano propoe que o backend Node atue como mediador ("o navegador nunca acessa o servidor remoto diretamente, o backend Node o repassa ao PersonaPlexClient"), mas o servidor oficial do PersonaPlex (Moshi) opera via WebSockets / SSL / fluxos continuos de audio em tempo real.
- **Risco:** Node.js lidando com streaming binario bidirecional de baixa latencia (full-duplex WebSocket-to-WebSocket ou HTTP Chunked) via proxy manual pode introduzir gargalos severos de CPU, buffer bloat, latencia inaceitavel ou vazamento de descritores de arquivo/sockets zumbis em caso de desconexao abrupta (barge-in continuo).
- **Recomendacao:** Especificar no plano se o `PersonaPlexClient` utilizara WebSockets persistentes, gRPC ou HTTP streaming, e como o Node gerencia o ciclo de vida dessas conexoes para evitar travamentos de event loop.

#### 3. [Medio] Risco de ambiguidade cognitiva e perda de contexto de memoria na UI

- **Evidencia:** O MVP exclui lembretes, notas e memorias, focando em "chat livre por voz". No entanto, o usuario que ja interage com o Rodrigo AI com memoria cross-session (Phase 7/8/9) e agentes especialistas (Teologia/Virtologia) pode estranhar e confundir o modo PersonaPlex com o assistente principal.
- **Risco:** Frustracao de expectativas ou confusao sobre se o que foi dito no modo PersonaPlex foi memorizado pelo sistema.
- **Recomendacao:** Alem de um aviso visual, a UI deve adotar uma mudanca cromatica radical (ex: tema visual completamente distinto, cor de fundo ou moldura de alerta permanente) quando o modo PersonaPlex estiver ativo, tornando impossivel confundi-lo com o modo classico.

#### 4. [Baixo] Mitigacao incompleta de falhas no host remoto

- **Evidencia:** A Fase 4 diz: "se o servidor PersonaPlex falhar, encerrar a sessao experimental com aviso claro; nao migrar silenciosamente".
- **Risco:** Se a conexao cair no meio de uma frase do usuario, o cliente frontend pode ficar em estado orfao aguardando pacotes de audio.
- **Recomendacao:** Definir um timeout estrito de heartbeat (ex: 3 segundos sem pacotes de audio do servidor remoto encerra a sessao com evento SSE `personaplex_error` e limpa os buffers de audio do microfone no cliente).

### CRITERIOS DE ACEITE FALTANTES

1. **Teste de Isolamento de Codigo (Dead Code / Guardrail):** Garantir via teste automatizado que, quando `RODRIGO_PERSONAPLEX=0`, nenhum modulo de cliente ou sessao do PersonaPlex e carregado na memoria do processo Node.
2. **Auditoria de Egress:** Teste unitario/integrado provando que nenhuma requisicao sai para `RODRIGO_PERSONAPLEX_URL` quando a flag esta desligada.

### PERGUNTAS ABERTAS PARA O RODRIGO

1. Qual e o protocolo de rede exato exigido pelo servidor oficial do PersonaPlex (Moshi) para comunicacao com clientes externos (WebSockets, gRPC ou HTTP/2)?
2. O host remoto NVIDIA planejado para a Fase 0 e uma instancia autohospedada em nuvem (ex: RunPod/Vast.ai) sob seu controle direto, garantindo que nenhum terceiro alem de voce tem acesso ao fluxo de audio?
