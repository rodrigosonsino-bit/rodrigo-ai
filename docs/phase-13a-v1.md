# Fase 13a — Voz natural (TTS Gemini) — v1

Versão: v1 (rascunho para auditoria de plano)
Data: 2026-10-07
Status: **Nada implementado. Plano não auditado.** Parte da F13 "Conversa natural" (`docs/handoff-2026-10-06.md`: "voz menos robótica"). As outras partes da F13 (latência dos detectores, interrupção, continuidade) ficam fora deste documento.
Decisões do usuário nesta conversa (2026-10-07), citadas literalmente: "Gemini TTS, voz Charon"; "Ativa a cobrança e escreve o plano" (a cobrança foi ativada pelo usuário: painel mostra Nível 1 no projeto Rodrigo-AI); "pode pegar a mais barata das 4" (modelo `gemini-3.8-flash-lite-tts`, §4.2); **"nivel 1"** (resposta à escolha entre ficar no Nível 1 e chegar ao Nível 2 pagando US$ 100 + 3 dias: **fica no Nível 1**, com 10 RPM / 100 RPD por modelo; consequência: o orçamento diário é o desenho central e o `say` assume o resto do dia, §4.2).

## 1. Problema

A voz atual (`say` Felipe Enhanced) soa robotizada e sem expressão. O usuário pediu alternativas e ouviu um teste às cegas (`.runtime/audicao-tts/index.html`, gitignorado, 5 frases × 5 sistemas). Escolheu o **Gemini TTS, voz Charon**.

## 2. Fatos medidos nesta sessão (2026-10-07)

Medições em `$TMPDIR` desta sessão, modelo `gemini-3.1-flash-tts-preview`, 24 kHz, mono, PCM 16 bits, frases de 3,4 a 12,4 s de áudio, prefixo de estilo em português.

| Fato | Medido |
|---|---|
| Tempo até o primeiro trecho de áudio (streaming) | 0,75–1,0 s em 11 de 15 amostras; 3,96 s e 4,25 s em duas (sob intervalo de 22 s, após rajada que estourou a cota) |
| Tempo total para gerar a frase | 1,76 s (frase de 3,5 s de áudio) a 4,46 s (12,4 s de áudio); 7,0 e 8,6 s nas duas amostras lentas |
| Cota gratuita | **8 de 10 chamadas em rajada deram 429 `RESOURCE_EXHAUSTED`**; com 22 s de intervalo, 0 de 10 deram erro |
| Concorrência atual do app | `sessionManager.ts` empilha uma síntese por frase em `turn.pendingSynthesis` sem limite: várias chamadas simultâneas |
| Modelos locais testados | Qwen3-TTS VoiceDesign (carga ~173 s, geração 1–1,5× a duração do áudio) e Chatterbox multilingual (5–11 s por frase, exige voz de referência). Rejeitados por latência; qualidade só o usuário julgou na audição |

Não medido, e que o plano precisa medir antes de aceitar: consistência de volume/prosódia entre frases sintetizadas separadamente; se o prefixo de estilo é pronunciado em voz alta.

### 2B. Gemini 3.8 Flash-Lite TTS (modelo escolhido; medido 2026-10-07)

Mesma cota do 3.1 no Nível 1: **10 RPM, 10 K TPM, 100 RPD** (painel). Rajada de 40 chamadas, concorrência 2: **5 passaram, 35 deram 429** (`generate_requests_per_model`, `limit: 10`, `model: gemini-3.8-flash-lite-tts`, `retryDelay 21 s`); uma rajada anterior de 15 chamadas, no mesmo modelo, passou inteira (a janela de 1 minuto não estava cheia). Latência das que passaram: 1º trecho de áudio mediana 0,77–0,84 s; total mediana 1,75–2,16 s, máximo 6,87 s. Sem prefixo de estilo o áudio sai do tamanho do texto (o prefixo, quando presente, dobrava ou triplicava a duração e o custo). Sem prefixo, a frase curta deu 3,0 s de áudio, a explicação longa 12,8 s (o 3.8 Flash comum deu 10,2 s nessa mesma frase; 3.1 Charon: 12,4 s; falar mais devagar custa mais por frase).

