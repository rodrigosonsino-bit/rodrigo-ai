# Fase 13a — Voz natural (TTS Gemini): relatório de implementação

Data: 2026-10-08. Plano: `docs/phase-13a-v3.md` (rodadas de plano: agy, Kimi K3). **Código ainda sem auditoria** (a regra do projeto manda auditar o código antes de fechar a fase; o Hermes depende do Docker, que está parado).

Pedido do usuário que originou a implementação (citado): "preciso que essa voz seja a voz do app". Ele havia respondido "sem atalho" à escolha entre protótipo e plano completo; a implementação seguiu o plano v3 sem protótipo.

## 1. O que foi implementado

| Peça | Arquivo | Plano |
|---|---|---|
| Comando `synthesize` do worker em pool próprio de 2 threads daemon (NÃO passa por `work_loop`/`work_queue`), cancelamento por `reqId`/`turnId`, prazo local, WAV atômico (`.part` + `os.replace`), normalização de volume (−17 dBFS, gate −50, teto ±9 dB, limitador −1 dBFS), classificação dos erros do Google | `scripts/worker/worker.py` | §4.2 |
| Orçamento: janela por minuto, dia em America/Los_Angeles, reserva REAL com estorno, falha fechada em arquivo corrompido/ilegível, lockfile | `src/backend/voice/ttsBudget.ts` | §4.4 |
| Provedor Gemini com a voz do sistema de reserva, disjuntor por turno, bloqueios por tipo de erro, concorrência 2 | `src/backend/voice/geminiVoiceProvider.ts` | §4 |
| Seleção da voz (`TTS_ENGINE` padrão `gemini`), validação estrita de `RODRIGO_TTS_*` | `src/backend/voice/ttsProviders.ts` | §4.1 |
| Cliente do worker (`synthesize`, `cancel_synth`, validação do `synth_result`) | `src/backend/voice/mlxWorkerEngine.ts` | §4.2 |
| Emissão das frases em ORDEM ESTRITA, coalescência (1ª frase sozinha, grupos de até 3 frases / 300 caracteres / 1,5 s), rótulo de origem de cada frase, `endTurn` | `src/backend/voice/sessionManager.ts` | §4.3 |
| Canal `RODRIGO_CLOUD_TTS` (efetivo só com o mestre e `RODRIGO_SEND_HISTORY=1`), D-b (`RODRIGO_TTS_DICTATED`, `RODRIGO_SEND_MEMORIES`) | `src/backend/privacy.ts` | §3 |
| Cartão de privacidade e linha de estado da voz (`GET /api/voice/tts-status`) | `src/shared/privacyText.ts`, `src/frontend/main.ts`, `index.html`, `routes.ts` | §3 |
| Documentação: README (§3, §6, §7), `.env.example`, `CLAUDE.md` | — | §3 |

## 2. Desvios do plano v3 (decisões minhas, para a auditoria contestar)

1. **Temporizador de coalescência de 1,5 s** (não estava no plano): sem ele, uma geração lenta deixaria o grupo retido e abriria silêncio depois da frase 0. `SessionTuning` (parâmetro opcional do `SessionManager`) torna os prazos ajustáveis só para os testes.
2. **D-b ficou na opção 1 por padrão** (confirmações com conteúdo ditado vão à voz do Gemini) **sem o usuário ter escolhido**: foi o único jeito de entregar "uma voz só". Reversível por `RODRIGO_TTS_DICTATED=0`.
3. **`.env` do usuário alterado**: `TTS_ENGINE=say` virou `TTS_ENGINE=gemini` (sem isso a voz nova não ligaria). Nenhuma outra linha foi tocada; o `.env` não é rastreado pelo git.
4. O `kind` de cada frase é decidido no `SessionManager` (resultado/pergunta de mutação = `dictated`, hora/data e textos fixos = `local`, resposta gerada = `generated`). A pergunta de mutação continua falada sozinha e idêntica ao texto que `markPlayed` espera.

## 3. Defeito pré-existente descoberto e corrigido (fora do escopo, mas decisivo para a voz)

Ao ouvir o app inteiro de ponta a ponta, as respostas saíam **cortadas no meio da palavra** ("Dizer que a graça é mere"). Causa: o `gemini-flash-latest` passou a "pensar" por padrão e o raciocínio conta no `max_output_tokens`, que era 160; de 160 tokens, ~150 iam ao raciocínio e sobravam ~5 para a fala (finish `MAX_TOKENS`). Medido com o prompt real do app (1017 caracteres):

| Configuração | Resultado |
|---|---|
| sem `thinking_config`, teto 160 | 5 tokens de resposta, 151 de raciocínio, cortado |
| `thinking_budget=0`, teto 160 | **não confiável**: 130–149 tokens de raciocínio em 3 de 4 chamadas (com prompts curtos funcionava) |
| `thinking_level=LOW` | também pensa (134 tokens) |
| `thinking_budget=0`, teto 700 | 6 perguntas variadas: respostas de 24 a 189 tokens, todas `STOP` |

