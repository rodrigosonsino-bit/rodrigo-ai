# Fase V — O app enxerga a tela e conversa sobre ela (plano v3)

Data: 2026-10-08. Autor: Claude Opus 5.5. Estado: **plano v3 = v2 + ajustes da rodada 2 (agy: APROVAR COM AJUSTES, docs/audits/vision-plan-agy-r2-2026-10-08.md). Aprovado para implementar em fatias.** Onde o §10 contradiz o texto anterior, o §10 vale.
Substitui `docs/phase-vision-v1.md` (REFAZER — `docs/audits/vision-plan-codex-r1-2026-10-08.md`, 17 achados). A tabela do §9 mapeia
cada achado da rodada 1 para a resposta deste plano.

## 0. Decisões do usuário (citadas literalmente, AskUserQuestion em 2026-10-08)

| Pergunta | Resposta |
|---|---|
| Quem interpreta a imagem? | **"Os dois, com escolha por voz"** — "Padrão local; Gemini só quando você disser explicitamente (ex.: 'olha com o Gemini')" |
| Com que voz o app fala a resposta da visão LOCAL? | **"Voz do Gemini mesmo"** — "Uma voz só, mais natural; mas o TEXTO da resposta sobre a tela vai ao Google (a imagem não)" |
| Como o app sabe que a pergunta é sobre a tela? | **"Só quando eu disser (Recomendado)"** — "Cada pergunta precisa citar a tela" |

Consequência para a fronteira de privacidade (vale só nos termos acima):

| O que | Sai da máquina? |
|---|---|
| Imagem da tela, visão local (padrão) | **Nunca** |
| Imagem da tela, com autorização explícita na fala daquele turno + `RODRIGO_CLOUD_VISION=1` | Sim, só naquele turno, só ao Gemini |
| Texto da resposta sobre a tela (qualquer motor) | Sim, **apenas** ao TTS do Gemini, para virar voz (decisão "Voz do Gemini mesmo"); com o canal de TTS desligado, voz do sistema |
| Pergunta e resposta de um turno de tela, em turnos SEGUINTES (histórico, geração, intenção em nuvem) | **Nunca** — marcadas e removidas de todo envio posterior |

## 1. Medições (2026-10-08, M5, 16 GB) — inalteradas da v1

Qwen3-VL-4B-Instruct-4bit: 3,3 s aquecido, pico 4,0 GB, leu certo um erro do npm num print real, respeitou "3 frases". Não
diagnosticou a causa. Carga do disco e Gemini com imagem **não medidos** (medir na implementação; o Gemini com imagem só com uma
captura sintética, nunca com a tela real do usuário).

## 2. Escopo da primeira versão

Dentro: compartilhar tela pelo navegador; pergunta que cita a tela → captura de UM quadro → visão local (ou Gemini por autorização
explícita) → resposta falada. Fora (registrado como pós-V): continuação automática, captura contínua, ação sobre a tela (clicar,
digitar), OCR para memória/nota.

## 3. Detecção do turno de tela — ANTES de qualquer gravação no histórico

Logo após a transcrição (`runTurn`, antes de `session.history.push`, hoje `sessionManager.ts` ~l.391), o turno calcula
`turn.provenance`:

1. Há `session.pendingMutation` válida (não expirada)? → o turno é de **confirmação**, `provenance = 'normal'`, segue o caminho
   atual. Uma fala que cita a tela durante uma confirmação **não** é tratada como tela (o classificador de mundo fechado devolve
   AMBIGUO/NAO, como hoje). Teste com reprompt.
2. Senão, `mightBeScreenQuery(transcript)` (lista fechada, §3.1) → `provenance = 'screen'`. Senão → `'normal'`.

A mensagem de usuário entra no histórico JÁ com `origin: 'screen'` quando for o caso. Um turno `screen` **nunca** chega aos
detectores de intenção em nuvem, mutação, ferramenta nem à classificação: desvia direto para §5 e termina lá.

