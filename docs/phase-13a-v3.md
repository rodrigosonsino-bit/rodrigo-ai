# Fase 13a — Voz natural (TTS Gemini) — v3

Versão: v3 (corrige as rodadas 1 e 2 de auditoria). Autocontida: substitui `phase-13a-v1.md` e `phase-13a-v2.md` nos pontos de decisão; o levantamento medido do v1 (§1, §2, §2A, §2B) continua válido com as correções do §0C.
Data: 2026-10-07
Status: **Nada implementado. v3 ainda não reauditada.** Duas versões minhas foram rejeitadas (agy, Kimi). O processo manda delegar a v3; a delegação ao Hermes **falhou por o Docker Desktop estar parado** (`docker exec` sem socket), e subir o Docker é ação do usuário. **A v3 foi escrita por mim**, o que é exatamente o risco que a regra de delegação existe para cobrir; o controle é a **rodada 3 com um terceiro modelo** (§7).
Decisões do usuário (citadas literalmente): "Gemini TTS, voz Charon"; "Ativa a cobrança e escreve o plano" (cobrança ativada por ele: Nível 1 no projeto Rodrigo-AI); "pode pegar a mais barata das 4" (`gemini-3.8-flash-lite-tts`); "nivel 1" (fica no Nível 1: 10 RPM / 100 RPD por modelo); "kimi" (rodada 2); "sem atalho" (resposta a "protótipo descartável ou plano completo": plano completo).

## 0. Rastreabilidade

| Rodada | Auditor | Modelo | Entrada | Resultado |
|---|---|---|---|---|
| 1 | `agy` 1.3.1 (`--mode plan --effort high --print-timeout 40m`) | padrão do `agy`, **não capturado** (`model=""` no `cli.log`); também auditor das rodadas 1 e 3 da Fase 12 | cópia do repositório sem `.env`, `.env.*`, `docs/research/`, `.runtime/`, `.git/`; a chave real aparece 0 vezes | 219 linhas, 21 achados, REJEITADO; sem assinatura de falha |
| 2 | CLI `deepseek -m` | `moonshotai/kimi-k3` (NVIDIA NIM) | só o plano v2 recortado + contexto do código colado (não viu o repositório), 17,6 KB; **1ª tentativa com 23,8 KB deu timeout de leitura aos 290 s, 0 bytes**; a 2ª, enxuta, completou | 147 linhas, 13 achados, REJEITADO |

Relatórios e prompts: `docs/audits/f13a/` (rodada 1) e `scratchpad` da sessão (rodada 2; copiar para `docs/audits/f13a/plan-r2-kimi-k3.md` ao comitar). Nenhum auditor viu `docs/research/` nem `.env`.

## 0A. Rodada 1 — 21 achados (resumo; detalhe no v2 §0A)
Todos aceitos, exceto dois parcialmente refutados: (20) `f12Egress.test.ts` não quebra, pois usa `FakeTts` (`helpers/egress.ts:203`); (21) as cotas são por modelo e TTS e geração não competem. Verificados no código: work_loop mono-thread com `Queue(maxsize=1)` (`worker.py:599`, `:1112-1134`, `:1158-1163`); cancelamento por `_current` único (`:599-601`, `:642-648`); piso de 10 s do deadline HTTP (`:448-450`); `markPlayed` por texto exato (`sessionManager.ts:775-779`); `windowHistory` com `SEND_HISTORY=0` (só a fala do usuário); teste `privacyConsistency.test.ts:48-55` exigindo "nível gratuito".

## 0B. Fatos novos (rodada 1)
1. **A 1ª audição às cegas continha o `say` Felipe mudo** (5 arquivos de 4 096 bytes, 0 s) porque o `say` falhou dentro do sandbox. O usuário nunca ouviu a voz atual ao lado das outras. Regenerado e corrigido em `.runtime/audicao-tts/`.
2. **Volume (RMS dBFS), 5 frases:** `say` Felipe −17,0 a −17,5 (dispersão 0,8 dB); Flash-Lite −16,3 a −20,8 (4,5 dB); 3.1 Charon −17,2 a −25,4 (8,2 dB).

## 0C. Correções ao v1
- Linha de risco "chave compartilhada com a geração": removida (cotas por modelo).
- O gate de H13a.1 citava o modelo errado; o adotado é `gemini-3.8-flash-lite-tts` (`RODRIGO_TTS_MODEL`).