### 2A. Teste de rajada com a conta já vinculada ao faturamento (2026-10-07, mais tarde) — **H13a.1 FALHOU**

Captura de tela do usuário: projeto "Rodrigo-AI", uma chave, "My Billing Account 1", "Nível 1 · Pré-pagamento". Duas rajadas de 30 chamadas, concorrência 2, frases de 3–12 s, modelo `gemini-3.1-flash-tts-preview`:

| Rodada | Passaram | 429 |
|---|---|---|
| 1 | 12 | 18 |
| 2 | 11 | 19 |

Corpo completo do erro (rodada 2): `quotaMetric generate_requests_per_model`, `quotaId GenerateRequestsPerMinutePerProjectPerModel`, `quotaValue 10`, `model gemini-3.1-flash-tts`, `retryDelay 11s`. **O limite é 10 requisições por minuto por projeto e por modelo.** Na rodada 1 a cota gratuita (sem faturamento) também travou depois de ~10 chamadas seguidas; **não há evidência de que o Nível 1 tenha mudado esse número**. Não sei se o faturamento já está efetivo no projeto da chave ou se o Nível 1 simplesmente mantém 10 RPM para esse modelo. A documentação de limites do Google (`ai.google.dev/gemini-api/docs/rate-limits`, lida em 2026-10-07) não lista RPM/TPM de nenhum modelo TTS; só diz que o Nível 2 exige US$ 100 pagos + 3 dias desde o primeiro pagamento, e que o painel do AI Studio mostra o valor real.

Medido nas mesmas rodadas (23 chamadas bem-sucedidas, 156,4 s de áudio): **25,0 tokens de áudio por segundo** (era estimativa; agora é medida), 3 910 tokens de saída e 1 066 de entrada → ~US$ 0,08 no total, ou ~US$ 0,03 por minuto de fala. Latência das chamadas que passaram: 1º trecho mediana 0,70–0,74 s, p95 ≤ 0,97 s; total mediana 2,84–2,95 s, p95 ≤ 4,51 s.

**Painel do AI Studio, lido por mim em 2026-10-07** (projeto Rodrigo-AI, `gen-lang-client-0858052256`, "Nível 1"; os números "pico/limite" são dos últimos 28 dias):

| Modelo TTS | RPM | TPM (entrada) | **RPD (requisições por dia)** |
|---|---|---|---|
| Gemini 3.1 Flash TTS, Nível 1 (atual) | pico 17 / **limite 10** | 897 / 10 K | pico 47 / **limite 100** |
| Mesmo modelo, Nível 2 (visão "Comparar") | 1 000 | 100 K | 10 000 |
| Gemini 2.5 Flash TTS e Gemini 3.8 Flash TTS, Nível 1 | 10 | 10 K | 100 (cada modelo tem a própria cota; 0 uso) |

Conclusões: (1) o faturamento **está efetivo** (o painel mostra Nível 1); a rajada não falhou por falta de cobrança, falhou porque o **Nível 1 mantém 10 RPM e 100 requisições por dia** para os modelos TTS. (2) **O limite diário (100) pesa mais que o por minuto:** meus testes de hoje já gastaram 47. Com coalescência de 2–3 requisições por resposta, 100 por dia dão ~35–50 respostas faladas por dia, e o app voltaria ao `say` no resto do dia. (3) O Nível 2 resolveria (1 000 / 100 K / 10 000), mas a documentação lida diz "pago US$ 100 + 3 dias desde o primeiro pagamento"; **não verifiquei** se uma compra de créditos pré-pagos conta para esse limiar, nem a data em que o usuário fez o primeiro pagamento. Esse é um gasto do usuário; o plano não o presume.

Consequência para o desenho: uma síntese por frase gasta uma requisição por frase. Uma resposta de 6 frases consome 60% do orçamento de um minuto. Isso torna insustentável o desenho original do §4.2 a 10 RPM, **mesmo com cobrança ativa**.

## 3. Pré-requisito do usuário (não é feito por mim)

Ativar cobrança (Cloud Billing) no projeto Google da `GEMINI_API_KEY`. Eu não ativo cobrança nem manipulo dados de pagamento. A implementação só começa depois de o teste de rajada do §6 (H13a.1) provar que o 429 sumiu; não vale a palavra de ninguém de que a cobrança está ativa.