### 3.1 Filtro `mightBeScreenQuery` (novo `src/backend/tools/screenQuery.ts`)

Exige referência explícita à tela: "tela", "monitor", "desktop", "área de trabalho", "janela", "o que (está|aparece) aqui (na
frente|na tela)". Palavras soltas como "isso", "esse erro" **não** bastam (decisão "Só quando eu disser"). Testes com positivas e
negativas, incluindo "anota que a tela do celular quebrou" → **não** é tela? Decisão: "anota"/"lembra"/"memoriza" no início vencem
(mutação), para não engolir pedido de nota. Teste.

### 3.2 Autorização para o Gemini ver a imagem

Gramática afirmativa, na transcrição DESTE turno, nunca em histórico ou em texto lido da tela:
- autoriza: `(com|usa|usando|pelo|via|pergunta (pro|ao)) (o )?gemini`, `manda pro gemini`;
- **bloqueia** (vence sempre): qualquer negação na mesma fala junto de "gemini"/"nuvem" — "não", "sem", "nunca", "nem", "evita";
- qualquer outro caso: local.
Matriz de testes: afirmativas, negações, citações ("o que significa 'usa o gemini'?" → local), frases contraditórias.

## 4. Captura: protocolo de uso único

- Botão "Compartilhar tela" → `getDisplayMedia({ video: true, audio: false })`; "Parar compartilhamento" para o stream. O cliente
  informa o estado ao servidor (`POST .../screen-state {sharing}`) só para a frase de erro certa; o servidor **não** confia nisso
  para nada além da mensagem.
- Turno `screen` → o servidor cria `captureRequest = { captureId: uuid, turnId, deadline: agora+5 s }` na sessão (no máximo UM
  pendente; o anterior é invalidado) e emite SSE `screen_request { turnId, captureId }`.
- Cliente: um quadro do `<video>` → `<canvas>` com lado maior ≤ 1280 px → **JPEG qualidade 0,8** (PNG de alta entropia em 1280² mede
  ~4,9 MB, achado 8). Sem compartilhamento: `POST .../screen { captureId, unavailable: true }`.
- `POST /api/voice/session/:id/screen?captureId=...`: **autentica sessão e consome a requisição ANTES de ler o corpo para o disco**
  (achado 7). Rejeita (e não grava nada) se: sessão inválida/encerrada; `captureId` ausente, diferente do pendente, já consumido ou
  vencido; turno do pedido não é mais o `activeTurn`. Consumo é síncrono (sem `await` entre checar e marcar consumido).
- Corpo: limite **3 MiB**, assinatura JPEG (`FF D8 FF`) obrigatória, dimensões lidas do cabeçalho SOF ≤ 1600×1600; fora disso,
  rejeita e apaga. O worker decodifica com teto de pixels (`PIL.Image.MAX_IMAGE_PIXELS = 1600*1600`).
- Depois de gravar: revalida que o turno continua ativo; senão apaga e para.
- Prazo de 5 s sem quadro, `unavailable`, ou rejeição → frase fixa ("Compartilhe a tela no botão da página e pergunte de novo.").

## 5. Resposta

### 5.1 Visão local (padrão)

- Comando novo do worker `describe_screen { reqId, turnId, imagePath, question }` no `work_loop` (fila serial MLX).
- **Cancelamento desde o despacho (achado 10, defeito PRÉ-EXISTENTE também para `generate`):** o worker mantém
  `cancelled_turns` (conjunto limitado aos últimos 64); `handle_cancel` registra o `turnId` ali **antes** de sinalizar o `_current`.
  O `work_loop` descarta, sem executar, qualquer comando cujo `turnId` esteja no conjunto; `handle_generate` e `describe_screen`
  checam o conjunto imediatamente antes de qualquer chamada externa e antes de carregar a imagem. Corrige também a geração
  enfileirada de turno cancelado que hoje ainda pode chamar o Gemini.