## 0D. Rodada 2 — 13 achados do Kimi e disposição

| # | Achado (gravidade do auditor) | Disposição |
|---|---|---|
| 1 | Threads de `synthesize` seguram o encerramento (ALTA) | **Refutado em parte, verificado:** `worker.py:1167-1169` faz `os._exit(0)` ao fechar o stdin; threads não seguram o processo. Resta: threads daemon, `.part` dentro do diretório da sessão (a limpeza da Fase 12 varre esse diretório), teste de saída rápida (§4.2) |
| 2 | `markPlayed` por texto frágil a duplicatas (MÉDIA) | **Aceito como teste**, não como mudança de protocolo: a pergunta de mutação vem de caminho determinístico e o servidor consome cada item uma vez. Teste novo com texto idêntico repetido e pergunta em posição ≥ 1 (H13a.15). Sem trocar `markPlayed` para ids |
| 3 | Arquivo de orçamento: corrupção, duas instâncias, relógio (MÉDIA) | **Aceito**, §4.4 |
| 4 | Contabilidade do 429 e `quotaId` desconhecido (ALTA) | **Aceito**, §4.4 |
| 5 | A "reserva" de 2 pedidos é só checagem (MÉDIA) | **Aceito**: reserva real com estorno (§4.4); risco reescrito ("reduz, não elimina") |
| 6 | Normalização ±6 dB contradiz H13a.5 (ALTA) | **Aceito**, §4.2 e H13a.5 |
| 7 | H13a.11 sem limiar (MÉDIA) | **Aceito**: métrica informativa com gatilho (§6) |
| 8 | Acoplar `SEND_HISTORY`↔TTS e a D-b (ALTA) | **Mantido e justificado** (§3); D-b continua do usuário |
| 9 | Ordem de entrega e falha do `say` (ALTA) | **Aceito e agravado, verificado no cliente** (`voice.ts:132-139`, `:310-325`): ele toca o que chega, ordenando só a fila presente; com 1–7 s de latência um grupo rápido tocaria antes da frase 0. **Emissão em ordem estrita no servidor** (§4.3) |
| 10 | Nenhum critério testa a regra de privacidade/D-b (MÉDIA) | **Aceito**: H13a.14 |
| 11 | Orçamento dos testes reais conflita (MÉDIA) | **Aceito**: tabela de gasto (§6) |
| 12 | Cancelamento e custo (MÉDIA) | **Aceito**, §4.2/§5 |
| 13 | Prazo local de 8 s apertado (BAIXA) | **Aceito com ajuste**: 8 s na frase 0, 12 s nas demais (§4.2) |

## 3. Canal, privacidade e termos

- Flag `RODRIGO_CLOUD_TTS` em `privacy.ts`, estrita ("0"/"1"), só com o mestre `RODRIGO_CLOUD=1`. Padrão proposto: `1`. Todo canal novo tem controle e entra no cartão, no README, em `.env.example`, em `CLAUDE.md` e na medição de egresso.
- **O texto falado não era sempre um dado que já saía.** (a) Com `RODRIGO_SEND_HISTORY=0` nenhuma fala do assistente saía (`windowHistory`); (b) frases cortadas por barge-in nunca entram no histórico, mas iriam ao TTS **antes** de serem ouvidas, **também com `SEND_HISTORY=1`**; (c) saídas de ferramentas só saíam via histórico. Isso é uma **expansão real da fronteira de dados**, declarada no cartão, no README e no modelo de ameaça.
- **Regra conservadora (mantida):** `RODRIGO_CLOUD_TTS` fica **efetivamente desligado quando `RODRIGO_SEND_HISTORY=0`** (quem escolheu isso declarou que fala do assistente não sai; na dúvida, local), e o cartão mostra o motivo. É uma regra de segurança por omissão e não resolve o caso (b), que é aceito e divulgado.
- **D-b (decisão do usuário, aberta):** confirmações que repetem conteúdo ditado (prévia de lembrete, nota, memória) vão à nuvem? **Opção 1:** sim por padrão (uma voz só), local quando `RODRIGO_SEND_MEMORIES=0`. **Opção 2:** local por padrão quando o conteúdo repetido veio do usuário (mais privada; a voz troca nas confirmações). O plano implementa a escolha dele por uma flag; H13a.14 cobre as duas.
- **Termos do Google:** o projeto está no Nível 1 com faturamento; README, cartão e `CLAUDE.md` dizem que o nível gratuito permite ao Google usar e revisar o conteúdo, o que pode não valer para esta chave. A implementação **relê `ai.google.dev/gemini-api/terms`** e corrige os quatro lugares ao estado real. `privacyConsistency.test.ts` troca "deve divulgar o nível gratuito" por "deve divulgar o regime de termos em vigor da chave" (gratuito ou pago), mantendo a proibição de promessas de localidade e de ausência de custo.

