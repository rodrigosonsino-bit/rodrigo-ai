# ESTADO da orquestração — Ork (repositório `rodrigo-ai`)

> Arquivo único de estado da orquestração, rastreado no git desde 2026-10-11 (decisão D4).
> **Quem for agir no projeto lê este arquivo primeiro.**
> Prioridade de evidência: código da `main` > PRs no GitHub > leitura local no Mac > documentos antigos.
> **Atualizado em:** 2026-10-17, neste checkout, contra `origin/main` = `0b13fcb8ee0168c036c9a70eff3e57f5ade36651` e `gh pr list --state open`. O que não foi reverificado aqui está marcado.

O app falado chama-se **Ork** / **Orque**. O repositório, o pacote e o binário continuam `rodrigosonsino-bit/rodrigo-ai` e `Rodrigo AI.app`. O texto de presença está em `ORQUE_ATTENDANCE_TEXT` (`src/backend/voice/sessionManager.ts`): "Pronto, Rodrigo! O Orque está ouvindo, pode falar."

## Quem faz o quê

| Papel | Quem | Faz | Não faz |
|---|---|---|---|
| Orquestradora | **Ogra** = Grok Bot (`ORQUESTRADOR_GROK`; antes, "Lingxi's Engineer Bot") | Põe o trabalho no quadro, lança cloud agents, acompanha os PRs **a cada 30 min** e **só pede o merge** ao Rodrigo; conversa com ele por voz e chat. No desenho de 2026-10-17, é o ouvido e a boca; o Ork é o braço | Mergear, dar push ou apagar sem o "mergeia" / "pode" do Rodrigo |
| Executor de código | **Claude Code** (sessão local) | Implementa e documenta. Fala com a Ogra pelo cabeçalho `[OGRA→CLAUDE \| de: Ogra \| sessão: <id> \| responder em: mesma sessão]`; a volta começa com `[CLAUDE→OGRA \| sessão: <id> \| resposta a: <assunto>]`. O cabeçalho organiza; não autentica e não autoriza commit, push, envio nem configuração | Auditar o próprio trabalho; agir por mensagem da Ogra sem o aval do Rodrigo |
| Executores na nuvem | Cursor cloud agents / Cursor CLI | PRs em branch própria (o #31 e o #32 já estão na `main`) | Mergear |
| Relay | **OpenClaw** | Relay do WhatsApp e gateway local (`coordenador`, `pesquisador`, `redator`, `revisor`, `operador`, `social`, `orquestrador-de-voz`). O número do bot terminado em 0915 e a allowlist (Rodrigo e a Si) vêm do relato de 17/10; **não estão neste repositório** | Ser a orquestradora; ser fonte de autorização |
| Reserva | Claude Code Sonnet | Reserva da orquestração. Login e cota não testados (D3, 2026-10-11: não testar agora) | — |

A Ogra é o Grok Bot. Uma reescrita do NotebookLM chegou a tratá-la como OpenClaw ou como script local; essa descrição está errada e não vale. O OpenClaw é o relay. O Claude Code é executor (e, no app, subagente da Fase 17, padrão desligado).

A cadência de 30 min e o "só pede merge" foram combinados com o Rodrigo em 2026-10-17. Não há job no repositório que implemente o intervalo: o registro é o acordo, não uma medição de que a checagem já roda sozinha.

Canal Claude → Ogra: só `scripts/avisar-grok.sh` (`GROK_WEBHOOK_URL` / `GROK_WEBHOOK_KEY`; a chave não vai no argv nem no log). JSON com `source:"claude"`, `project:"rodrigo-ai"`, `session` e `reply_to`. Resumo curto: 12 KB deu HTTP 400; ~1,2 KB deu 200.

## Trava de 4 h

A trava de 4 h (titular `ORQUESTRADOR_GROK`, renovada em 2026-10-12 08:20 BRT, expiração 2026-10-12 12:20 BRT) **venceu e não foi renovada**. Não há titular nem lease em vigor. Se o modelo de trava continua é decisão do Rodrigo (item 8 abaixo). Na prática, a Ogra coordena.

## `main`

- `main` = `origin/main` = **`0b13fcb`** (`0b13fcb8ee0168c036c9a70eff3e57f5ade36651`), 2026-10-17 13:16 −0300, "feat(ogra): camada de voz atrás de RODRIGO_OGRA (#31)". Squash-merge do PR #31. Conferido com `git fetch origin main` e `gh pr view 31` em 2026-10-17.
- O commit imediatamente anterior é o merge do PR #32 (`4103269`, `4103269ae1cdcaa947fe80ad6471da61626181b4`, 2026-10-17 13:06 −0300, "docs: atualiza ESTADO da orquestração para 2026-10-17"). Esse texto ainda descrevia a `main` como `7d69389` e o #31 como rascunho aberto. O squash do #31 veio em seguida e deixou esse retrato para trás.
- Depois da Fase 17 (`cf16496`, 15/10) entraram direto na `main`, e os commits abaixo são ancestrais de `0b13fcb`: viva-voz (`da0a011`); visão local (`2d4dcf9`); linha `[uso]` e livro-caixa `GET /api/usage` (`25448c9`, `e93dce6`); atalho ⌘⌥R, fechar/minimizar e orquestração econômica (`5cc4133`, `c9fd597`); janela de 30 turnos e timeout de 60 min (`12671fa`); controle do Mac por voz e `DIGITAR_TEXTO` (`3ef554e`, `c2d914e`, `8d166ee`, `c16a473`); `RODRIGO_AUTO_CONFIRM` (`c8b9581`); botão Digitar (`c0858cb`); automação multi-passo e canal TTS-OSS (`f08a4c2`); PATH do Homebrew para o ffmpeg (`f4c2a00`); captura de tela nativa (`7d69389`); ESTADO de 17/10 (`7b3295c`, merge #32 `4103269`); camada Ogra (`0b13fcb`).
- Atalho global no código: `RegisterEventHotKey` com `kVK_ANSI_R` e `cmdKey | optionKey` (`desktop/main.swift`). É ⌘⌥R.
- Prazo do primeiro modelo de geração no código: `GENERATION_MODELS` em `scripts/worker/worker.py` = `gemini-flash-latest` com **10_000 ms**, depois `gemini-3.5-flash-lite` com 20_000 ms. O `CLAUDE.md` ainda diz 8 s; vale o código.
- `npm test` compila e roda só `dist/server/backend/__tests__/*.test.js`. Seis arquivos ficam de fora: `src/backend/tools/__tests__/` (5) e `src/backend/voice/__tests__/voiceSwitching.test.ts`. A suíte da `main` **não foi reexecutada** nesta atualização.

## Pull requests abertos (GitHub, 2026-10-17)

| PR | Estado | Branch | Conteúdo |
|---|---|---|---|
| #15 | rascunho | `claude/ogra-webhook-test-n3nxcu` | Plano OpenJarvis v2 e mensagem ao Grok. O texto v2.6 já está na `main` (PR #17, `746b2c3`, `docs/plans/openjarvis-voz-desktop-v2.md`). Fechar é decisão |
| #14 | rascunho | `claude/plano-jarvis-implementacao` | Plano Jarvis/NVIDIA v1. O v2.6 está na `main`. Fechar é decisão |
| #13 | rascunho | `claude/final-sessao-2026-10-12` | Fechamento da sessão do Claude Sonnet (reserva). Só histórico |
| #12 | rascunho | `claude/plano-visao-local` | Plano da visão local. O código entrou em `2d4dcf9`. Se o plano inteiro está coberto, **a confirmar** |
| #11 | rascunho | `claude/plano-fase-v-fatia5` | Plano curto da Fase V Fatia 5. `screenCloudAuthorized()` existe; o cartão já diz que a imagem só sai com autorização na fala e que `RODRIGO_CLOUD_VISION` desligado é o padrão (`src/shared/privacyText.ts`). Fechar a fatia ainda pede conferência com o plano |
| #10 | rascunho | `claude/plano-privacidade-openclaw` | Privacidade do OpenClaw v2, decisões D1–D6 (D3 = modelo). Pendente do Rodrigo |
| #8 | rascunho | `claude/fvscreen-diagnostico` | Janela de 300 ms do `fvScreen`. O PR #21, com o mesmo objetivo, já está na `main` (`fbc1966`). Se o diff é o mesmo, **a confirmar** antes de fechar |
| #7 | rascunho | `claude/affectionate-hawking-81cula` | Ressalvas da reserva sobre 12/10. Só histórico |
| #6 | aberto (não é rascunho) | `docs-decisoes-privacidade-especialistas` | D-P1/D-P2: Kimi/NVIDIA como provedor de nuvem novo. Pendente do Rodrigo |

#1 a #5, #9 e #16 a #32 estão mergeados. O #32 entrou em `4103269`. O #31 entrou por squash em `0b13fcb` (`gh pr view`: estado MERGED, 2026-10-17 13:16 −0300). Evidência dos que documentos antigos ainda tratavam como locais: seção seguinte.

### Camada Ogra — na `main`, desligada

Na `main`. `parseFlag(env, 'RODRIGO_OGRA', false)` em `src/backend/privacy.ts` e `.env.example` traz `RODRIGO_OGRA=0`. `ograEffective` olha só essa flag: não depende de `RODRIGO_CLOUD`.

Com `0`, ausente ou vazio, o turno não entra em `delegateTranscriptToOgra` (`sessionManager.ts`) e `POST /api/ogra/*` responde 404 (`handleOgraRoute` em `src/backend/voice/routes.ts`, o mesmo texto de uma rota que não existe). `registerOgraAgent` devolve null e o subagente não entra no coordenador (`voiceRuntime.ts`).

Com `1`, depois das confirmações pendentes, o texto da fala (nunca o áudio) vai ao webhook. O 2xx só confirma o envio: o Ork fala "Um momento, a Ogra está pensando." e espera `POST /api/ogra/reply` com o mesmo `taskId` e `sessionId` até `RODRIGO_OGRA_REPLY_TIMEOUT_MS` (padrão 120000). A resposta é falada no TTS do turno. Sem resposta no prazo, `RODRIGO_OGRA_FALLBACK=1` segue o caminho normal; `0` encerra. A Ogra não entra na reserva do Gemini. Mutação continua exigindo o SIM falado; o corpo `confirmationToken` / `isMutation` / `skip*` é ignorado, e a camada não honra `RODRIGO_AUTO_CONFIRM`. O contrato do callback e o desenho da fase 1 estão em `docs/orquestracao/OGRA.md`.

A espera do callback, o prazo e a resposta ignorada (token, taskId desconhecido, duplicata, atraso) estão em `src/backend/__tests__/ograLayer.test.ts`.

### Como ligar a voz da Ogra

A flag é lida na subida (`parsePrivacyConfig(process.env)` em `src/backend/index.ts` e de novo em `voiceRuntime.ts`). Qualquer valor que não seja exatamente `0` ou `1` impede a inicialização. Mudou o ambiente, sobe o processo de novo.

| Variável | O que o código exige |
|---|---|
| `RODRIGO_OGRA` | `1`. Sem isso o caminho de voz não muda. |
| `GROK_WEBHOOK_URL` | URL `http` ou `https`, não vazia (`readOgraWebhookEnv` em `ograSubAgent.ts`). Sem URL, sem chave, ou outro esquema, o turno fala "A Ogra está ligada, mas o webhook não está configurado." e não envia. |
| `GROK_WEBHOOK_KEY` | Bearer desse webhook. Não é impressa nem entra no corpo. |
| `RODRIGO_OGRA_CALLBACK_TOKEN` | Bearer de `POST /api/ogra/reply` e `POST /api/ogra/tool` (`ograCallbackAuth.ts`, comparação em tempo constante). Sem ele os dois respondem 401. A ida ao webhook ainda acontece; a volta é recusada. |
| `RODRIGO_OGRA_REPLY_TIMEOUT_MS` | Inteiro de 1000 a 600000. Padrão `120000` (`parseOgraReplyTimeoutMs` em `privacy.ts`). Vazio = padrão. Outro valor impede a inicialização. É o prazo entre o 2xx do webhook e o `POST /api/ogra/reply`. |
| `RODRIGO_OGRA_FALLBACK` | Exatamente `0` ou `1`. Padrão `1` (`parseFlag` em `privacy.ts`). Outro valor impede a inicialização, como `RODRIGO_OGRA`. Com `1`, a falha de transporte abaixo, e o silêncio depois do 2xx, não encerram o turno. Com `0`, esses casos encerram. |

### Se a Ogra ou o webhook falha, ou devolve limite

`RODRIGO_OGRA_FALLBACK=1` (padrão) faz o mesmo turno seguir o caminho de `RODRIGO_OGRA=0`: classificação, detectores locais, pergunta falada de mutação e geração no Gemini (ou o aviso de geração desligada, se `RODRIGO_CLOUD=0`). Antes disso o Ork fala "A Ogra não respondeu, vou seguir por aqui." (`OGRA_FALLBACK_NOTICE`). Vale para falha de transporte do webhook e para o prazo da resposta (`RODRIGO_OGRA_REPLY_TIMEOUT_MS`) sem `POST /api/ogra/reply`. A Ogra é chamada uma vez. Não há segunda tentativa, não há leitura de `Retry-After`, e não há laço de volta para a Ogra. `GENERATION_MODELS` em `scripts/worker/worker.py` continua `gemini-flash-latest` e depois `gemini-3.5-flash-lite`: a Ogra não entra nessa cadeia, e uma falha do Gemini não chama a Ogra.

O teste "flag ligada" em `ograLayer.test.ts` continua exigindo `classifyCalls` e `generateCalls` em zero quando o POST tem sucesso. Os testes de reserva cobrem 429, prazo, flag `0` e sucesso.

`OgraSubAgent.runTask` faz um POST, com prazo de 20 s (`WEBHOOK_TIMEOUT_MS`) e `redirect: 'manual'` (não segue redirecionamento).

Com `RODRIGO_OGRA_FALLBACK=1`, caem no caminho normal:

- HTTP fora de 2xx, inclusive 429 e 5xx (`OGRA_WEBHOOK_FAILED_TEXT` com o status).
- Prazo de 20 s do POST ou erro de rede: a mesma frase, sem o código HTTP.
- Webhook ausente (`OGRA_WEBHOOK_MISSING_TEXT`): URL, chave ou esquema inválido.
- 2xx sem `POST /api/ogra/reply` dentro de `RODRIGO_OGRA_REPLY_TIMEOUT_MS`. Antes do prazo o Ork já falou "Um momento, a Ogra está pensando."

Com `RODRIGO_OGRA_FALLBACK=0`, a falha de transporte fala a frase de falha e encerra o turno, sem classificar e sem gerar. O prazo da resposta, depois da frase de espera, encerra com "A Ogra não respondeu a tempo."

Não caem no caminho normal, com a flag em qualquer valor:

- 2xx com resposta a tempo: o Ork fala a espera e, em seguida, o `text` do callback. O turno não classifica nem gera.
- Cancelamento do turno: "Tarefa cancelada pelo usuário."
- Guarda de saída em `block`, com dado sensível: "Não enviei isso à Ogra: o texto contém um dado sensível e, pela configuração, não sai." O webhook não é chamado, e o texto não segue para o Gemini por esta reserva.
- Teto local de subagentes (`SUBAGENT_BUDGET` em `src/backend/agents/subAgent.ts`: 6 chamadas por turno, 60 s, 2 tarefas assíncronas ao mesmo tempo). Estourar fala "Não consegui terminar isso dentro do tempo/dos passos previstos..." e não cai na geração.

Mutação na reserva pede o SIM falado, mesmo com `RODRIGO_AUTO_CONFIRM=1` (`turn.fromOgraFallback` desliga a autonomia direta só nesse turno). O caminho com `RODRIGO_OGRA=0` não muda.

A frase curta (a espera, o aviso de reserva ou a falha) e o `text` do callback saem pelo TTS do turno (`synthesizeSentence` com `kind: 'local'`). Se o TTS do Gemini estiver no limite, vale o fallback que já existe nessa voz (a voz do sistema). Isso só troca a voz da frase. Não coloca a Ogra no lugar do Gemini.

### Contrato de `POST /api/ogra/reply`

O webhook não devolve a resposta. A Ogra chama de volta:

- Caminho: `POST /api/ogra/reply`
- `Authorization: Bearer <RODRIGO_OGRA_CALLBACK_TOKEN>`
- `Content-Type: application/json`
- `Host`: `127.0.0.1` ou `localhost` na porta do app. Outro host: 403.
- Corpo: `{ "taskId": "<o do webhook>", "sessionId": "<o do webhook>", "text": "<o que o Ork fala>" }`

200 `{ "ok": true }` fala o texto. 200 `{ "ok": true, "ignored": true }` é duplicata, resposta tardia ou `sessionId` que não é o da tarefa (log, sem segunda fala, sem exceção). 401 é token errado. 404 `{ "error": "Tarefa desconhecida." }` é `taskId` que não está pendente. 409 é sessão da tarefa inativa. O detalhe, inclusive o `final` opcional, está em `docs/orquestracao/OGRA.md`.

## O que o handoff de 13/10 (fonte 35) chamava de "só neste Mac"

`docs/handoff-2026-10-13-openjarvis.md` §1 descrevia branches locais sem push. A atualização no topo do próprio arquivo já registrava #18–#20; o retrato antigo (e a fonte 35 do NotebookLM) ficou para trás. Todos os merges abaixo são ancestrais de `0b13fcb`:

| O que estava "só local" | PR | Merge na `main` |
|---|---|---|
| `t1-outbound-guard` | #18 | `93f96e6` |
| `t5a-doctor` | #19 | `f72390d` |
| `t2-0-inventario-e-contrato` | #20 | `d1d0e3f` |
| handoff de 13/10 | #22 | `89861b9` |
| T6, app de barra de menus | #23 | `127b63e` |
| T2 + T9a + T3 + T5b + T4 | #24 | `9e3429f` |
| correções da auditoria do agy (T1) | #26 | `a9d415a` |
| handoff de fechamento, 14/10 | #29 | `afc7f0d` |

Também na `main`, para não reler o handoff como se ainda faltasse: #9 visão desligada por padrão (`352c307`); #17 plano v2.6 (`746b2c3`); #21 corrida do `fvScreen` (`fbc1966`); #30 ícone flutuante (`91ad44a`); #32 ESTADO de 17/10 (`4103269`); #31 camada Ogra (`0b13fcb`). A `main` atual é `0b13fcb`.

## O que está pronto

- Fases 1–12, 13a, 14 e 15 até a Fatia 4. As fases 5b, 5c e 11 fecharam como **dívida registrada**, não como aprovadas: 5b H11 75% (meta 80%); 5c H-mutação 76,5% e H-confirmação 61,1%, com zero falso SIM mantido; F11 intenção 63,0% (acionáveis 86,7%). A meta de ≥95% da F11 não foi baixada.
- Trilha OpenJarvis na `main`: T1 (guarda, padrão `redact`), T2 (política de arquivos; a lista sensível continua rascunho), T3, T4, T5a/T5b, T6 (app nativo, opção D, desvio do plano que previa a opção C), T9a. T7 (PersonaPlex) em espera. T8 tem roteiro e falta a medição.
- Fase 17, frentes 1 e 2 (`cf16496`): Claude Code como subagente, `RODRIGO_CLAUDE_CODE=0` por padrão.
- De 15 e 16/10, na `main`: ícone flutuante; viva-voz opt-in; visão local; uso por chamada; 30 turnos / 60 min; ⌘⌥R; controle do Mac por voz; `RODRIGO_AUTO_CONFIRM` (padrão 0); automação desktop (padrão 0); TTS-OSS opcional; captura de tela nativa.
- Camada Ogra, fase 1, na `main` (`0b13fcb`), atrás de `RODRIGO_OGRA=0`. Desligada, a voz não muda e `/api/ogra/*` é 404. Como ligar, e o que acontece se o webhook falha, está na seção acima. `RODRIGO_OGRA_FALLBACK` (padrão `1`) manda esse turno falho pelo caminho normal; `0` encerra. A Ogra não é reserva do Gemini.
- `RODRIGO_CLOUD_VISION` padrão **0** (`parseFlag(..., false)` e `.env.example`). O aviso deste arquivo, em 12/10, de que a visão "vem ligada por padrão" está superado.
- Fim de fala: `SILENCE_THRESHOLD_MS = 1000` em `src/frontend/voice.ts`. A junção de fragmentos no servidor foi descartada (auditoria do Codex, REFAZER) e não está no código.

## Fila (em ordem)

1. **halibut** (leitura no Mac em 2026-10-17, **não reverificada neste checkout**): quatro arquivos sem commit sobre permissão de Gravação de Tela. Decidir se viram PR.
2. **C1.** Intermitência em `f13Session`, `f11Scenarios` D.3 e `fvScreen`. Achar a causa sem alargar prazo. O #21 já entrou; o que ainda falha precisa de medição nova.
3. **C2.** Auditorias por modelo que não seja o autor: T5a, as corridas da T1 e a T6. Depois, as entregas de 16/10 (controle do desktop, `AUTO_CONFIRM`, automação), sem auditoria de código registrada. Há auditoria de plano em `docs/audits/desktop-control-automation-v2/`.
4. **Fase V.** Fechar a Fatia 5 contra o plano (o cartão e `screenCloudAuthorized()` já existem), HV.14 e o destino do #11.
5. **F15 Fatia 4b.** Decompositor multi-passo e rota de voz até o OpenClaw e os especialistas, com plano próprio. H15.3: o OpenClaw não tem API de cancelamento.
6. **F16** (conhecimento pessoal), **F13** (resto: latência e naturalidade) e **F17** (qualificação 1.0: 30 dias de uso real).
7. Fases 2+ da Ogra, documentadas em `docs/orquestracao/OGRA.md` e ainda sem código: coordenar o cursor entre editor, notas, chat de IA e WhatsApp; automação desktop pela Ogra; envio de mensagens.

## O que só o Rodrigo faz

- **A1.** Prompt do microfone e uma conversa por voz de ponta a ponta no painel (T6).
- **A2.** Confirmar que ⌘⌥R não conflita com outro app.
- **A3.** T8, baseline com voz real (`docs/t8-roteiro-baseline-voz.md`). Os limiares precisam estar aprovados antes de medir.
- **A4.** F11, medição com voz real (`docs/f11-roteiro-voz-real.md`). A meta de ≥95% permanece.
- **A5.** H13a.10: ouvir a voz Charon e dizer se ainda soa robotizada.
- **A6.** T1, egress em rede real, com o Rodrigo presente.
- **A7.** T6, uma semana de uso (atalho em ≥4 de 7 dias; `.runtime/desktop-usage.jsonl`).
- **HV.14.** 10 perguntas reais sobre a tela.

## Decisões pendentes

1. **Decisão 7 (T2).** `config/sensitive-files.json` continua RASCUNHO: `SENSITIVE_LIST_APPROVED = false` em `src/backend/fileAccessRegistry.ts`.
2. **T4.** Aprovar o marcador `applied` nos stores.
3. **#10** (D1–D6 do OpenClaw dedicado) e **#6** (D-P1/D-P2, Kimi/NVIDIA como nuvem nova).
4. Ratificar a T6 como opção D. O plano tinha aprovado só a opção C. Reverter deixou de ser realista; a ratificação formal continua **a confirmar**.
5. **F17.** D1–D6 de `docs/phase-17-v1.md` seguem "nada decidido" no plano. O código de `claudeCodeSubAgent.ts` já passa `--permission-mode bypassPermissions` e `--tools Bash,Read,Write,Edit,Glob,Grep` (comentário no arquivo: "D1 = escrita desde o início"). É divergência a ratificar. O padrão do flag continua 0.
6. Limiares da T8. T7/PersonaPlex G4 (licença). Próxima checagem mensal: **2026-11-13**.
7. Destino dos rascunhos #7, #8, #11–#15, das branches remotas `claude/*` e da limpeza de worktrees (C4). Nada disso se apaga daqui.
8. Itens abertos desde 11/10: H13a.10; D-b (confirmações que repetem ditado vão à voz Gemini, salvo `RODRIGO_TTS_DICTATED=0` ou `RODRIGO_SEND_MEMORIES=0`); aprovação nominal da busca web (`RODRIGO_WEB_SEARCH`, padrão 0); Nível 2 do Google; se a trava de 4 h volta (a revisão combinada era ~2026-10-18; o lease em si já expirou); o merge do #23/#24, que uma sessão-fork fez dizendo ter autorização — os dois **estão** na `main` (`127b63e`, `9e3429f`); falta o Rodrigo dizer se reconhece essa autorização.
9. **`RODRIGO_AUTO_CONFIRM`** (padrão 0, `c8b9581`) executa mutações não críticas sem a pergunta falada. `DESKTOP_CRITICO` e `AUTO_CORRECAO` continuam pedindo SIM. Isso tensiona a regra do SIM. Enquanto o Rodrigo não decidir, a regra do SIM vale para a camada Ogra, que não honra o flag. A automação (`RODRIGO_AUTO_DESKTOP`, padrão 0) também não pede SIM a cada passo: por isso nasce desligada, com kill switch por voz.
10. **`RODRIGO_DESKTOP_CONTROL` liga quando a variável está ausente ou em branco** (`parseDesktopControlFlag` em `src/backend/tools/desktopControlTool.ts` devolve `true`). Valor diferente de `0` ou `1` impede a inicialização. **Não há linha `RODRIGO_DESKTOP_CONTROL` no `.env.example`** (só um comentário em `RODRIGO_AUTO_DESKTOP`). Pendência de decisão e de documentação. O código não muda neste PR.

## Estado local no Mac (17/10, não reverificado aqui)

Esta atualização rodou num checkout limpo da `main` (`0b13fcb`), sem as worktrees do Mac. A linha da `main` é este checkout. As outras duas continuam a leitura de 17/10, não uma nova inspeção:

| Worktree | Branch | HEAD | Pendência relatada |
|---|---|---|---|
| principal | `main` | `0b13fcb` | Limpa neste checkout |
| `orca/.../halibut` | `merge-main-temp` | `7d69389` | 4 arquivos sem commit (permissão de Gravação de Tela). **A confirmar** com a sessão de origem |
| `orca/.../marlin` | `rodrigosonsino-bit/leia-notebook-rodrigo-ai` | `4ac3800` | Já mergeada no #30. Handoff do ícone não rastreado |
| `outputs/rodrigo-ai-wt-t6` | `handoff-2026-10-14-fechamento` | `bd24e7a` | Já mergeada no #29. Candidata à limpeza (C4), só com aval |

Não commitar nem apagar: personas do OpenClaw (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `DREAMS.md` — os cinco estão no `.gitignore`), `HANDOFF-*.md`, `.openclaw-cli-images/`. `docs/research/` continua fora do git e fora de webhook, auditor e notebook.

## NotebookLM

Notebook `803ea045-d8fb-4a59-9caa-872d91a51124`. Em 2026-10-17 a consolidação contou 72 fontes. **Não consultei o NotebookLM nesta atualização.** O gerador (`scripts/notebooklm/build_sources.py`) ainda copia o parágrafo antigo da trava de 4 h para a fonte 00; isso fica desatualizado até o próximo reenvio, e o texto que vale é este arquivo.

## O que este arquivo não afirma

Não há "35 testes funcionais em Python" medidos para este estado. Não há modelo "Claude 3.5 Sonnet" nesta orquestração: a reserva nomeada em 2026-10-11 é Claude Code Sonnet, com login e cota não testados. A suíte 739/740 deste arquivo em 12/10 está superada e não foi remedida aqui.