Custo estimado, **não medido**: o preço publicado é US$ 20 por milhão de tokens de áudio de saída e US$ 1 por milhão de entrada; a taxa de ~25 tokens de áudio por segundo é minha estimativa. Meia hora de fala por dia ficaria em torno de US$ 1. A F13a mede os tokens reais (`usage_metadata`) e substitui a estimativa.

## 4. Desenho

### 4.1 Canal e privacidade (padrão da Fase 12)
- Nova flag `RODRIGO_CLOUD_TTS` em `src/backend/privacy.ts`, estrita ("0"/"1", inválido aborta o startup), **só vale com o mestre `RODRIGO_CLOUD` ligado**. Padrão proposto: `1` (decisão do usuário de ativar a voz; confirmar na auditoria). `workerPrivacyEnv` a repassa ao worker.
- `effectivePrivacy` ganha `sends.ttsText` e `models.tts`; o cartão de privacidade, o README e `.env.example` listam o canal.
- **O que sai:** o texto de cada frase que o agente vai falar, nada mais. O áudio do usuário continua sem sair (`neverSends: ['audio']`).
- **Não é categoria nova de dado:** toda frase falada já entra no histórico depois de `markPlayed()` e vai à geração (padrão `RODRIGO_SEND_HISTORY=1`). Muda o canal, não o conteúdo. O plano registra isso e a auditoria deve contestar se for falso.
- Frases locais (hora, data, confirmações de lembrete/nota) também passam pela nuvem, para manter uma voz só. Alternativa descartada: voz diferente para respostas de ferramenta, por quebrar a consistência que o usuário quer.
- Termos: reverificar na implementação o que o Google diz do conteúdo no nível pago (em 2026-04-28 constava que o pago não usa o conteúdo para melhorar produtos). Sem cobrança ativa, o aviso do nível gratuito continua valendo. O texto do README e do cartão é corrigido para o estado real; o teste `privacyConsistency.test.ts` passa a proibir "gratuito"/"sem custo" enquanto o TTS em nuvem estiver ligado.