## 4. Desenho

### 4.1 Modelo e voz
`gemini-3.8-flash-lite-tts` (`RODRIGO_TTS_MODEL`), voz `Charon` (`RODRIGO_TTS_VOICE`), **só o texto da frase, sem prefixo de estilo** (o modelo lê a instrução em voz alta e rejeita `system_instruction`: HTTP 400). Nome fixo, nunca alias. Preço oficial lido em 2026-10-07: US$ 6 por milhão de tokens de áudio de saída até 31/12/2026, US$ 12 depois; 25,0 tokens de áudio por segundo medidos.

### 4.2 Worker
- **`synthesize` não passa por `work_loop` nem `work_queue`.** O leitor de stdin o despacha a um `ThreadPoolExecutor(max_workers=2)` de threads **daemon**, dentro do worker. Geração, classificação e transcrição seguem como estão.
- **Cancelamento por pedido:** `synthesize` traz `reqId` e `turnId`; `_syntheses[reqId] = {cancel_event, handle}` sob lock próprio, distinto de `_current`. `cancel_synth {reqId}` é **idempotente** (no-op com ack se o `reqId` já terminou ou é desconhecido); o cancelamento de turno cancela também as sínteses do `turnId`; o `handle_cancel` atual de `generate` não muda. Ao fechar o stdin, `os._exit(0)` já encerra tudo (verificado).
- **Prazos:** o cliente HTTP do TTS usa `timeout_ms >= 12 000` (piso do Google: 10 000). O prazo local é **8 s para a frase de índice 0** (falha rápido: o usuário não espera em silêncio) e **12 s para as demais** (o áudio anterior já toca). Estourado, seta o `cancel_event`, fecha o fluxo e o provedor cai no `say`.
- **Contêiner WAV:** PCM 24 kHz, mono, 16 bits, módulo `wave`, gravado em `outputPath + ".part"` **dentro do diretório da sessão** (varrido pela limpeza da Fase 12) e `os.replace` ao fim; cancelamento ou erro apaga o `.part`.
- **Normalização de volume:** RMS-alvo −17,0 dBFS, medido **só nas amostras acima de −50 dBFS** (gate de silêncio); ordem **ganho → limitador de pico (−1 dBFS) → verificação de RMS**; teto de ganho **±9 dB**. Frases que saturam o teto são marcadas, não reprovadas (H13a.5).
- `redact()`, `safe_exc`, nada de texto da frase em log, redirecionamentos não seguidos, cliente por `build_gemini_client`.

### 4.3 Node: coalescência e emissão em ordem
- O contrato do provedor não muda (`synthesize(text, outputPath, signal)`), mas **`sessionManager.ts` muda**.
- **Invariantes:** pergunta de mutação (`armedMutation.question`), reprompt (`MUTATION_REPROMPT_TEXT`), saídas de ferramentas, `GENERATION_DISABLED_TEXT` e a **frase de índice 0** nunca são coalescidas; cada uma vai sozinha, com o texto idêntico ao que `markPlayed` espera.
- **Coalescência:** buffer só para frases de índice ≥ 1 de uma geração, descarregado quando (a) somaria mais de 300 caracteres, (b) já tem 3 frases, (c) a geração termina (`done` descarrega o resíduo), (d) o turno é cancelado (descarta). `sentenceIndex` emitido é monotônico por item.
- **Emissão em ordem estrita (achado 9, verificado no cliente):** o servidor emite `sentence_audio_ready` do item **n+1 só depois de o item n resolver** (sucesso, falha ou cancelamento), com **timeout de prontidão de 15 s por item**; passado isso, o item é pulado e registrado. Isso vale para o `say` também (sem custo visível, 0,5 s). **Falha do próprio `say`:** pula a frase, registra, nunca bloqueia o turno, nunca chama `markPlayed` para ela.
- **Custo declarado:** uma interrupção dentro de um grupo faz o grupo inteiro não entrar no histórico (conservador quanto a falso histórico; o modelo pode repetir o que o usuário já ouviu). Medido em H13a.11.

