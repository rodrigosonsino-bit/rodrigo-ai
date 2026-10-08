# Fase 13a — Voz natural (TTS Gemini) — v2

Versão: v2 (corrige a rodada 1 de auditoria sobre `docs/phase-13a-v1.md`)
Data: 2026-10-07
Status: **Nada implementado. Plano ainda não reauditado.** Este arquivo **substitui** o v1 em §3 (privacidade/canal), §4.2 (implementação), §5 (riscos) e §6 (critérios). O levantamento do v1 (§1, §2, §2A, §2B) continua válido, com as correções do §0C abaixo.

## 0. Rastreabilidade da rodada 1

| Campo | Valor |
|---|---|
| Auditor | `agy` 1.3.1 (CLI `agy -p ... --mode plan --effort high --dangerously-skip-permissions --print-timeout 40m`) |
| Modelo | **padrão do `agy`, não capturado** (`model=""` no `cli.log`; `settings.json` não o declara). O `agy` também foi auditor das rodadas 1 e 3 da Fase 12: para esta fase é rodada 1, mas **não é um auditor sem histórico com o projeto** |
| Entrada | cópia do repositório sem `.env`, `.env.*`, `docs/research/`, `.runtime/`, `node_modules/`, `.git/`; a chave real do `.env` aparece 0 vezes na cópia |
| Saída | 219 linhas / 37 KB, 21 achados, veredito **REJEITADO**; sem assinatura de falha conhecida (sem timeout, sem delegação ociosa, sem erro de cota) |
| Arquivos | `docs/audits/f13a/plan-r1-agy.md` (relatório) e `plan-r1-agy-prompt.txt` (prompt) |
| Material pessoal | **nenhum auditor viu `docs/research/` ou `.env`** |

## 0A. Disposição dos 21 achados (cada um conferido no código real antes de aceitar)

| # | Achado (gravidade do auditor) | Disposição |
|---|---|---|
| 1 | Plano afirma "contrato não muda" e "coalescência muda o contrato" (CRÍTICA) | **Aceito** (autocontradição minha: v1 linhas 73 e 80). Resolvido em §4.3 |
| 2 | `work_loop` do worker é mono-thread, fila de tamanho 1; `synthesize` esperaria a geração inteira (CRÍTICA) | **Aceito e verificado** (`worker.py:599` `Queue(maxsize=1)`, `:1112-1134` laço único, `:1158-1163` `queue.Full` descarta o mais antigo; controle positivo: `generate` 19 ocorrências, `synthesize` 0). Seria **bloqueante**: a 1ª frase só sairia depois da geração toda. Resolvido em §4.2 |
| 3 | Prazo de 8 s por frase viola o piso de 10 s do Google (CRÍTICA) | **Aceito** (`worker.py:448-450`: "o MÍNIMO ACEITO É 10 s… Nunca < 10_000"). Resolvido em §4.2 |
| 4 | Cancelamento do worker é unário (`_current`) (ALTA) | **Aceito e verificado** (`worker.py:599-601`, `:642-648`). Resolvido em §4.2 |
| 5 | Falta especificar o contêiner WAV (MÉDIA) | **Aceito**, §4.2 |
| 6 | Coalescência apaga do histórico frases já ouvidas no barge-in (ALTA) | **Aceito**: o custo está declarado e agora quantificado (§4.3) |
| 7 | Falta máquina de estados da coalescência (flush, índices) (ALTA) | **Aceito**, §4.3 |
| 8 | Pergunta de confirmação coalescida quebra `markPlayed` (ALTA) | **Aceito e verificado** (`sessionManager.ts:775-779`, igualdade exata `armedMutation.question === text`). Invariante em §4.3 |
| 9 | "Não é categoria nova de dado" é falso (CRÍTICA) | **Aceito e verificado** (`sessionManager.ts` `windowHistory`: com `RODRIGO_SEND_HISTORY=0` só a fala do usuário vai à geração). Reescrito em §3 |
| 10 | Saídas de ferramentas ditam conteúdo do usuário à nuvem (ALTA) | **Aceito**, decisão do usuário pedida (§3, D-b) |
| 11 | Teste `privacyConsistency` exige "nível gratuito" nos documentos (MÉDIA) | **Aceito e verificado** (`privacyConsistency.test.ts:48-55`). Agravante que o auditor não viu: o projeto da chave está agora no Nível 1 **com faturamento**, então a divulgação do nível gratuito pode estar desatualizada para toda a conta. Resolvido em §3 |
| 12 | Troca de voz no meio da mesma resposta (ALTA) | **Aceito**: reserva por turno (§4.4) |
| 13 | Contador diário: corrida, crash, fuso (ALTA) | **Aceito**, §4.4 |
| 14 | Plano não define a assinatura do 429 diário (ALTA) | **Aceito**: só tenho a assinatura do 429 por minuto (`GenerateRequestsPerMinutePerProjectPerModel`). §4.4 e teste deliberado em §6 |
| 15 | H13a.6 é impossível com 100 RPD (CRÍTICA) | **Aceito** (contradição entre meu critério e a decisão do usuário "nível 1"). Reescrito em §6 |
| 16 | H13a.1 é circular e cita o modelo errado (ALTA) | **Aceito**: o gate dizia `gemini-3.1-flash-tts` em vez do modelo adotado. Reescrito em §6 |
| 17 | H13a.3/4 consomem a cota diária (ALTA) | **Aceito**: bateria de 100 contra o Gemini falso; ao vivo só 20 frases (§6) |
| 18 | H13a.5 sem limiar (MÉDIA) | **Aceito**: substituído por normalização de volume mais critério numérico (§4.2, §6), com dado medido (§0B) |
| 19 | Troca para o Flash-Lite sem o usuário ter ouvido (ALTA) | **Aceito**: gate 0 (§7). **E há fato novo e pior, §0B** |
| 20 | Plano quebra `f12Egress.test.ts` (ALTA) | **PARCIALMENTE REFUTADO**: o teste injeta `FakeTts implements IVoiceProvider` (`helpers/egress.ts:203`), então um provedor Gemini novo não chama o Gemini falso e a contagem `genRequests + intentRequests` (`f12Egress.test.ts:93-95`) não muda. Falta, sim, um teste novo com o provedor real (§6, H13a.7), e o Gemini falso precisa contar requisições de TTS à parte |
| 21 | Cota de TTS e de geração competem (MÉDIA) | **PARCIALMENTE REFUTADO**: as cotas são **por modelo** (o erro diz `generate_requests_per_model`, `model: gemini-3.8-flash-lite-tts`; o painel lista cada modelo com a sua). Geração e TTS usam modelos diferentes e não competem por RPM/RPD. O que é compartilhado é o teto de gasto mensal do projeto. A linha de risco do v1 §5 estava errada e é corrigida |