Correção: `GEMINI_MAX_OUTPUT_TOKENS = 512` no worker (cobre raciocínio + resposta) e `thinking_budget=0` só no `gemini-flash-latest` (o modelo reserva `gemini-3.5-flash-lite` o rejeita com HTTP 400 e já responde inteiro). O teto de 160 da intenção em nuvem não mudou. Diagnóstico permanente e seguro no log do worker (`Gemini fim: finish=…, saida=…, raciocinio=…`, só contagens). `test_generation_fallback.py` (34 asserções) e `f12Fallback.test.ts` foram atualizados: a comparação "corpo idêntico" passou a "mensagens e prompt idênticos, única diferença permitida = `thinking_config`", o que preserva a fronteira de dados.

## 4. Verificação

- Python: `test_tts_synthesis.py` 67 ok; `test_generation_fallback.py` 34 ok; demais testes do worker passam.
- Node: **594 de 594** (`npm test`), `npm run typecheck` limpo. Novos: `ttsBudget.test.ts` (17), `geminiVoiceProvider.test.ts` (25), `f13Session.test.ts` (14, estável em 5 rodadas), `f13EgressTts.test.ts` (18, worker REAL + Gemini falso; os erros 429 vêm das classes reais do SDK), mais os de privacidade.
- **Google real, caminho de produção** (worker real, `createVoiceProvider`, 4 frases, 2026-10-08): 1,3–2,1 s por frase, 0 quedas para o `say`, RMS −17,0 dBFS, 568 tokens de áudio para 22,7 s (25,0 tokens/s), orçamento contou 4. App completo (STT local + geração + TTS), uma pergunta falada: resposta inteira, 2 itens de áudio a 24 kHz mono.

| Critério (plano §6) | Estado |
|---|---|
| H13a.2 canal desligado, nenhum pedido; worker recusa | ✔ testado (provedor e worker) |
| H13a.5 volume | ✔ testado e medido no Google real |
| H13a.7 egresso: só texto, sem áudio/histórico/estilo | ✔ testado contra o corpo real da requisição |
| H13a.8 falhas injetadas | ✔ 429 (minuto/dia/desconhecido), 503, 404, 400, timeout, redirecionamento 307 |
| H13a.13 síntese enquanto a geração ocupa o worker | ✔ (< 3 s com geração presa) |
| H13a.15 textos idênticos no mesmo turno | ✔ |
| H13a.16 encerramento com sínteses em curso | ✔ (< 2 s, sem `.part`) |
| H13a.17 ordem de emissão e prazo de prontidão | ✔ |
| H13a.9 consistência das promessas | ✔ (`privacyConsistency` verde sobre README, `.env.example`, `CLAUDE.md`) |
| H13a.1 100 turnos simulados contra o Gemini falso | **não executado** (há testes unitários do orçamento e do provedor, não a simulação de 100 turnos) |
| H13a.3 latência em 100 frases (falso) + 20 reais | **parcial**: 4 reais medidas; falta a bateria |
| H13a.4 transcrição do Whisper sem texto estranho | **não executado** (o corpo da requisição prova que nenhum prefixo é enviado) |
| H13a.6 30 turnos reais com orçamento injetado | **não executado** |
| H13a.10 o usuário ouve e diz se deixou de soar robotizada | **PENDENTE, só o usuário mede** |
| H13a.11 barge-in dentro de um grupo | **parcial**: o descarte do grupo acumulado está testado; a perda de histórico não foi medida em 20 interrupções |
| H13a.12 captura do 429 diário | **não executado** (precisa esgotar a cota do dia, supervisionado) |
| H13a.14 matriz de privacidade | **parcial**: coberta nos testes do provedor (histórico desligado, memórias desligadas, `RODRIGO_TTS_DICTATED=0`), não como matriz completa |

## 5. O que o usuário precisa saber

- **A instância do app que já estava rodando** (porta 3000) continua com o código antigo e a voz `say`: é preciso reiniciá-la para ouvir a voz nova.
- **Latência observada, não corrigida:** do fim da fala até o primeiro áudio, ~7,4 s no app completo nesta máquina (STT ~0,9 s, classificação ~1 s, primeiro trecho do Gemini ~3 s por causa do raciocínio, TTS 1,3–2 s). É o item de latência da F13 e não foi atacado aqui.
- **Cota:** Nível 1 = 10/min e 100/dia por modelo; o app usa 8 e 90. Esgotada, a voz do sistema assume na hora e a tela mostra "N de 90 pedidos usados hoje".
- **Estado de entrega** (comandos rodados ao escrever, não de memória): ver o final da conversa; nada desta fase está comitado.
