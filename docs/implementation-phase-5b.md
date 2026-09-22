# Fase 5b — Ferramentas de leitura (hora/data): relatório de implementação

Data: 2026-09-22
Base: commit `903be84` (`Rodrigo AI v0.3.0` — versão do `package.json` não foi bumpada)
Plano implementado: `docs/phase-5b-v6.md`, aprovado após 6 rodadas de auditoria de plano.

---

## 1. O que foi entregue

`HoraAtualTool` e `DataAtualTool` (`src/backend/tools/systemTools.ts`) respondem, com o relógio real
do sistema, a pedidos coloquiais de hora e data — a premissa que motivou a fase: o sistema hoje
alucina ("são seis e meia" quando são 10:54; "quinta-feira, 21 de abril" numa segunda de setembro).
Arquitetura híbrida de três camadas: filtro permissivo em regex (Node) decide só se vale gastar uma
inferência; um comando `detect_tool` no worker MLX (`temp=0.0`, prompt fechado em três categorias)
decide qual ferramenta; o código, nunca o modelo, sintetiza a resposta final — o LLM não pode
contradizer o relógio porque não é consultado depois de decidida a ferramenta.

**Novos:** `src/backend/tools/{systemTools,index}.ts`, `src/backend/__tests__/tools.test.ts`,
`scripts/worker/test_tool_parser.py` (standalone, mesmo padrão de `test_repetition_detector.py`),
`scripts/h11-check.mjs` (verificação manual com áudio real, mesmo espírito de `matrix-c6.mjs`).
**Modificados:** `extensions/{tools,registry}.ts`, `voiceProtocol.ts` (`TOOL_NAMES`,
`DETECT_TOOL_TIMEOUT_MS`), `scripts/worker/worker.py` (`detect_tool` nos dois pontos de despacho),
`voice/{engine,mlxWorkerEngine,fakeEngine,sessionManager,voiceRuntime}.ts`,
`__tests__/{extensions,voice}.test.ts`.

---

## 2. Processo: 6 rodadas de auditoria de plano, 4 fornecedores, um protocolo novo

| Versão | Auditor / modelo | Achados | Motivo central da rejeição |
|---|---|---|---|
| v1 | Codex / gpt-5.6-sol | 24 (14 ALTA) | classificador ganhava rótulo+ferramenta — regressão no componente já validado |
| v2 | Codex / gpt-5.6-sol | ~12 (14 ALTA) | modelo detectava E respondia — obediência probabilística do mesmo 4B que já alucina a hora |
| v3 | Hermes / longcat-2.0 | 8 (4 ALTA) | regex de enunciado inteiro: 29/30 falso negativo em fala coloquial real |
| v4 | agy / Gemini 3.8 Flash | 9 (2 ALTA) | desenho híbrido certo, mas vazamento de dado de teste no prompt + timeout que matava o worker que o próprio fallback precisava |
| v5→rodada 5 | Hermes / longcat-2.0 | 6 (2 ALTA) | os 9 achados da v4 corrigidos (revalidados por execução); 6 novos, todos lacuna de pseudocódigo (`stdin_reader_loop` sem `detect_tool`, `cancel()` do fake sem limpar `detectToolGates`) |
| v6→rodada 6 | Hermes / longcat-2.0 (dirigida) | 0 | os 6 corrigidos, confirmados um a um |

**Protocolo de congelamento (novo nesta fase):** o prompt de detecção (`DETECT_TOOL_SYSTEM_PROMPT`)
foi escrito e commitado (`20ef3e1`) **antes** de qualquer contato com a amostra de validação de H11.
A amostra — 20 frases coloquiais geradas por uma IA independente de quem escreveu o prompt — foi
selada por commit próprio (`612140d`) logo que chegou, também sem edição. A ordem é o que torna a
medição do §4 abaixo não-viesada: nenhuma das duas partes viu a outra antes de existir por escrito.

Motivação do protocolo: as versões v2 e v4 caíram, entre outras coisas, por vazamento de dado de
teste — frases da amostra adversarial de uma rodada acabaram copiadas para dentro do próprio prompt
que a amostra ia avaliar depois. Aconteceu duas vezes na mesma fase antes de virar regra explícita.

---

## 3. Auditoria de código (após implementação) — aprovado, com mutation testing

Implementado por `agy` (modo `accept-edits`) a partir do plano aprovado. Antes de qualquer commit,
verificação independente (não a autodeclaração do `agy`): `DETECT_TOOL_SYSTEM_PROMPT` conferido
byte a byte contra o congelado em `docs/phase-5b-v5.md` §4.9; `npm run build` limpo; `npm test`
76/76; `test_tool_parser.py` 14/14; `package.json` e `docs/` intocados.