## 0B. Fatos novos descobertos durante esta rodada

1. **A primeira audição às cegas continha o `say` Felipe mudo.** Os 5 arquivos `A_say_felipe_*.wav` saíram vazios (4 096 bytes, 0 s de áudio) porque o `say` rodou dentro do sandbox, que o impede de gerar áudio. A comparação em que o usuário escolheu o Charon tinha uma das cinco opções em silêncio: **ele nunca ouviu a voz atual ao lado das outras**. Os arquivos foram regenerados fora do sandbox e a página `.runtime/audicao-tts/` foi corrigida. Não invalida a preferência por um modelo humano, mas o usuário deve saber, e o §7 (gate 0) o convida a reouvir.
2. **Volume (RMS em dBFS) das amostras de 2026-10-07, 5 frases diferentes:** `say` Felipe −17,0 a −17,5 (dispersão **0,8 dB**); Gemini 3.8 Flash-Lite −16,3 a −20,8 (**4,5 dB**); Gemini 3.1 Charon −17,2 a −25,4 (**8,2 dB**). A voz de fallback é bem mais constante que a do Gemini; sem tratamento, cada queda para o `say` e cada frase mais baixa do Gemini seria audível como salto de volume.

## 0C. Correções ao levantamento do v1

- v1 §5, linha "Chave do projeto compartilhada com a geração": **removida** (achado 21).
- v1 §6, H13a.1 e o gate do §3 citavam `gemini-3.1-flash-tts`: o modelo adotado é `gemini-3.8-flash-lite-tts` (variável `RODRIGO_TTS_MODEL`).

## 3. Canal, privacidade e termos (substitui o v1 §4.1)