### 4.2 Implementação
- Novo comando `synthesize` no worker (`scripts/worker/worker.py`), usando `build_gemini_client` (único ponto de criação de cliente, redirect desligado). O worker grava o WAV direto em `outputPath`, validado dentro do diretório da sessão.
- `GeminiVoiceProvider implements IVoiceProvider` em `src/backend/voice/ttsProviders.ts`, chamando o worker. O contrato do arquivo por frase (`synthesize(text, outputPath, signal)`) **não muda**; `sessionManager.ts` fica como está, exceto o limite de concorrência abaixo.
- **Modelo (decisão do usuário, 2026-10-07: "pode pegar a mais barata das 4"): `gemini-3.8-flash-lite-tts`**, fixado por nome (nunca alias), configurável por `RODRIGO_TTS_MODEL`. Substitui o `gemini-3.1-flash-tts-preview` das seções 1–2 (que é o modelo que o usuário *ouviu e escolheu*). **A escolha do modelo mais barato foi dada sem registro de que o usuário tenha ouvido a 2ª audição** (`.runtime/audicao-tts-baratos/`); a qualidade do Flash-Lite não está confirmada, e o H13a.10 é quem decide. Se não soar humano, volta-se ao 3.8 Flash ou ao 3.1 por uma variável, sem mudar o código. Voz `Charon`, configurável por `RODRIGO_TTS_VOICE`.
- **Sem prefixo de estilo no texto (descoberta de 2026-10-07):** os modelos 3.8 lêem a instrução em voz alta (confirmado por transcrição com o Whisper local: "Fale em português do Brasil, de forma natural…" precede a frase) e **rejeitam `system_instruction`** (HTTP 400 "Developer instruction is not enabled for this model"). O worker envia **só o texto da frase**, sem instrução de tom; a expressividade fica por conta da voz e do modelo. Isso é uma perda real em relação ao 3.1, e o teste da 2ª audição já foi gerado nessas condições.
- **Preço:** US$ 6 por milhão de tokens de áudio de saída até 31/12/2026 e **US$ 12 a partir de 01/01/2027** (página oficial de preços, lida 2026-10-07), entrada US$ 0,50/1,00. Com 25,0 tokens/s (medido também neste modelo: 2 239 tokens / 89,6 s e 725 / 29,0 s) isso dá ~US$ 0,009/min até o fim do ano e ~US$ 0,018/min depois. A 20 min de fala por dia: ~US$ 5,4/mês agora, ~US$ 10,8/mês a partir de janeiro. O plano reconfere o preço na implementação.
- **Orçamento de requisições (substitui o "limite de concorrência de 2" do rascunho; motivo: §2A).** (a) Um limitador de janela deslizante de **8 requisições/minuto** (margem sobre as 10 medidas; configurável por `RODRIGO_TTS_RPM`), compartilhado por todo o processo. Sem orçamento, a frase cai no `say` na hora, sem esperar. (b) **Coalescência:** a primeira frase de cada resposta vai sozinha (menor tempo até a primeira fala); as frases seguintes do mesmo turno são agrupadas num único pedido, até ~300 caracteres por pedido. Meta: no máximo 2–3 requisições por resposta. Custo declarado: o grupo entra no histórico como uma unidade só, então uma interrupção no meio de um grupo descarta o grupo inteiro do histórico (conservador: o modelo nunca acredita ter dito algo que o usuário não ouviu). A ordem por `sentenceIndex` é preservada. (c) Concorrência máxima de 2 sínteses simultâneas.
- **Orçamento diário (§2A):** além do RPM, um contador diário persistido em `.runtime/` (`RODRIGO_TTS_RPD`, padrão proposto 90 no Nível 1; 9 000 no Nível 2), com a mesma regra: esgotado, `say` na hora. O horário de virada da cota do Google **não está verificado**; o contador deve ser reconciliado pelo erro 429 de RPD, não por suposição de fuso.
- **Consequência da decisão "nível 1":** ~100 requisições por dia, com coalescência de 2–3 por resposta, são ~35–50 respostas faladas por dia em voz natural; passado disso (ou do RPM), o `say` Felipe fala o resto. Para o usuário não achar que algo quebrou, o cartão da tela inicial (e `GET /api/privacy`/estado de voz) mostra **"voz natural: N de 90 pedidos usados hoje"** e, quando esgota, "voz do sistema até a cota renovar". Chamadas de teste e de desenvolvimento gastam a mesma cota (hoje já foram ~80 das 100 do 3.1 e ~30 do Flash-Lite): **o desenvolvimento da F13a consome o orçamento de uso real do dia**, então os testes automatizados usam o Gemini falso em loopback e só a verificação final usa a cota real.
- A coalescência muda o contrato de `sentence_audio_ready` (agora um item pode ter várias frases) e de `markPlayed()` (texto do grupo). A auditoria deve conferir se `emittedSentences` e o classificador de confirmação continuam seguros com isso.
- **Fallback para o `say`, por frase:** em 429, 5xx, 404, timeout ou erro de transporte, e nunca em 400/401/403 (iguais em qualquer provedor; mostram erro de configuração). Prazo por frase: 8 s. É o mesmo provedor/conta da geração; o `say` é local, então não há segundo provedor de nuvem. A regra "sem fallback para outro provedor" da Fase 12 não é afetada, e o plano a registra.
- **Disjuntor:** após uma falha no turno, o resto do turno usa `say` (evita trocar de voz no meio de uma resposta) e o Gemini só volta depois de 60 s. Trocar de voz entre frases é um defeito de experiência conhecido e declarado.
- **Teto diário de gasto:** contador de segundos de áudio sintetizados por dia (`RODRIGO_TTS_DAILY_SECONDS`, padrão proposto 3600). Acima dele, `say`. Protege contra loop de resposta que consome a cobrança.
- Logs e erros passam por `redact()`; nunca registram o texto falado.

### 4.3 Fora do escopo
Streaming do PCM direto ao cliente (reduziria ~1–4 s da primeira frase, exige mudar o contrato de arquivo por frase e o player: ideia da F13b); Gemini Live (o áudio do usuário sairia); clonagem de voz; Qwen3-TTS e Chatterbox como motores (documentados como alternativas locais e rejeitadas por latência); trocar o `say` de fallback.

## 5. Riscos

