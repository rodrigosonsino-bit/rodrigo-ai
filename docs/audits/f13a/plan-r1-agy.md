# RELATÓRIO DE AUDITORIA ADVERSARIAL DE PLANO

**Alvo Auditado:** [`docs/phase-13a-v1.md`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md) (Fase 13a — Voz Natural com TTS Gemini v1)  
**Documentos de Referência:** [`CLAUDE.md`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/CLAUDE.md), [`docs/phase-12-v2.md`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-12-v2.md)  
**Auditor:** Adversarial Plan Auditor (Antigravity IDE)  
**Data da Auditoria:** 2026-10-07  
**Status do Plano:** **REJEITADO**

---

### Nota Metodológica Preliminar sobre Alegações Empíricas (§2, §2A, §2B)
Os dados quantitativos apresentados pelo autor nos parágrafos §2, §2A e §2B (latências TTFC de 0,75–1,0 s; taxa de 25,0 tokens de áudio por segundo; quotas de 10 RPM / 100 RPD no Nível 1; erros 429 medidos em rajadas de 30 e 40 chamadas; e custos de US$ 6 a US$ 12 por milhão de tokens) **são alegações privadas e não verificadas pelo auditor**, capturadas em sessão externa inacessível. Neste relatório, tais números são tratados como **alegações não reproduzíveis**. Quando uma conclusão ou escolha arquitetural do plano depende intrinsecamente de um desses números, isso é expressamente assinalado.

---

## 1. Contrato de Síntese e Arquitetura do Worker Python

ACHADO: O plano apresenta uma contradição arquitetural direta ao afirmar simultaneamente que o contrato de síntese por frase não muda e propor coalescência que altera o contrato de `sentence_audio_ready` e `markPlayed`.  
EVIDÊNCIA: [`docs/phase-13a-v1.md:73`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L73) afirma textualmente: *"O contrato do arquivo por frase (synthesize(text, outputPath, signal)) não muda; sessionManager.ts fica como está, exceto o limite de concorrência abaixo."* Em contraste, [`docs/phase-13a-v1.md:80`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L80) declara: *"A coalescência muda o contrato de sentence_audio_ready (agora um item pode ter várias frases) e de markPlayed() (texto do grupo)."*  
GRAVIDADE: CRÍTICA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Resolver a contradição explicitando onde a coalescência ocorre. Se `sessionManager.ts` agrupa frases, seu pipeline de streaming, controle de turnos e casamento em `markPlayed` sofrem refatoração profunda e não "ficam como estão".

---