- Flag `RODRIGO_CLOUD_TTS` em `privacy.ts`, estrita ("0"/"1"), só vale com o mestre `RODRIGO_CLOUD=1`. Padrão proposto: `1`.
- **Premissa corrigida (achado 9):** o texto falado **não** é sempre um dado que já saía. (a) Com `RODRIGO_SEND_HISTORY=0` nenhuma fala do assistente saía da máquina (`windowHistory`); (b) frases cortadas por barge-in nunca entram no histórico, mas seriam enviadas ao TTS antes de serem ouvidas; (c) saídas de ferramentas locais (hora, data, confirmações) só saíam via histórico. **Regra nova:** `RODRIGO_CLOUD_TTS` fica **efetivamente desligado** quando `RODRIGO_SEND_HISTORY=0` (quem escolheu isso declarou que fala do assistente não sai), e o cartão mostra o motivo. Os casos (b) e (c) com a flag ligada são uma expansão real da fronteira de dados, declarada no cartão, no README e no modelo de ameaça da Fase 12.
- **D-b (decisão do usuário, ainda aberta):** confirmações que repetem conteúdo ditado (prévia de lembrete/nota/memória, `mutatingTools.ts`) vão à nuvem? Recomendação: **sim por padrão** (uma voz só), **local (`say`) quando `RODRIGO_SEND_MEMORIES=0`**, porque quem desligou memórias na nuvem não espera que seu conteúdo saia por outro canal. A troca de voz nesse caso é declarada.
- **Termos do Google (achado 11 + fato novo):** o projeto está no Nível 1 com faturamento; o README, o cartão e `CLAUDE.md` dizem que o nível gratuito permite ao Google usar e revisar o conteúdo, o que pode não valer mais para esta chave. A implementação **relê os termos** (`ai.google.dev/gemini-api/terms`) e corrige os quatro lugares para o estado real. O teste `privacyConsistency.test.ts` troca a asserção "deve divulgar o nível gratuito" por uma asserção de **divulgação do regime de termos em vigor da chave** (qualquer que seja, gratuito ou pago), mantendo a proibição de promessas de localidade e de ausência de custo.

## 4. Desenho (substitui o v1 §4.2)

### 4.1 Modelo e voz
`gemini-3.8-flash-lite-tts` (`RODRIGO_TTS_MODEL`), voz `Charon` (`RODRIGO_TTS_VOICE`), **só o texto da frase, sem prefixo de estilo** (v1 §4.2 vale). Fixado por nome.

### 4.2 Worker (achados 2, 3, 4, 5, 18)
- **`synthesize` não passa por `work_loop` nem por `work_queue`.** O leitor de stdin o despacha a um `ThreadPoolExecutor(max_workers=2)` dentro do worker, com o limite de 2 sínteses simultâneas imposto ali. A geração, a classificação e a transcrição seguem como estão.
- **Cancelamento por pedido:** cada `synthesize` traz `reqId` e `turnId`; o worker guarda `_syntheses[reqId] = {cancel_event, handle}` sob lock próprio, distinto de `_current`. Novos comandos: `cancel_synth {reqId}` e o cancelamento de turno existente passa a cancelar também todas as sínteses do `turnId`. `handle_cancel` atual **não muda** para `generate`.
- **Prazo (achado 3):** o cliente HTTP do TTS é criado por `build_gemini_client` com **`timeout_ms >= 10_000`** (piso do Google). O prazo de 8 s por frase é **imposto localmente**: um temporizador seta o `cancel_event` e fecha o fluxo, e o resultado é tratado como timeout (cai no `say`). Nunca um prazo abaixo de 10 000 ms vai ao Google.
- **Contêiner WAV:** o worker acumula o PCM (24 kHz, mono, 16 bits) e grava com o módulo `wave` num arquivo `outputPath + ".part"`, renomeando com `os.replace` ao terminar; cancelamento ou erro apaga o `.part`. O WAV segue o que `decodeAudioData` espera (`voice.ts`).
- **Normalização de volume (achado 18):** antes de gravar, o worker ajusta o ganho para RMS-alvo de **−17,0 dBFS** (média dos `say`), limitando o ganho a ±6 dB e a pico de −1 dBFS, para que Gemini e fallback tenham volume parecido e frases do mesmo turno não variem.
- `redact()` e `safe_exc` em todo log; o texto da frase nunca é registrado; redirecionamentos não seguidos (cliente de `build_gemini_client`).