| Risco | Tratamento |
|---|---|
| Modelo *preview* é aposentado | modelo fixado, `say` como fallback, teste de saúde no startup |
| Latência por frase maior que a do `say` (~0,5 s) | medida em H13a.3; é a troca declarada por qualidade; sem alvo reduzido em silêncio |
| Prefixo de estilo falado em voz alta | H13a.4 transcreve o áudio com o Whisper local e procura as palavras do prefixo |
| Prosódia/volume variam entre frases | H13a.5 mede o volume (RMS) por frase; qualidade perceptiva é julgada pelo usuário |
| Custo inesperado | teto diário (§4.2), tokens reais medidos |
| Chave do projeto compartilhada com a geração | cota de TTS e de geração competem; H13a.1 mede os dois juntos |
| Fallback troca a voz no meio da conversa | disjuntor por turno; frequência medida em H13a.6 |

## 6. Critérios de aceite (propostos; calibrar contra medição, nunca baixar em silêncio)

- **H13a.1 (reescrito após §2A)** — o teste original ("30 chamadas em rajada sem 429") **falhou em 2026-10-07 e não pode passar a 10 RPM por modelo**; não foi baixado em silêncio, foi substituído. Novo critério: com o limitador do §4.2, 100 turnos simulados de 2 a 8 frases não geram nenhum 429 do Google (todo excesso cai no `say` por decisão local), e o projeto registra qual fração das frases foi para o Gemini. *Gate antes de implementar:* o usuário confirma no painel do AI Studio (ai.dev/rate-limit) o limite real de requisições por minuto de `gemini-3.1-flash-tts` no projeto, para sabermos se o Nível 1 já está efetivo.
- **H13a.2** — `RODRIGO_CLOUD=0` ou `RODRIGO_CLOUD_TTS=0`: zero conexão de saída para TTS (mesma medição de `f12Offline.test.ts`, com 50 sínteses).
- **H13a.3** — frases de até 120 caracteres: mediana do início da síntese até `sentence_audio_ready` ≤ 3,0 s e p95 ≤ 6,0 s (propostas a partir das amostras de 2026-10-07; medir em 100 frases reais e reportar).
- **H13a.4** — 0 de 100 frases com texto estranho ao da frase na transcrição (Whisper local; o worker não envia prefixo, o teste garante que nada além do texto é falado e protege contra uma mudança futura no modelo).
- **H13a.5** — diferença de RMS entre frases consecutivas do mesmo turno dentro de um limite a calibrar (amostra: as 25 de 2026-10-07).
- **H13a.6** — em 100 turnos reais, taxa de queda para o `say` reportada; se passar de 5%, a fase não fecha como "funciona".
- **H13a.7** — egresso medido contra um Gemini falso em loopback: só o texto das frases sai; zero byte de áudio do usuário (estende `f12Egress.test.ts`).
- **H13a.8** — fallback testado com falha injetada (429, 503, timeout, 404, 400): 429/503/timeout/404 caem no `say`; 400 não.
- **H13a.9** — `privacyConsistency.test.ts` verde com o novo canal, sem promessa de gratuidade.
- **H13a.10 — voz (só o usuário mede):** uma sessão real de conversa; o usuário diz se a voz deixou de soar robotizada. Se não, a fase não fecha, e voltamos ao §4.3.

## 7. Verificação e auditoria

1. Teste de rajada com cobrança (H13a.1) antes de qualquer código.
2. Implementação por etapas com `npm test` e testes Python a cada uma.
3. Auditoria do plano por **Codex** (auditor de plano) e do código por **Hermes** (auditor de código), conforme a regra de rotação do projeto. Nenhum auditor vê `.env` nem `docs/research/`; registrar no relatório quem viu o quê.
4. Verificar contra a realidade depois (áudio real, uma sessão com o usuário). Aprovação para implementar não é "pronto".

## 8. Pergunta aberta para a auditoria

O padrão `RODRIGO_CLOUD_TTS=1` ligar sozinho, com o texto das respostas indo à nuvem, é compatível com o espírito da Fase 12 (que escolheu padrões explícitos e um canal por controle)? A alternativa é nascer desligado e o usuário ligar uma vez. Recomendo ligado, porque o usuário pediu a voz, mas a decisão é registrada, não presumida.