- Geração com `mlx_vlm.stream_generate`, checando cancelamento a cada token. Prefill não é interrompível: medir o pior caso
  (critério HV.8).
- Modelo provisionado no `setup:voice` (repo + **revisão fixada**, `HF_HOME` do app), carga sob demanda com o worker já em modo
  offline; timeout de carga 60 s; descarga após 10 min sem uso, implementada com `work_queue.get(timeout=30)` para o loop acordar
  sozinho. Medir carga do disco e pico de memória com os três modelos juntos.
- Prompt fixo: "Você vê uma captura da tela do usuário. Responda em português, no máximo 3 frases curtas, sem markdown. Se não
  conseguir ler, diga." + a pergunta. **Sem histórico** (simplifica e evita reinjetar conteúdo de tela).

### 5.2 Gemini (só com §3.2 + `RODRIGO_CLOUD_VISION=1` + mestre `RODRIGO_CLOUD=1`)

- `generate_content_stream` com `[imagem JPEG, prompt fixo + pergunta]`. **Sem** histórico, memória, conhecimento.
- Checagem do turno cancelado imediatamente antes da chamada (§5.1).
- A página registra "Tela enviada ao Google às HH:MM" a partir do evento real de despacho (`screen_sent`), não da captura. Sem aviso
  falado prévio (a autorização é a própria fala do usuário; achado 13 — removida a promessa de "avisar antes").
- Canal desligado com pedido explícito → resposta local, começando por "A visão pelo Gemini está desligada, então olhei aqui mesmo."

### 5.3 Voz e histórico

- As frases da resposta seguem `onSentence` → TTS da F13a como `kind: 'generated'` (texto ao TTS do Gemini, aprovado em §0).
- `emittedSentences` passa a guardar `origin`; `markPlayed` grava a resposta no histórico com `origin: 'screen'`, inclusive se a
  confirmação de reprodução chegar depois de `activeTurn = null` (a origem vem do item emitido, não do turno ativo).
- `windowHistory` remove **toda** mensagem `origin: 'screen'` (usuário e assistente), nos dois ramos (`sendHistory` ligado e
  desligado — no desligado, se a última mensagem for `screen`, não envia nada dela). O turno `screen` não é gravado em memória
  (`memorias.json`) por nenhum caminho (não passa por mutação).

### 5.4 Arquivos e logs

- O JPEG pertence ao turno; apagado num `finally` em TODAS as saídas (resposta, falha, cancelamento, prazo, rejeição, reinício do
  worker), idempotente. O worker só lê o arquivo; o Node só apaga depois do `describe_screen` resolver ou do cancelamento
  confirmado. A varredura da F12 continua sendo o backstop para queda do processo.
- Logs: só contagens e tempos (`[screen] turno=… motor=local bytes=… ms=…`). Nunca pergunta, resposta, texto lido nem caminho com
  conteúdo. Erros estruturados (`kind`), sem `str(exc)` de bibliotecas de visão. Teste que captura stdout/stderr procurando um
  marcador plantado na imagem e na pergunta.

## 6. Interrupção

Turno de tela fica em `processando` (não usa `aquecendo` com fala). Uma fala nova preempta quando o áudio chega (comportamento
atual); com §5.1 o worker libera em ≤ critério HV.8. O botão "Interromper" passa a funcionar também em `processando` **somente**
quando o turno ativo é de tela (evento `routing` com rótulo novo `TELA`). Fora desse caso, nada muda.

## 7. Critérios de aceite (falham objetivamente)