### 4.3 Coalescência no Node (achados 1, 6, 7, 8)
- **O contrato do provedor não muda** (`synthesize(text, outputPath, signal)` produz um arquivo por pedido), mas **`sessionManager.ts` muda**: a coalescência vive nele e a v1 estava errada em dizer que ele "fica como está".
- **Invariantes (inegociáveis):** pergunta de mutação (`armedMutation.question`), reprompt (`MUTATION_REPROMPT_TEXT`), saídas de ferramentas, `GENERATION_DISABLED_TEXT` e a **frase de índice 0 de cada turno nunca são coalescidas**; cada uma vai sozinha e com o texto idêntico ao que `markPlayed` espera (`session.armedMutation.question === text` e `emittedSentences.items.find(e.text === text)` continuam valendo sem alteração).
- **Máquina de estados:** buffer só para frases de índice ≥ 1 de uma geração. Descarrega quando: (a) somaria mais de 300 caracteres, (b) já tem 3 frases, (c) a geração terminou (`done` descarrega o resíduo imediatamente), (d) o turno é cancelado (**descarta**, sem sintetizar). `sentenceIndex` emitido ao cliente é **monotônico por item emitido**, não por frase de origem.
- **Custo declarado (achado 6):** uma interrupção dentro de um grupo faz o grupo inteiro (até 3 frases / 300 caracteres) não entrar no histórico, ainda que parte tenha sido ouvida. É conservador quanto a falso histórico, mas o modelo pode repetir o que o usuário já ouviu. Quantificar em H13a.11 (§6).

### 4.4 Orçamento, reserva e disjuntor (achados 12, 13, 14)
- **Reserva por turno:** antes de sintetizar a primeira frase de uma resposta, o limitador exige saldo para **pelo menos 2 pedidos** (minuto e dia). Sem saldo, **o turno inteiro fica no `say`** (não troca de voz no meio da resposta). Se o saldo acabar depois de o turno começar no Gemini, o resto do turno cai no `say` (disjuntor) e isso é contado em H13a.6.
- **Minuto:** janela deslizante de 8 pedidos/min (`RODRIGO_TTS_RPM`).
- **Dia:** contador em `.runtime/tts-budget.json`, escrito de forma atômica (`.tmp` + `rename`), com o **dia indexado pelo fuso `America/Los_Angeles`** (o horário de virada da cota do Google **não foi verificado** por mim; é a suposição documentada pelo Google que a implementação deve conferir na documentação ou observar). Falha ao ler ou escrever o arquivo = **orçamento do dia tratado como esgotado** (cai no `say`), nunca "ilimitado". Padrão `RODRIGO_TTS_RPD=90`.
- **Assinatura do 429:** o worker lê `error.details[].violations[].quotaId`. `quotaId` contendo `PerMinute` → bloqueia o Gemini pelo `retryDelay` informado (+1 s). `quotaId` contendo `PerDay` → bloqueia até a virada do dia (fuso acima). `quotaId` **desconhecido ou ausente → trata como por minuto, bloqueio máximo de 60 s, e registra a ocorrência** (nunca desliga o TTS pelo dia por uma suposição). Só a assinatura por minuto está observada hoje (§2A do v1); a diária é capturada deliberadamente em §6, H13a.12.

## 5. Riscos (substitui o v1 §5)

| Risco | Tratamento |
|---|---|
| Worker bloqueado pela geração | `synthesize` fora do `work_loop` (§4.2), com teste de que a 1ª frase sai **durante** uma geração em andamento (H13a.13) |
| Prazo < 10 s rejeitado pelo Google (400 sem fallback) | HTTP ≥ 10 s, prazo de 8 s local (§4.2) |
| Modelo *preview*/versão some | modelo fixado, variável de troca, `say` de fallback |
| Voz Flash-Lite menos humana que a do 3.1 | gate 0 (§7) e H13a.10 |
| Troca de voz no meio da resposta | reserva por turno (§4.4) |
| Volume desigual entre frases e vs. `say` | normalização (§4.2), H13a.5 |
| Custo | ~US$ 0,009/min até 31/12/2026 e ~US$ 0,018/min depois (preço oficial lido em 2026-10-07), limitado a 90 pedidos/dia |
| Cota diária acabar antes do fim do dia | `say` assume, cartão avisa (v1 §4.2) |
| Conteúdo ditado vai à nuvem | D-b (§3) |