### 4.4 Orçamento, reserva e 429
- **Reserva real por turno:** antes da frase 0 de uma resposta o limitador **concede e decrementa 2 pedidos** (minuto e dia); ao fim do turno estorna o que não usou. Sem saldo, o **turno inteiro** vai ao `say`. Se o saldo acabar depois de o turno começar no Gemini, o resto cai no `say` (disjuntor, contado em H13a.6). **Isto reduz, não elimina, a troca de voz dentro de turnos longos.**
- **Minuto:** janela deslizante de 8 pedidos/min (`RODRIGO_TTS_RPM`).
- **Dia:** `.runtime/tts-budget.json`, lockfile (`O_EXCL`) + `.tmp` + `rename`, dia indexado em **`America/Los_Angeles`**, recalculado a cada uso (o horário de virada do Google **não foi verificado**; mudança de relógio é risco aceito e declarado). **Ausente = dia novo (zero). Corrompido ou erro de I/O = esgotado** (fail-closed), com log e contador de ocorrências. Padrão `RODRIGO_TTS_RPD=90`. Duas instâncias do app compartilham a cota do Google; o contador local é estimativa conservadora e isso é documentado.
- **Contabilidade:** todo pedido **enviado** ao Google desconta (o Google conta), inclusive 429 e cancelados; pedido bloqueado localmente não desconta.
- **Assinatura do 429:** o worker lê `error.details[].violations[].quotaId` e `retryDelay`. `PerMinute` → bloqueia pelo maior entre `retryDelay`+1 s e o piso local. `PerDay` → bloqueia até a virada do dia (fuso acima). **Desconhecido ou ausente → backoff exponencial 30 s, 60 s, 120 s, teto 15 min**, valendo o maior com `retryDelay`; registra o corpo completo (redigido). Só a assinatura por minuto está observada (§2A do v1); a diária é capturada em H13a.12.

### 4.5 Fora do escopo
Streaming do PCM ao cliente (F13b); Gemini Live; clonagem de voz; Qwen3-TTS e Chatterbox como motores; Nível 2 (decisão do usuário).

## 5. Riscos

| Risco | Tratamento |
|---|---|
| Worker bloqueado pela geração | `synthesize` fora do `work_loop`; H13a.13 |
| Prazo < 10 s rejeitado pelo Google (400 sem fallback) | HTTP ≥ 12 s; prazos locais 8/12 s |
| Modelo *preview* some | nome fixo, variável de troca, `say` de fallback |
| Flash-Lite menos humano que o 3.1 | gate 0 (§7); H13a.10 |
| **Frases fora de ordem no cliente** | emissão em ordem estrita + timeout de 15 s (§4.3) |
| Troca de voz dentro do turno | reserva real **reduz, não elimina**; o app admite trocar quando o orçamento acaba depois do início |
| Volume desigual | normalização com gate; H13a.5 |
| Custo | ~US$ 0,009/min até 31/12/2026, ~US$ 0,018/min depois; ≤ 90 pedidos/dia |
| **Custo de frases canceladas por barge-in** | pedidos cancelados descontam do orçamento; que o Google cobre os tokens gerados até o cancelamento é **suposição não verificada** |
| Cota diária acaba antes do fim do dia | `say` assume; cartão avisa "voz natural: N de 90 pedidos hoje" |
| Conteúdo ditado vai à nuvem | D-b |
| Texto não ouvido (barge-in) vai à nuvem | expansão divulgada (§3) |
| Duas instâncias | cota compartilhada, contador estimativo (§4.4) |

## 6. Critérios de aceite