| Id | Critério |
|---|---|
| HV.1 | Pergunta que cita a tela + compartilhamento → resposta falada sobre o quadro (motor falso), e 1 execução real com imagem fixa |
| HV.2 | **Matriz de egresso** (Gemini falso em loopback, todos os corpos: geração, intenção, visão, TTS): mestre × `CLOUD_VISION` × autorização afirmativa/negada/ausente × cancelado/falha. Marcador plantado na imagem e na pergunta: imagem só aparece no corpo de visão quando autorizado; pergunta/resposta de tela aparecem **somente** no corpo de TTS daquele turno; nunca em geração/intenção posteriores (20 turnos alternados) |
| HV.3 | `captureId`: POST sem pedido, duplicado, vencido, de turno cancelado, de outra sessão, concorrente → rejeitado **sem arquivo no disco**; upload > 3 MiB, assinatura errada, dimensão > 1600 → rejeitado e apagado |
| HV.4 | Nenhum JPEG de turno sobra em disco após cada saída (resposta, falha, cancelamento, prazo, rejeição) |
| HV.5 | Turno cancelado com comando de visão ou geração ENFILEIRADO no worker → comando descartado, zero chamada externa (teste Python + teste de egresso) |
| HV.6 | Confirmação pendente + fala que cita a tela → caminho de confirmação, nenhuma visão, nenhuma mutação nova; "anota que a tela…" → mutação, não visão |
| HV.7 | Gramática de autorização: matriz de positivas/negações/citações |
| HV.8 | Barge-in durante visão local: worker livre (próximo STT começa) em ≤ 2,5 s p95 de 20 tentativas |
| HV.9 | Visão local aquecida: fim da fala → primeiro áudio ≤ 9 s mediana em 20 perguntas reais; carga do disco ≤ 30 s; pico de memória do worker com os 3 modelos registrado (alvo ≤ 9 GB) |
| HV.10 | Descarga por ociosidade observada (memória cai) sem novo comando |
| HV.11 | Logs sem marcador plantado (stdout/stderr do Node e do worker) |
| HV.12 | Setup limpo + operação offline (`HF_HUB_OFFLINE=1`) carrega o modelo de visão |
| HV.13 | Suíte verde, typecheck limpo; **prova de mutação** removendo cada barreira: filtro `screen` em `windowHistory`, consumo do `captureId`, negação na autorização, `cancelled_turns`, apagar no `finally` → o teste correspondente falha |
| HV.14 | **Usuário:** 10 perguntas sobre a própria tela; ele diz se ajudou |

## 8. Riscos restantes

- Texto da resposta sobre a tela vai ao TTS do Gemini — aceito pelo usuário (§0); o cartão de privacidade diz isso em linguagem simples.
- Prefill do VLM não interrompível — medido por HV.8.
- Memória com 3 modelos em 16 GB — medido por HV.9; descarga por ociosidade.

## 9. Achados da rodada 1 → resposta

| # | Resposta |
|---|---|
| 1 CRÍTICA (texto da tela pelo TTS) | Decisão do usuário "Voz do Gemini mesmo" torna essa saída aprovada e documentada (§0, §5.3); HV.2 limita a ela |
| 2 (consentimento vira permanente) | Todo turno de tela marcado, local ou Gemini; removido de todo envio posterior (§5.3) |
| 3 (proveniência tardia) | Proveniência decidida antes da 1ª gravação; origem guardada no item emitido até `markPlayed` (§3, §5.3) |
| 4 (negação autoriza) | Gramática afirmativa com negação vencendo (§3.2), HV.7 |
| 5 (continuação/ intenção/memória) | Sem continuação (decisão do usuário); turno de tela não passa por intenção nem memória (§3); fala ditada pelo próprio usuário depois é dele — fora de escopo, registrado |
| 6 (correlação do quadro) | `captureId` de uso único, consumo síncrono (§4), HV.3 |
| 7 (grava antes de autorizar) | Autentica e consome antes de gravar (§4) |
| 8 (tamanho PNG) | JPEG 0,8, 3 MiB, validação de assinatura/dimensão/pixels (§4) |
| 9 (limpeza) | `finally` em todas as saídas, posse definida (§5.4), HV.4 |
| 10 (fila não cancelável) | `cancelled_turns` no worker, também para `generate` (§5.1), HV.5 |
| 11 (cancelamento MLX-VLM) | `stream_generate` com checagem por token; prefill medido (HV.8) |
| 12 (sem interrupção em processando) | Botão de interromper em turno de tela (§6) |
| 13 (aviso antes de enviar) | Promessa removida; indicador pelo evento real `screen_sent` (§5.2) |
| 14 (provisionamento offline) | Setup com revisão fixada + HV.12 |
| 15 (logs) | Só contagens; HV.11 |
| 16 (continuação engole mutação) | Sem continuação; precedência da confirmação e de "anota/lembra" (§3, §3.1), HV.6 |
| 17 (critérios fracos) | Critérios com teto e matriz (§7) |