ACHADO: O laço de execução mono-thread do worker Python (`work_loop`) causa bloqueio mútuo e impede a síntese de áudio durante a geração em streaming do LLM.  
EVIDÊNCIA: Em [`scripts/worker/worker.py:1112-1134`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/scripts/worker/worker.py#L1112-L1134), `work_loop` consome tarefas de `self.work_queue` (tamanho 1) em uma única thread síncrona. Quando `handle_generate` está iterando o stream de tokens do Gemini ([`worker.py:1021-1058`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/scripts/worker/worker.py#L1021-L1058)), a thread principal do worker está ocupada. O novo comando `synthesize` ([`docs/phase-13a-v1.md:72`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L72)) enfileirado para a frase 0 não será processado até a geração inteira terminar. Além disso, uma segunda síntese descarta a primeira por `queue.Full` ([`worker.py:1158-1163`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/scripts/worker/worker.py#L1158-L1163)), inviabilizando a concorrência proposta de 2 sínteses ([`docs/phase-13a-v1.md:77`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L77)). *(Controle positivo: busca por `"synthesize"` no worker retornou 0 ocorrências, enquanto `"generate"` retornou 3).*  
GRAVIDADE: CRÍTICA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Redesenhar o processamento do comando `synthesize` no worker para rodar em um `ThreadPoolExecutor` desacoplado do `work_loop`, ou utilizar um worker/processo dedicado para TTS com fila NDJSON independente, preservando o streaming frase a frase.

---

ACHADO: O prazo de 8 segundos por frase estipulado no plano viola o piso mínimo de deadline da API do Google Gemini (10s) e provocará erro HTTP 400 fatal sem fallback.  
EVIDÊNCIA: O plano fixa em [`docs/phase-13a-v1.md:81`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L81): *"Prazo por frase: 8 s."* No entanto, o código real em [`scripts/worker/worker.py:448-450`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/scripts/worker/worker.py#L448-L450) alerta categoricamente: *"ATENÇÃO: o prazo HTTP vai ao Google como 'deadline' e o MÍNIMO ACEITO É 10 s — abaixo disso a API responde 400 INVALID_ARGUMENT ('Manually set deadline 8s is too short') e a geração inteira para de funcionar. Nunca < 10_000."* Como a regra de fallback do plano proíbe explicitamente fallback em erros 400 ([`docs/phase-13a-v1.md:81`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L81)), a chamada de TTS será rejeitada pelo Google com 400 e o sistema emudecerá em erro sem falar pelo `say`.  
GRAVIDADE: CRÍTICA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Ajustar o timeout HTTP do cliente Gemini TTS para no mínimo 10_000 ms no `build_gemini_client`, implementando o cancelamento e timeout por frase no lado do Node (AbortSignal) sem enviar header de deadline < 10s ao Google.

---

ACHADO: O mecanismo de cancelamento do worker é unário e não suporta o ciclo de vida concorrente de múltiplas sínteses ou cancelamento de TTS sem cancelar a geração.  
EVIDÊNCIA: Em [`scripts/worker/worker.py:600-601`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/scripts/worker/worker.py#L600-L601) e [`:642-648`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/scripts/worker/worker.py#L642-L648), `self._current` rastreia um único `GenerationHandle`. Se o comando `synthesize` for executado, ou ele sobrescreve `self._current` (quebrando o cancelamento de `generate`), ou requer identificação granular por `reqId`/`turnId` que o despachante de cancelamento atual não possui. O plano omite completamente como uma síntese em andamento é abortada via HTTPX/Google SDK.  
GRAVIDADE: ALTA  
CONFIANÇA: 95%  
AÇÃO RECOMENDADA: Implementar rastreamento de tarefas por `reqId` com `threading.Event` dedicado em um dicionário thread-safe `_active_syntheses`, cancelando a requisição HTTP subjacente sem colidir com `handle_generate`.

---

ACHADO: O plano omite a especificação de como o worker Python empacota o áudio recebido em formato WAV RIFF PCM 16-bit compatível com o cliente web.  
EVIDÊNCIA: [`docs/phase-13a-v1.md:14,72`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L14) cita que o worker *"grava o WAV direto em outputPath"*. A API do Gemini TTS retorna PCM bruto em stream/chunks. O frontend ([`src/frontend/voice.ts:341-342`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/frontend/voice.ts#L341-L342)) decodifica via `audioContext.decodeAudioData()`, que exige um container de áudio estruturado (cabeçalho RIFF/WAVE de 44 bytes). O plano não especifica se a gravação usa o módulo nativo `wave` do Python ou biblioteca externa, nem como lida com truncamento por abort.  
GRAVIDADE: MÉDIA  
CONFIANÇA: 90%  
AÇÃO RECOMENDADA: Definir formalmente a rotina de escrita do container WAV (usando a biblioteca padrão `wave`) garantindo `channels=1`, `sampwidth=2`, `framerate=24000` e fechamento atômico do cabeçalho.

---

## 2. Coalescência de Frases, Barge-in e Segurança de Mutações

ACHADO: A coalescência de frases corrompe a integridade da memória conversacional e a continuidade do assistente em caso de interrupção por fala do usuário (barge-in).  
EVIDÊNCIA: Em [`src/frontend/voice.ts:334-370`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/frontend/voice.ts#L334-L370), `POST /api/voice/session/played` só é disparado no evento `source.onended` após o chunk de áudio tocar por completo. Se o usuário interromper a fala durante a execução de um grupo coalescido (por exemplo, ouve perfeitamente a frase 1 e interrompe na frase 2), o evento de interrupção síncrono descarta o chunk ([`voice.ts:281,363`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/frontend/voice.ts#L281)). Consequentemente, [`src/backend/voice/sessionManager.ts:768`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/voice/sessionManager.ts#L768) nunca é invocado para nenhuma das frases do bloco. O usuário responderá ao que ouviu na frase 1, mas o modelo não terá registro no histórico de que emitiu tal frase.  
GRAVIDADE: ALTA  
CONFIANÇA: 95%  
AÇÃO RECOMENDADA: O plano deve rejeitar a afirmação ingênua de que a perda do bloco é "conservadora e inofensiva" ([`docs/phase-13a-v1.md:77`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L77)), ou limitar a coalescência a blocos muito curtos (máx. 2 frases) com ciência de que a interrupção apagará ambas da memória contextual.

---

ACHADO: O desenho da coalescência em `sessionManager.ts` é omisso quanto à sincronização, retenção em buffer e esvaziamento forçado (flush) no término da geração.  
EVIDÊNCIA: Em [`src/backend/voice/sessionManager.ts:645-660`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/voice/sessionManager.ts#L645-L660), o callback `onSentence(rawText, index)` é invocado de forma assíncrona conforme os limites de pontuação são encontrados pelo worker. Para agrupar até 300 caracteres ([`docs/phase-13a-v1.md:77`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L77)), `sessionManager.ts` precisa reter as frases em um buffer temporário. O plano não define como o encerramento da geração (`turn_done`) libera o resíduo acumulado abaixo de 300 caracteres, nem como atribui o `sentenceIndex` emitido em `sentence_audio_ready` ([`sessionManager.ts:737`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/voice/sessionManager.ts#L737)), o que causaria desordem na fila do cliente ([`src/frontend/voice.ts:138`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/frontend/voice.ts#L138)).  
GRAVIDADE: ALTA  
CONFIANÇA: 95%  
AÇÃO RECOMENDADA: Especificar a máquina de estados de agregação de frases em `sessionManager.ts`, incluindo o tratamento do evento final de `done` para dar flush imediato no buffer pendente e o esquema monotônico de indexação de chunks.

---

ACHADO: A coalescência arrisca quebrar a promoção determinística de mutações pendentes caso uma pergunta de confirmação seja agrupada com texto adicional.  
EVIDÊNCIA: Em [`src/backend/voice/sessionManager.ts:775-779`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/voice/sessionManager.ts#L775-L779), `markPlayed` exige igualdade exata de strings: `session.armedMutation.question === text`. No fluxo atual de mutações ([`sessionManager.ts:495-509`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/voice/sessionManager.ts#L495-L509)), a pergunta de confirmação é sintetizada isoladamente no índice 0. O plano menciona que a coalescência alterará o texto de `markPlayed()` ([`docs/phase-13a-v1.md:80`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L80)), mas não proíbe expressamente a coalescência de perguntas de confirmação. Se qualquer lógica agrupar a pergunta com texto vizinho, `session.pendingMutation` nunca será ativado, bloqueando qualquer confirmação de mutação no app.  
GRAVIDADE: ALTA  
CONFIANÇA: 90%  
AÇÃO RECOMENDADA: Declarar como invariante inviolável que perguntas de mutação (`armedMutation`), reprompts (`MUTATION_REPROMPT_TEXT`) e saídas de ferramentas nunca passam por coalescência, sendo sempre sintetizadas individualmente no índice 0.

---

## 3. Privacidade, Fronteira de Dados e Conformidade com a Fase 12

ACHADO: A premissa central de privacidade do plano de que enviar o texto falado ao Gemini "não é categoria nova de dado" é factualmente incorreta no código.  
EVIDÊNCIA: O plano afirma em [`docs/phase-13a-v1.md:67`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L67): *"Não é categoria nova de dado: toda frase falada já entra no histórico depois de markPlayed() e vai à geração (padrão RODRIGO_SEND_HISTORY=1). Muda o canal, não o conteúdo."*  
No código real, isso é falso em três frentes:
1. Quando `RODRIGO_SEND_HISTORY=0`, [`src/backend/voice/sessionManager.ts:846-848`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/voice/sessionManager.ts#L846-L848) envia estritamente a fala do usuário atual (`[history[history.length - 1]]`), e **nenhuma fala do assistente jamais saía da máquina**; com `RODRIGO_CLOUD_TTS=1`, todo o texto do assistente é transmitido à nuvem.
2. Frases interrompidas por barge-in nunca passam por `markPlayed()` e jamais entraram no histórico. Com TTS em nuvem, são enviadas à nuvem *antes* de serem faladas.
3. Respostas de ferramentas locais (hora, data, lembretes, notas) em sessões que não realizam novas gerações retornam imediatamente ([`sessionManager.ts:428-433, 561-566`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/voice/sessionManager.ts#L428-L433)) e nunca trafegavam para a nuvem.  
GRAVIDADE: CRÍTICA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Reconhecer a expansão da fronteira de dados no modelo de ameaça da Fase 12. Quando `RODRIGO_SEND_HISTORY=0`, desativar compulsoriamente `RODRIGO_CLOUD_TTS` ou exigir consentimento expresso e documentado do usuário.

---

ACHADO: O envio irrestrito de saídas de ferramentas locais ao TTS em nuvem vaza notas privadas e memórias sensíveis mesmo com salvaguardas de isolamento ativas.  
EVIDÊNCIA: Em [`docs/phase-13a-v1.md:68`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L68), o autor decide que *"Frases locais (hora, data, confirmações de lembrete/nota) também passam pela nuvem, para manter uma voz só"*. Se o usuário ditar uma nota ou memória contendo segredos ou dados pessoais (ex.: `"anota que o código da mala é 1234"`), o preview local gerado pela ferramenta ([`src/backend/tools/mutatingTools.ts:43,60`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/tools/mutatingTools.ts#L43)) será enviado em texto claro aos servidores do Google via TTS, mesmo que o usuário tenha configurado `RODRIGO_SEND_MEMORIES=0` na Fase 12 ([`docs/phase-12-v2.md:72`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-12-v2.md#L72)).  
GRAVIDADE: ALTA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Submeter esta decisão ao usuário: saídas de confirmação de mutações que reproduzem conteúdo textual arbitrário devem sintetizar localmente via `say` quando `RODRIGO_SEND_MEMORIES=0`, ou o risco de vazamento de segredos pelo TTS deve ser registrado como dívida de privacidade declarada.

---

ACHADO: A proposta de alteração de `privacyConsistency.test.ts` entra em conflito insolúvel com a obrigatoriedade de divulgação do nível gratuito da Fase 12.  
EVIDÊNCIA: [`docs/phase-13a-v1.md:69,111`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L69) afirma que o teste `privacyConsistency.test.ts` passará a proibir as palavras `"gratuito"` e `"sem custo"`. No entanto, em [`src/backend/__tests__/privacyConsistency.test.ts:48-55`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/__tests__/privacyConsistency.test.ts#L48-L55), o teste exige ativamente: `assert.match(c, /n[ií]vel gratuito|free tier|GRATUITO/i)` para `README.md`, `.env.example` e `CLAUDE.md`. Se o projeto estiver sob cobrança pré-paga no Nível 1 para TTS ([`phase-13a-v1.md:6`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L6)), mas a geração continuar sob os termos do nível gratuito (ou vice-versa), os testes de consistência quebram imediatamente.  
GRAVIDADE: MÉDIA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Clarificar o status contratual da chave no Google Cloud: uma chave com faturamento ativado (Nível 1) aplica os termos de faturamento comercial para todos os endpoints; as mensagens de aviso e os testes devem distinguir "serviço sem mensalidade de assinatura" de "termos de uso gratuito/comercial".

---

## 4. Orçamento de Cota, Persistência e Troca de Voz

ACHADO: O esgotamento do orçamento de requisições durante um turno provoca chaveamento desagradável de voz no meio da mesma resposta do assistente.  
EVIDÊNCIA: Em [`docs/phase-13a-v1.md:77-78`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L77-L78), quando o limitador de 8 RPM ou a cota diária de 90 RPD é atingida, *"a frase cai no say na hora, sem esperar"*. Embora [`:82`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L82) adicione um disjuntor para que o *resto* do turno use `say`, ele só atua reativamente. Se uma resposta tiver 3 frases e o orçamento estourar após a frase 1, o usuário ouvirá a frase 1 na voz Charon (humana/Gemini) e as frases 2 e 3 na voz Felipe Enhanced (robótica/macOS), criando uma experiência bizarra e incoerente.  
GRAVIDADE: ALTA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Definir uma reserva de cota por turno: antes de iniciar a síntese da primeira frase de uma resposta gerada, verificar se há saldo mínimo suficiente para um turno médio (ao menos 2 requisições); se não houver, o turno inteiro deve iniciar e terminar no `say`.

---

ACHADO: A persistência do contador de cota diária em `.runtime/` é vulnerável a condições de corrida, corrupção por crash e divergência de fuso horário em relação à API do Google.  
EVIDÊNCIA: [`docs/phase-13a-v1.md:78`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L78) propõe um *"contador diário persistido em .runtime/"*, mas admite: *"O horário de virada da cota do Google não está verificado; o contador deve ser reconciliado pelo erro 429 de RPD, não por suposição de fuso."* As cotas diárias da Google Cloud Platform e AI Studio reiniciam à meia-noite do fuso Pacífico (PT, UTC-7/UTC-8), enquanto o servidor local opera no fuso de Brasília (BRT, UTC-3). Em uma janela de 4 a 5 horas diárias, o contador local zerará enquanto a cota do Google ainda estará esgotada. Além disso, operações concorrentes de leitura/escrita de arquivo sem lock atômico sofrem corrupção em caso de reinício forçado.  
GRAVIDADE: ALTA  
CONFIANÇA: 90%  
AÇÃO RECOMENDADA: Utilizar escrita atômica com arquivo temporário e `fs.rename`, indexar o dia pelo fuso oficial de corte de quotas do Google (UTC ou America/Los_Angeles) e tratar qualquer erro 429 de cota diária como bloqueador automático até a virada de data naquele fuso.

---

ACHADO: A proposta de "reconciliação do contador diário pelo erro 429 de RPD" é inviável porque o plano não define a assinatura do erro retornado pelo Google.  
EVIDÊNCIA: No erro de cota capturado pelo autor em [`docs/phase-13a-v1.md:39`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L39), o payload identifica estritamente cota por minuto: `quotaId GenerateRequestsPerMinutePerProjectPerModel`. O plano não possui nenhuma evidência ou especificação de qual `quotaId` ou string identifica a exaustão por dia (`RequestsPerDayPerProjectPerModel`). Sem isso, o código não tem como distinguir programaticamente uma rejeição temporária de rajada (esperar segundos) de uma rejeição diária (esperar amanhã), sob risco de desativar o TTS pelo dia inteiro após um simples pico de 1 minuto.  
GRAVIDADE: ALTA  
CONFIANÇA: 95%  
AÇÃO RECOMENDADA: Definir o contrato exato de tratamento do erro 429 inspecionando o campo `retryDelay`: atrasos curtos (ex.: 11s) devem aplicar backoff por minuto; atrasos superiores a várias horas devem acionar o travamento diário.

---

## 5. Crítica Aprofundada dos Critérios de Aceite (§6)

ACHADO: O critério de aceite H13a.6 é matematicamente impossível de ser satisfeito com a cota diária do Nível 1 imposta pelo usuário.  
EVIDÊNCIA: [`docs/phase-13a-v1.md:108`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L108) exige: *"H13a.6 — em 100 turnos reais, taxa de queda para o say reportada; se passar de 5%, a fase não fecha como 'funciona'."* Em 100 turnos de diálogo comum, geram-se ao menos 200 a 300 frases (mesmo coalescidas para ~150-200 requisições). Com a cota diária do Nível 1 fixada em 100 RPD ([`docs/phase-13a-v1.md:47,78`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L47)), após cerca de 45 a 50 turnos o limite de 90 pedidos diários do app se esgota compulsoriamente. Do turno 51 ao 100, **100% das frases cairão no say**, resultando em uma taxa global de queda para o `say` de no mínimo 50%, violando flagrantemente o teto de 5%.  
GRAVIDADE: CRÍTICA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Reformular H13a.6 para medir a taxa de queda *dentro da janela de orçamento disponível* (ex.: taxa de queda nos primeiros 30 turnos de uma sessão com cota limpa), ou assumir que Nível 1 não suporta 100 turnos de voz contínuos sem migrar para o Nível 2.

---

ACHADO: O critério H13a.1 é circular, vácuo na validação do TTS e referencia o modelo errado em seu portão de liberação.  
EVIDÊNCIA: [`docs/phase-13a-v1.md:103`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L103) define que *"100 turnos simulados de 2 a 8 frases não geram nenhum 429 do Google (todo excesso cai no say por decisão local)"*. Se o limitador local for excessivamente conservador ou se o TTS falhar completamente e redirecionar 100% para o `say`, o teste registra zero 429s e é considerado aprovado com sucesso sem sintetizar nada pelo Gemini. Além disso, o portão prévio de verificação menciona textualmente o modelo descartado `gemini-3.1-flash-tts`, em vez do modelo adotado `gemini-3.8-flash-lite-tts`.  
GRAVIDADE: ALTA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Exigir em H13a.1 um piso mínimo de taxa de sucesso de síntese em nuvem (ex.: pelo menos 75% das frases de teste sintetizadas com sucesso no Gemini TTS) para que o teste seja válido.

---

ACHADO: A execução dos critérios H13a.3 e H13a.4 em ambiente real consome a totalidade do orçamento diário do usuário.  
EVIDÊNCIA: H13a.3 exige medição de latência em 100 frases reais ([`docs/phase-13a-v1.md:105`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L105)) e H13a.4 exige transcrição e verificação de 100 frases reais ([`docs/phase-13a-v1.md:106`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L106)). A execução de qualquer um deles esgota imediatamente as 100 requisições diárias (RPD) do projeto no Nível 1 ([`:47`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L47)), impedindo o uso do sistema ou a execução dos demais testes no mesmo dia.  
GRAVIDADE: ALTA  
CONFIANÇA: 95%  
AÇÃO RECOMENDADA: Reduzir a bateria de verificação final ao vivo para uma amostra estatisticamente viável sob a cota diária (ex.: 20 a 25 frases reais), mantendo a bateria de 100 frases estritamente contra o mock/Gemini falso em loopback.

---

ACHADO: O critério de qualidade de áudio H13a.5 é um pseudo-critério não verificável pela ausência de parâmetros e limiares objetivos.  
EVIDÊNCIA: [`docs/phase-13a-v1.md:107`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L107) define: *"H13a.5 — diferença de RMS entre frases consecutivas do mesmo turno dentro de um limite a calibrar"*. Um critério cujo limiar é "a calibrar" não pode falhar nem passar em uma verificação automatizada, servindo como aprovação automática por vacuidade.  
GRAVIDADE: MÉDIA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Definir numericamente a tolerância máxima aceitável de variação de energia RMS entre frases (por exemplo, variação relativa ≤ 3 dB ou delta RMS ≤ 0,05) baseada na amostra piloto.

---

ACHADO: A mudança do modelo de TTS aprovado pelo usuário para o Flash-Lite foi decidida sem validação auditiva humana e compromete o fechamento da fase em H13a.10.  
EVIDÊNCIA: Em [`docs/phase-13a-v1.md:10,74`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L10), o plano registra que o usuário ouviu e escolheu o modelo `gemini-3.1-flash-tts-preview` na audição às cegas. O autor alterou o modelo de produção para `gemini-3.8-flash-lite-tts` com base unicamente no preço, anotando expressamente: *"A escolha do modelo mais barato foi dada sem registro de que o usuário tenha ouvido a 2ª audição; a qualidade do Flash-Lite não está confirmada"*. Como o modelo 3.8 não aceita `system_instruction` de tom ([`phase-13a-v1.md:75`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L75)), há alto risco de reprovação no gate final H13a.10 ([`:112`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L112)), invalidando toda a implementação.  
GRAVIDADE: ALTA  
CONFIANÇA: 90%  
AÇÃO RECOMENDADA: Realizar a audição comparativa da voz Charon no modelo Flash-Lite com o usuário *antes* de iniciar a escrita do código, confirmando se a qualidade atende às expectativas.

---

## 6. Omissões Estruturais e Regressões na Suíte Existente

ACHADO: O plano quebra a suíte de testes de egresso e conformidade de rede da Fase 12 sem atualizar seus gabaritos.  
EVIDÊNCIA: Em [`src/backend/__tests__/f12Egress.test.ts:93-96`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/src/backend/__tests__/f12Egress.test.ts#L93-L96), a suíte automatizada afere rigidamente que o número de requisições recebidas pelo mock do Gemini é exatamente `sc.expect.genRequests + sc.expect.intentRequests`, falhando sob qualquer chamada excedente. Se o provedor de voz padrão passar a invocar o worker para síntese com `RODRIGO_CLOUD_TTS=1`, as chamadas adicionais de TTS quebrarão imediatamente os 7 cenários e 105 turnos de `f12Egress.test.ts`. O plano não prevê o desacoplamento de TTS nas fixtures existentes nem a atualização dos gabaritos.  
GRAVIDADE: ALTA  
CONFIANÇA: 100%  
AÇÃO RECOMENDADA: Atualizar `helpers/egress.ts` para que as suítes da Fase 12 continuem isoladas (com `RODRIGO_CLOUD_TTS=0` injetado por padrão nos testes legados) e criar um arquivo de teste dedicado para egresso de TTS (`f13EgressTts.test.ts`).

---

ACHADO: Ausência de tratamento para segregação de credenciais e risco de esgotamento de quota cruzada entre TTS e geração.  
EVIDÊNCIA: Em [`docs/phase-13a-v1.md:98`](file:///private/tmp/claude-501/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/cad3bf41-fe94-4f51-a3f2-5f55b16376a0/scratchpad/audit-snap/docs/phase-13a-v1.md#L98), o plano nota como risco: *"Chave do projeto compartilhada com a geração: cota de TTS e de geração competem"*. O plano propõe que H13a.1 meça os dois juntos, mas omite qualquer política de isolamento. Se rajadas de geração ou classificação de intenção consumirem conexões, o TTS falhará por cota global do projeto, derrubando a voz antes mesmo de a resposta começar a ser dita.  
GRAVIDADE: MÉDIA  
CONFIANÇA: 85%  
AÇÃO RECOMENDADA: Investigar se o projeto Google suporta chaves distintas ou se o rate limiter do Node deve priorizar a finalização de turnos em andamento frente a novas classificações de intenção.

---

## 7. O que NÃO foi possível verificar
1. **Limites e comportamento real da API do Google:** As taxas de 10 RPM / 100 RPD, latências e custos de tokens reportados pelo autor para `gemini-3.8-flash-lite-tts` dependem de consultas ao console do Google AI Studio e chamadas ao vivo externas que não podem ser efetuadas sem rede externa ativa.
2. **Qualidade perceptiva da voz Charon no modelo Flash-Lite:** Não foi possível ouvir nem atestar se o modelo 3.8 Flash-Lite sem prefixo de tom soa robotizado em comparação ao 3.1 Flash TTS.
3. **Assinatura do erro 429 para exaustão diária:** Não há registros no repositório do corpo de erro emitido pela API do Gemini quando o limite diário (RPD) é alcançado.

---

# VEREDITO

### **REJEITADO**

**Justificativa Técnica do Veredito:**  
O plano `docs/phase-13a-v1.md` não está pronto para implementação e falharia em produção e na suíte de testes existente pelos seguintes motivos incontornáveis:
1. **Deadlock no Worker:** O pipeline de streaming morreria bloqueado porque o `work_loop` mono-thread do `worker.py` não permite executar o comando `synthesize` enquanto consome os tokens de `generate`.
2. **Deadline Inválido no Google:** O prazo de 8 segundos por frase viola a restrição hardcode da API do Gemini (mínimo de 10s), gerando erros 400 sem fallback para o `say`.
3. **Violação de Invariantes de Privacidade:** A alegação de que o TTS na nuvem "não é categoria nova de dado" é factualmente incorreta para os modos `RODRIGO_SEND_HISTORY=0`, barge-in e saídas de ferramentas locais, vazando notas privadas e quebrando os contratos estabelecidos na Fase 12.
4. **Critérios de Aceite Inatingíveis e Vácuos:** O critério H13a.6 é matematicamente incapaz de passar sob a cota diária do Nível 1 (100 RPD), H13a.1 é circular, H13a.5 é desprovido de métrica e H13a.3/H13a.4 devoram a cota diária inteira do usuário em uma única execução de teste.
5. **Inconsistência Auditiva de Voz:** O plano não evita a troca grotesca de voz (Charon para Felipe) no meio de uma mesma resposta quando o limitador local ou diário atua.

O autor deve produzir uma revisão **v2** do plano sanando todos os achados apontados antes de qualquer código ser escrito no repositório.