Auditoria de código pelo Hermes CLI (execução real contra o repositório, não leitura de plano):
rodou a suíte, escreveu scripts próprios para **quebrar de propósito** três propriedades declaradas
(`execute()` retornando lixo, `cancel()` sem limpar `detectToolGates`, `TIME_GATE` sem "século") e
confirmou que a suíte acusou as três antes de desfazer as mutações — evidência de que os testes têm
poder discriminativo real, não são vácuos. **Veredito: APROVADO, zero achados**
(`docs/audits/phase-5b-v6-codigo-hermes-2026-09-22.log`).

---

## 4. H11 — verificação com MLX real: 15/20 (75%), **não atingiu a meta de 80%**

`scripts/h11-check.mjs`: cada uma das 20 frases seladas (`docs/audits/phase-5b-v5-h11-sample-2026-09-22.md`)
sintetizada em áudio (`say`+`ffmpeg`) e enviada a um servidor real (`Qwen3-4B-Instruct-2507-4bit` +
`whisper-small-mlx`), classificando o resultado pelo **texto da resposta falada**
(`sentence_audio_ready.text`) — não pelo evento `routing`, que emite o mesmo
`label:'GERAL', handled:true` tanto no caminho de ferramenta quanto no caminho normal, e por isso não
serve para distinguir os dois. Relatório completo:
`docs/audits/phase-5b-v6-h11-result-2026-09-22.json`.

**Resultado: 15/20 = 75,0%.** Critério bloqueante do plano (`docs/phase-5b-v5.md` §7, H11): "abaixo
disso, a fase não passa." Quatro falhas, duas causas distintas:

| # | Frase | Transcrição real (Whisper) | Resposta | Causa |
|---|---|---|---|---|
| 3 | "Me fala a hora aí?" | "Me fala **agora** aí?" | genérica, sem a hora | STT perdeu a palavra "hora" antes de chegar ao detector |
| 6 | "Já passou do meio-dia?" | idêntica | "Sim, já passou do meio-dia." (**alucinada** — não consultou o relógio) | falha real de `detect_tool`: não reconheceu a intenção |
| 8 | "Ainda é cedo ou já tá ficando tarde?" | idêntica | "Já tá ficando tarde." (**alucinada**) | falha real de `detect_tool` |
| 9 | "Hoje caiu em qual dia do mês?" | "Hoje **cai um e igual** dia do mês?" | respondeu certo apesar disso, mas sem a ferramenta | STT destruiu a frase antes de chegar ao detector |

Mais #10 ("A gente já chegou no dia vinte e dois?"), marcada ambígua desde a criação da amostra, sem
consenso sobre o rótulo esperado.

**Leitura que não deve substituir o número oficial:** separando por causa, a taxa de detecção nas
frases onde a transcrição preservou a pergunta original é 16/18 (~89%) — mas essa é uma régua
diferente da que o plano definiu, escolhida depois de ver o resultado. **O número que vale, porque é
o que o plano definiu antes de qualquer medição, é 75%, e ele não atingiu a meta.** Os dois casos de
falha real (#6, #8) são os que importam mais: nos dois, o sistema não só deixou de usar a ferramenta
— ele **inventou uma resposta plausível** sem checar o relógio, o comportamento exato que a fase
inteira existe para eliminar.

Nenhuma mudança foi feita no prompt, no filtro ou no código em resposta a este resultado. A decisão
de como (e se) refinar fica para uma sessão futura, deliberadamente.

---

## 5. Estado da fase

**IMPLEMENTADA, NÃO APROVADA.** Diferente da Fase 5a (que fechou com pendências documentadas mas
não-bloqueantes), aqui o critério que **define** a fase (H11) não foi atingido. Todo o resto está
sólido e verificado — plano aprovado em 6 rodadas, código aprovado com mutation testing, suíte
automatizada 76/76 sem regressão — mas a medição central, a única que responde "o sistema para de
alucinar a hora quando um usuário de verdade pergunta de um jeito natural", ficou em 75% contra uma
meta de 80%.

**Pendência única, mas bloqueante:** refinar `DETECT_TOOL_SYSTEM_PROMPT` e/ou `TIME_GATE` para
cobrir os padrões coloquiais que os dois falsos negativos reais (#6, #8) expuseram, e medir de novo
— com amostra nova, pelo mesmo motivo que a primeira teve que ser selada antes do prompt existir:
reusar a mesma amostra depois de ajustar o prompt em cima dela mediria overfitting, não cobertura.

Decisão explícita do usuário (2026-09-22): não bloquear o roteiro por causa disso — a Fase 5c começa
com esta pendência em aberto, registrada aqui em vez de escondida atrás de um "entregue" que não
seria honesto.
