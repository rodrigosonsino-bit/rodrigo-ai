# TAREFA
Você é um AUDITOR ADVERSARIAL de PLANO, em segunda rodada e com um modelo diferente do da primeira. Procure o que está errado; não confirme por cortesia. Os 21 achados da rodada 1 constam na tabela §0A do plano; NÃO assuma que as disposições do autor (aceito/refutado) estão corretas, e não repita achado só porque está na tabela: procure o que a rodada 1 não viu e onde a v2 introduziu defeito novo. Você não vê o repositório; quando uma conclusão depender de código que não aparece no CONTEXTO, diga isso em vez de supor.

Ataque especialmente:
1. §4.2: `synthesize` em ThreadPoolExecutor(2) dentro de um worker cujo laço principal faz inferência MLX e geração em streaming. Corridas, cancelamento por reqId versus cancelamento por turnId, vazamento de threads, `.part` órfão, o que acontece se o stdin fechar com sínteses em curso, o limite de 2 sínteses valer por processo mas a coalescência produzir mais pedidos que isso.
2. §4.3: coalescência e as invariantes. Existe algum caminho em que um grupo contenha texto que o `markPlayed` espera isolado? A regra "frase de índice 0 nunca é coalescida" cobre todos os casos em que a pergunta de mutação é emitida (inclusive quando ela não é de índice 0)? O custo no barge-in está bem quantificado?
3. §4.4: reserva de 2 pedidos por turno, janela deslizante, contador diário no fuso America/Los_Angeles, política "falha ao ler o arquivo = orçamento esgotado", tratamento do quotaId do 429. Cenários de deadlock, de desperdício de cota (pedidos cancelados mas já cobrados), de duas instâncias do app, de relógio do sistema mudando.
4. §3: a regra "RODRIGO_CLOUD_TTS fica efetivamente desligado quando RODRIGO_SEND_HISTORY=0" e a decisão D-b. Há vazamento de dado que a Fase 12 declara que nunca sai? A regra confunde o usuário (config que parece ligada mas não está)?
5. §4.2 normalização para RMS-alvo de −17 dBFS com limite de ±6 dB e pico de −1 dBFS: pode distorcer, amplificar ruído de silêncio ou falhar em frases curtas?
6. §6: quais critérios H13a.x são vácuos, circulares ou inalcançáveis; algum teste passaria com o defeito presente? A reserva de cota entre os testes e o uso real do dia está resolvida?
7. Omissões: o que o plano precisa dizer e não diz (timeouts, ordem de reprodução quando um grupo falha e o seguinte conclui, mistura de vozes, falha do `say` de fallback, custo de pedidos descartados).

Para cada achado use exatamente: ACHADO (uma frase) / EVIDÊNCIA (trecho citado do plano ou do contexto) / GRAVIDADE (CRÍTICA, ALTA, MÉDIA, BAIXA) / CONFIANÇA (0 a 100%) / AÇÃO RECOMENDADA. Números que você citar de memória (preços, limites) marque como "de memória". Termine com VEREDITO (REJEITADO, APROVADO COM RESSALVAS ou APROVADO) e uma lista curta do que você não conseguiu verificar. Escreva a resposta completa; não resuma achados em uma linha só.

## CONTEXTO DO CÓDIGO (trechos reais; você não vê o repositório)
- Projeto: assistente de voz local, Node (backend) + worker Python (MLX) falando NDJSON por stdio. Geração de texto já usa Gemini (cloud); o TTS atual é o `say` do macOS (local), um arquivo WAV por frase. Fase 12 (privacidade): cada canal de saída para o Gemini tem flag estrita; `RODRIGO_SEND_HISTORY=0` faz só a fala do usuário atual ir à geração (função windowHistory devolve `[history[history.length-1]]`); áudio do usuário nunca sai.
- worker.py: `Worker.work_queue = queue.Queue(maxsize=1)`; thread principal `work_loop` consome UM comando por vez (transcribe/classify/generate/detect_*), thread leitora de stdin enfileira com `put_nowait` e, se cheio, DESCARTA o mais antigo; `_current: Optional[GenerationHandle]` único, protegido por `_current_lock`; `handle_cancel` acha o handle pelo turnId. Comentário no código: o prazo HTTP vai ao Google como deadline e o mínimo aceito é 10 s (abaixo dá 400 INVALID_ARGUMENT). `build_gemini_client` é o único ponto de criação de cliente (redirect desligado).
- sessionManager.ts: `synthesizeSentence(session, turn, text, index)` chama `ttsProvider.synthesize(text, filePath, signal)` e emite `sentence_audio_ready`; o cliente toca o arquivo e só depois de reproduzir até o fim faz POST /played; `markPlayed` exige que o texto bata EXATAMENTE com uma frase emitida e não consumida, e só então coloca no histórico; a pergunta de confirmação de mutação só arma `pendingMutation` se `armedMutation.question === text` (igualdade exata). Mutação nunca executa sem a pergunta ter sido reproduzida e a resposta passar por um classificador determinístico (zero falso "sim" é propriedade protegida).
- Interface: `IVoiceProvider { synthesize(text: string, outputPath: string, signal?: AbortSignal): Promise<void> }` grava um WAV.
- Testes existentes injetam `FakeTts implements IVoiceProvider` e um Gemini falso em loopback que conta requisições de geração e de intenção.
- Medições do autor (você não pode reproduzi-las; trate-as como alegações): Gemini TTS `gemini-3.8-flash-lite-tts`, 25,0 tokens de áudio/s; 1º trecho de áudio ~0,8 s; frase inteira mediana ~2 s, máximo ~7 s; cota do projeto (Nível 1): 10 requisições/min e 100/dia por modelo (erro 429 `GenerateRequestsPerMinutePerProjectPerModel`, quotaValue 10); preço US$ 6/M tokens de áudio até 31/12/2026, US$ 12 depois.

----- PLANO -----
# Fase 13a (v2, trecho de desenho) — voz natural com TTS Gemini no Rodrigo AI
Contexto: a rodada 1 de auditoria (outro modelo) rejeitou a v1 com 21 achados, todos incorporados nesta v2: (i) synthesize fora do laço único do worker; (ii) HTTP do TTS >= 10 s com prazo local de 8 s; (iii) cancelamento por pedido; (iv) pergunta de mutação nunca coalescida; (v) TTS em nuvem desligado quando RODRIGO_SEND_HISTORY=0; (vi) critérios H13a reescritos para caber na cota de 100 pedidos/dia do Nível 1; (vii) normalização de volume (medido: dispersão de RMS entre frases de 0,8 dB no say, 4,5 dB no Flash-Lite, 8,2 dB no 3.1). Não repita esses pontos; procure o que a rodada 1 não viu e os defeitos que a v2 introduziu.

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