## 6. Critérios de aceite (substituem o v1 §6)

- **H13a.1 (reescrito)** — contra o Gemini falso em loopback (sem gastar cota): 100 turnos simulados de 2 a 8 frases. **Zero 429 do Google** e **pelo menos 75% das frases sintetizadas pelo "Gemini"** (piso que impede o teste de passar com o limitador desligando tudo).
- **H13a.2** — `RODRIGO_CLOUD=0`, `RODRIGO_CLOUD_TTS=0` ou `RODRIGO_SEND_HISTORY=0`: zero conexão de saída para TTS (medida como em `f12Offline.test.ts`, 50 sínteses).
- **H13a.3 (reescrito)** — latência do início da síntese até `sentence_audio_ready`: **100 frases contra o Gemini falso com latência injetada** (valida o código) mais **20 frases reais** (valida a nuvem); mediana ≤ 3,0 s e p95 ≤ 6,0 s nas reais (propostas; baseadas nas amostras de 2026-10-07, mediana 1,75–2,16 s e máximo 6,87 s para o Flash-Lite).
- **H13a.4 (reescrito)** — 0 de 20 frases reais com texto estranho ao da frase na transcrição do Whisper local; o prefixo não é enviado, o teste protege contra mudança do modelo.
- **H13a.5 (reescrito, com dado)** — depois da normalização, o RMS de **todas** as frases (100 falsas e 20 reais) fica a ≤ **1,5 dB** de −17,0 dBFS. Referência medida: sem normalização, dispersão de 4,5 dB no Flash-Lite e 8,2 dB no 3.1 (§0B).
- **H13a.6 (reescrito)** — separa as causas. Em uma sessão de **até 30 turnos reais a partir de uma cota limpa**: quedas para o `say` por **erro** (429, 5xx, timeout) ≤ 5% das frases; quedas por **esgotamento do orçamento** reportadas à parte (não reprovam, mas são mostradas).
- **H13a.7** — egresso medido contra um Gemini falso em loopback, num teste novo `f13EgressTts.test.ts` com o provedor real e o worker real, que **conta pedidos de TTS à parte** dos de geração/intenção: só o texto das frases sai, zero byte de áudio do usuário. Os testes da Fase 12 seguem com `FakeTts` (achado 20).
- **H13a.8** — fallback com falha injetada: 429, 503, timeout, 404 caem no `say`; 400/401/403 **não** caem (aparecem como erro de configuração).
- **H13a.9** — `privacyConsistency.test.ts` verde com a asserção nova de divulgação de termos.
- **H13a.10 — voz (só o usuário mede):** uma sessão real; o usuário diz se a voz deixou de soar robotizada.
- **H13a.11** — barge-in dentro de um grupo coalescido: medir em 20 interrupções simuladas quantas frases ouvidas deixaram de entrar no histórico (custo do §4.3) e reportar.
- **H13a.12** — captura deliberada da assinatura do 429 diário: uma execução supervisionada que esgota a cota do dia com frases mínimas ("Oi.") e guarda o corpo do erro (custo estimado de centavos). Sem isso, o ramo `PerDay` do §4.4 é hipótese.
- **H13a.13** — com uma geração de 5 s em andamento no worker real (fake Gemini), uma síntese solicitada para a frase 0 conclui em < 3 s, ou seja, não espera a geração terminar.

## 7. Gates antes de qualquer código

0. **Gate 0 (usuário):** ouvir `.runtime/audicao-tts-baratos/index.html` (e, se quiser, `.runtime/audicao-tts/index.html`, já com o Felipe corrigido) e confirmar que o Flash-Lite sem instrução de tom serve. Se não servir, o plano troca o modelo (3.8 Flash ou 3.1) por variável, e o §6 é recalculado.
1. D-b respondida (§3).
2. Rodada 2 de auditoria **com outro modelo** (rotação): Codex ou Kimi K3 (NVIDIA NIM) para o plano; **Hermes para o código** depois de implementado, executando de fato a suíte e tentando quebrar `synthesize` fora do `work_loop`.
3. Verificar na realidade depois: sessão real com o usuário; aprovação para implementar não é "pronto".

## 8. Fora do escopo
Streaming do PCM ao cliente (F13b); Gemini Live; clonagem de voz; Qwen3-TTS e Chatterbox como motores; subir para o Nível 2 (decisão do usuário: "nivel 1").