## 10. Ajustes da rodada 2 (prevalecem sobre o texto acima)

1. **§3.2 — citação não autoriza.** A autorização só vale se a marca estiver em posição de comando: no início da fala ("com o
   Gemini, olha minha tela") ou no fim, separada por vírgula/conjunção ("olha minha tela com o Gemini", "…, manda pro Gemini"). É
   **descartada** se a fala começar por pergunta metalinguística (`o que (significa|quer dizer)`, `como assim`, `por que`) ou se a
   marca estiver entre aspas. Teste: "o que significa 'usa o gemini'?" → local.
2. **§3.1 — precedência de mutação.** Em vez da lista "anota/lembra/memoriza", o filtro de tela só é avaliado se
   `mightBeMutation(transcript)` (`src/backend/tools/mutatingTools.ts:406`) for falso. "Cria um lembrete para comprar a tela nova",
   "salva uma nota sobre a tela quebrada", "guarda na memória que a tela deu problema" → caminho de mutação. HV.6 inclui as três.
3. **§6 — interrupção manual.** `interruptManually()` (`src/frontend/voice.ts:376`) passa a disparar o cancelamento também em
   `processando` quando o último `routing` recebido do turno ativo tem rótulo `TELA`; `main.ts` habilita o botão no mesmo caso.
4. **§5.4 — posse do JPEG.** O Node apaga o arquivo no seu `finally` sem esperar confirmação do worker (o cancelamento no Node
   nunca espera o worker, `mlxWorkerEngine.ts`). O worker trata `FileNotFoundError` ao abrir a imagem: se o turno está em
   `cancelled_turns`, encerra em silêncio; senão, devolve `kind: 'image_missing'` (frase fixa).
5. **§5.1/§6 — carga fria.** Na primeira pergunta de tela com o modelo descarregado, o servidor emite `state: 'aquecendo'` (a página
   mostra "Carregando a visão…", sem fala) e o comando `describe_screen` tem prazo próprio de 90 s (carga 60 s + inferência), em vez
   do `TURN_TIMEOUT_MS` de 60 s da geração, para não disparar o SIGKILL do worker numa carga legítima.
6. **HV.9 — teto rígido de memória:** pico do worker com os 3 modelos **≤ 9,5 GB**, asserção que falha o teste.

## 11. Fatias de implementação

1. Worker: `cancelled_turns` + descarte de comandos enfileirados de turno cancelado + checagem antes de chamada externa (corrige
   também o defeito pré-existente da geração). HV.5.
2. Proveniência `screen` + `windowHistory` + `emittedSentences.origin` + filtro `mightBeScreenQuery` + gramática de autorização (sem
   visão ainda: o turno de tela responde uma frase fixa). HV.2 (parte histórico), HV.6, HV.7.
3. Captura: botão, `screen_request`/`captureId`, rota com validação, limpeza. HV.3, HV.4.
4. Visão local no worker (+ setup, carga/descarga, cancelamento). HV.1, HV.8–HV.12.
5. Visão pelo Gemini por autorização + `RODRIGO_CLOUD_VISION` + cartão de privacidade. HV.2 completo, HV.13.
Cada fatia: testes com prova de mutação, suíte verde, commit. Auditoria de código (Hermes/Kimi) ao fim das fatias 2, 3 e 5.