- **H13a.1** — contra o Gemini falso em loopback: 100 turnos de 2 a 8 frases; zero 429 do Google e ≥ 75% das frases sintetizadas pelo "Gemini".
- **H13a.2** — `RODRIGO_CLOUD=0`, `RODRIGO_CLOUD_TTS=0` ou `RODRIGO_SEND_HISTORY=0`: zero conexão de saída para TTS (50 sínteses, como `f12Offline.test.ts`).
- **H13a.3** — latência do início da síntese até `sentence_audio_ready`: 100 frases contra o Gemini falso com latência injetada + **20 frases reais**; mediana ≤ 3,0 s, p95 ≤ 6,0 s nas reais (propostas; amostras de 2026-10-07: mediana 1,75–2,16 s, máximo 6,87 s).
- **H13a.4** — 0 de 20 frases reais com texto estranho na transcrição do Whisper local.
- **H13a.5** — depois da normalização, o RMS (com gate de −50 dBFS) de todas as frases fica a ≤ 1,5 dB de −17,0 dBFS; **frases que saturaram o teto de ganho são reportadas, não reprovadas**.
- **H13a.6** — sessão de até 30 turnos de **até 4 frases**, com **arquivo de orçamento injetado** (RPD alto só no teste): quedas por **erro** (429, 5xx) ≤ 5%, quedas por **timeout local** separadas, quedas por **esgotamento do orçamento** reportadas à parte.
- **H13a.7** — egresso contra Gemini falso, teste novo `f13EgressTts.test.ts` com provedor e worker reais, contando pedidos de TTS à parte; só texto das frases sai, zero áudio do usuário. Os testes da Fase 12 seguem com `FakeTts`.
- **H13a.8** — falha injetada: 429, 503, timeout, 404 → `say`; 400/401/403 → erro de configuração.
- **H13a.9** — `privacyConsistency.test.ts` verde com a asserção nova.
- **H13a.10** — voz (só o usuário): numa sessão real, a voz deixou de soar robotizada.
- **H13a.11 (informativa, com gatilho)** — 20 interrupções simuladas dentro de grupos coalescidos; se mais de 25% perderem frases ouvidas do histórico, o grupo cai de 3 para 2 frases.
- **H13a.12** — captura deliberada da assinatura do 429 diário, com frases mínimas; **roda por último e em dia próprio**, com aviso ao usuário; sem sessão real do usuário nesse dia.
- **H13a.13** — com uma geração de 5 s em andamento no worker real (fake Gemini), uma síntese da frase 0 conclui em < 3 s (não espera a geração).
- **H13a.14** — matriz `RODRIGO_SEND_HISTORY` × `RODRIGO_SEND_MEMORIES` × tipo de frase (resposta gerada, confirmação com conteúdo ditado, hora/data) × provedor usado, contra o provedor falso, cobrindo **as duas** respostas possíveis da D-b.
- **H13a.15** — frases de texto idêntico no mesmo turno e pergunta de mutação em posição ≥ 1: `markPlayed` e a promoção de mutação seguem corretos.
- **H13a.16** — encerramento rápido: fechar o stdin do worker com 2 sínteses em curso termina o processo em < 1 s e deixa 0 `.part` após a limpeza.
- **H13a.17** — emissão em ordem: com latências injetadas invertidas (item 1 conclui antes do item 0), o cliente recebe `sentence_audio_ready` na ordem 0, 1; item que estoura 15 s é pulado e registrado.

**Gasto de cota real da verificação** (limite do dia: 100 pedidos; meus testes de hoje já consumiram parte, a cota do dia seguinte é limpa): H13a.3 ao vivo ≈ 20; H13a.4 reaproveita esses áudios (0 extra); H13a.10 é a sessão normal do usuário; H13a.6 e a bateria de 100 usam o Gemini falso (0); H13a.12 esgota o dia, por último.

## 7. Gates antes de qualquer código

0. **Gate 0 (usuário):** ouvir `.runtime/audicao-tts-baratos/index.html` (e `.runtime/audicao-tts/index.html`, com o Felipe corrigido) e confirmar que o Flash-Lite sem tom serve; se não servir, trocar para 3.8 Flash ou 3.1 por variável e recalcular o §6.
1. **D-b** respondida (§3) e **revisão dos termos do Google** do §3 agendada.
2. **Rodada 3 de auditoria com um terceiro modelo** (nem `agy` nem Kimi): Codex, ou o Hermes quando o Docker estiver de pé. Este é o controle contra eu mesmo ter escrito a v3. **Código:** auditoria do Hermes depois de implementado, executando a suíte e tentando quebrar `synthesize` fora do `work_loop`.
3. Verificar na realidade depois (sessão real); aprovação para implementar não é "pronto".
4. **Estado de entrega a registrar ao comitar:** `docs/phase-13a-v1.md`, `-v2.md`, `-v3.md` e `docs/audits/f13a/` estão **não comitados** no momento desta escrita (as mudanças da Fase 12 também estavam não comitadas ao início desta conversa).
