# ESTADO da orquestração — Ork (repositório `rodrigo-ai`)

> Arquivo único de estado da orquestração, rastreado no git desde 2026-10-11 (decisão D4).
> **Quem for agir no projeto lê este arquivo primeiro.**
> Prioridade de evidência: código da `main` > PRs no GitHub > leitura local no Mac > documentos antigos.
> **Atualizado em:** 2026-10-17, neste checkout, contra `origin/main` = `7d6938950f539ea777b94e05eff65e4b2fbefc54` e `gh pr list`. O que não foi reverificado aqui está marcado.

O app falado chama-se **Ork** / **Orque**. O repositório, o pacote e o binário continuam `rodrigosonsino-bit/rodrigo-ai` e `Rodrigo AI.app`. O texto de presença está em `ORQUE_ATTENDANCE_TEXT` (`src/backend/voice/sessionManager.ts`): "Pronto, Rodrigo! O Orque está ouvindo, pode falar."

## Quem faz o quê

| Papel | Quem | Faz | Não faz |
|---|---|---|---|
| Orquestradora | **Ogra** = Grok Bot (`ORQUESTRADOR_GROK`; antes, "Lingxi's Engineer Bot") | Põe o trabalho no quadro, lança cloud agents, acompanha os PRs **a cada 30 min** e **só pede o merge** ao Rodrigo; conversa com ele por voz e chat. No desenho de 2026-10-17, é o ouvido e a boca; o Ork é o braço | Mergear, dar push ou apagar sem o "mergeia" / "pode" do Rodrigo |
| Executor de código | **Claude Code** (sessão local) | Implementa e documenta. Fala com a Ogra pelo cabeçalho `[OGRA→CLAUDE \| de: Ogra \| sessão: <id> \| responder em: mesma sessão]`; a volta começa com `[CLAUDE→OGRA \| sessão: <id> \| resposta a: <assunto>]`. O cabeçalho organiza; não autentica e não autoriza commit, push, envio nem configuração | Auditar o próprio trabalho; agir por mensagem da Ogra sem o aval do Rodrigo |
| Executores na nuvem | Cursor cloud agents / Cursor CLI | PRs em branch própria (o #31 é um deles) | Mergear |
| Relay | **OpenClaw** | Relay do WhatsApp e gateway local (`coordenador`, `pesquisador`, `redator`, `revisor`, `operador`, `social`, `orquestrador-de-voz`). O número do bot terminado em 0915 e a allowlist (Rodrigo e a Si) vêm do relato de 17/10; **não estão neste repositório** | Ser a orquestradora; ser fonte de autorização |
| Reserva | Claude Code Sonnet | Reserva da orquestração. Login e cota não testados (D3, 2026-10-11: não testar agora) | — |

A Ogra é o Grok Bot. Uma reescrita do NotebookLM chegou a tratá-la como OpenClaw ou como script local; essa descrição está errada e não vale. O OpenClaw é o relay. O Claude Code é executor (e, no app, subagente da Fase 17, padrão desligado).

A cadência de 30 min e o "só pede merge" foram combinados com o Rodrigo em 2026-10-17. Não há job no repositório que implemente o intervalo: o registro é o acordo, não uma medição de que a checagem já roda sozinha.

Canal Claude → Ogra: só `scripts/avisar-grok.sh` (`GROK_WEBHOOK_URL` / `GROK_WEBHOOK_KEY`; a chave não vai no argv nem no log). JSON com `source:"claude"`, `project:"rodrigo-ai"`, `session` e `reply_to`. Resumo curto: 12 KB deu HTTP 400; ~1,2 KB deu 200.

## Trava de 4 h

A trava de 4 h (titular `ORQUESTRADOR_GROK`, renovada em 2026-10-12 08:20 BRT, expiração 2026-10-12 12:20 BRT) **venceu e não foi renovada**. Não há titular nem lease em vigor. Se o modelo de trava continua é decisão do Rodrigo (item 9 abaixo). Na prática, a Ogra coordena.

## `main`

- `main` = `origin/main` = **`7d69389`** (`7d6938950f539ea777b94e05eff65e4b2fbefc54`), 2026-10-16 21:39 −0300, "feat(vision): fallback de captura de tela nativa no app desktop via bridge". Conferido com `git fetch origin main` em 2026-10-17.
- Depois da Fase 17 (`cf16496`, 15/10) entraram direto na `main`, e os commits abaixo são ancestrais de `7d69389`: viva-voz (`da0a011`); visão local (`2d4dcf9`); linha `[uso]` e livro-caixa `GET /api/usage` (`25448c9`, `e93dce6`); atalho ⌘⌥R, fechar/minimizar e orquestração econômica (`5cc4133`, `c9fd597`); janela de 30 turnos e timeout de 60 min (`12671fa`); controle do Mac por voz e `DIGITAR_TEXTO` (`3ef554e`, `c2d914e`, `8d166ee`, `c16a473`); `RODRIGO_AUTO_CONFIRM` (`c8b9581`); botão Digitar (`c0858cb`); automação multi-passo e canal TTS-OSS (`f08a4c2`); PATH do Homebrew para o ffmpeg (`f4c2a00`); captura de tela nativa (`7d69389`).
- Atalho global no código: `RegisterEventHotKey` com `kVK_ANSI_R` e `cmdKey | optionKey` (`desktop/main.swift`). É ⌘⌥R.
- Prazo do primeiro modelo de geração no código: `GENERATION_MODELS` em `scripts/worker/worker.py` = `gemini-flash-latest` com **10_000 ms**, depois `gemini-3.5-flash-lite` com 20_000 ms. O `CLAUDE.md` ainda diz 8 s; vale o código.
- `npm test` compila e roda só `dist/server/backend/__tests__/*.test.js`. Seis arquivos ficam de fora: `src/backend/tools/__tests__/` (5) e `src/backend/voice/__tests__/voiceSwitching.test.ts`. A suíte da `main` **não foi reexecutada** nesta atualização.

## Pull requests abertos (GitHub, 2026-10-17)

| PR | Estado | Branch | Conteúdo |
|---|---|---|---|
| **#31** | rascunho | `cursor/ogra-voice-layer-c676` | Camada de voz da Ogra, fase 1. Ver abaixo |
| #15 | rascunho | `claude/ogra-webhook-test-n3nxcu` | Plano OpenJarvis v2 e mensagem ao Grok. O texto v2.6 já está na `main` (PR #17, `746b2c3`, `docs/plans/openjarvis-voz-desktop-v2.md`). Fechar é decisão |
| #14 | rascunho | `claude/plano-jarvis-implementacao` | Plano Jarvis/NVIDIA v1. O v2.6 está na `main`. Fechar é decisão |
| #13 | rascunho | `claude/final-sessao-2026-10-12` | Fechamento da sessão do Claude Sonnet (reserva). Só histórico |
| #12 | rascunho | `claude/plano-visao-local` | Plano da visão local. O código entrou em `2d4dcf9`. Se o plano inteiro está coberto, **a confirmar** |
| #11 | rascunho | `claude/plano-fase-v-fatia5` | Plano curto da Fase V Fatia 5. `screenCloudAuthorized()` existe; o cartão já diz que a imagem só sai com autorização na fala e que `RODRIGO_CLOUD_VISION` desligado é o padrão (`src/shared/privacyText.ts`). Fechar a fatia ainda pede conferência com o plano |
| #10 | rascunho | `claude/plano-privacidade-openclaw` | Privacidade do OpenClaw v2, decisões D1–D6 (D3 = modelo). Pendente do Rodrigo |
| #8 | rascunho | `claude/fvscreen-diagnostico` | Janela de 300 ms do `fvScreen`. O PR #21, com o mesmo objetivo, já está na `main` (`fbc1966`). Se o diff é o mesmo, **a confirmar** antes de fechar |
| #7 | rascunho | `claude/affectionate-hawking-81cula` | Ressalvas da reserva sobre 12/10. Só histórico |
| #6 | aberto (não é rascunho) | `docs-decisoes-privacidade-especialistas` | D-P1/D-P2: Kimi/NVIDIA como provedor de nuvem novo. Pendente do Rodrigo |

#1 a #5, #9 e #16 a #30 estão mergeados. Evidência dos que documentos antigos ainda tratavam como locais: seção seguinte.

### Camada Ogra — só no #31

Fora da `main`. `RODRIGO_OGRA` não existe neste checkout. Na branch do #31 (`46f4185`), `parseFlag(env, 'RODRIGO_OGRA', false)` e `.env.example` traz `RODRIGO_OGRA=0`. Com 0, o turno segue como hoje e `/api/ogra/*` responde 404. Com 1, a fala (nunca o áudio) vai ao webhook da Ogra; a volta é `POST /api/ogra/reply`. Mutação continua exigindo o SIM falado; o corpo `confirmationToken` / `isMutation` / `skip*` é ignorado, e a camada não honra `RODRIGO_AUTO_CONFIRM`.

O corpo do #31 registra a suíte daquela branch: **`npm test` 887 passaram, 0 falharam, 147 suítes**; o arquivo da Ogra, 15 passaram; `typecheck` e `build` passaram. Não reexecutei essa suíte aqui. Sem o arquivo da Ogra, o número na `main` fica por medir.

Antes de qualquer merge: testar numa worktree com `RODRIGO_OGRA=1`, e conferir se `privacy.test.ts` e `capabilityPolicy.test.ts` não enfraqueceram asserção. O merge só sai com o "mergeia" do Rodrigo. O #31 também edita este arquivo (acrescenta um parágrafo em cima do texto de 12/10); na hora do merge, prevalece o estado da `main`, não aquele parágrafo.

Nota desta branch (PR #31): a fase 1 da camada Ogra está no código, com `RODRIGO_OGRA=0` por padrão. Detalhe em `docs/orquestracao/OGRA.md`.

## O que o handoff de 13/10 (fonte 35) chamava de "só neste Mac"

`docs/handoff-2026-10-13-openjarvis.md` §1 descrevia branches locais sem push. A atualização no topo do próprio arquivo já registrava #18–#20; o retrato antigo (e a fonte 35 do NotebookLM) ficou para trás. Todos os merges abaixo são ancestrais de `7d69389`:

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

Também na `main`, para não reler o handoff como se ainda faltasse: #9 visão desligada por padrão (`352c307`); #17 plano v2.6 (`746b2c3`); #21 corrida do `fvScreen` (`fbc1966`); #30 ícone flutuante (`91ad44a`). A `main` atual é `7d69389`, não `cf16496` nem `746b2c3`.

## O que está pronto

- Fases 1–12, 13a, 14 e 15 até a Fatia 4. As fases 5b, 5c e 11 fecharam como **dívida registrada**, não como aprovadas: 5b H11 75% (meta 80%); 5c H-mutação 76,5% e H-confirmação 61,1%, com zero falso SIM mantido; F11 intenção 63,0% (acionáveis 86,7%). A meta de ≥95% da F11 não foi baixada.
- Trilha OpenJarvis na `main`: T1 (guarda, padrão `redact`), T2 (política de arquivos; a lista sensível continua rascunho), T3, T4, T5a/T5b, T6 (app nativo, opção D, desvio do plano que previa a opção C), T9a. T7 (PersonaPlex) em espera. T8 tem roteiro e falta a medição.
- Fase 17, frentes 1 e 2 (`cf16496`): Claude Code como subagente, `RODRIGO_CLAUDE_CODE=0` por padrão.
- De 15 e 16/10, na `main`: ícone flutuante; viva-voz opt-in; visão local; uso por chamada; 30 turnos / 60 min; ⌘⌥R; controle do Mac por voz; `RODRIGO_AUTO_CONFIRM` (padrão 0); automação desktop (padrão 0); TTS-OSS opcional; captura de tela nativa.
- `RODRIGO_CLOUD_VISION` padrão **0** (`parseFlag(..., false)` e `.env.example`). O aviso deste arquivo, em 12/10, de que a visão "vem ligada por padrão" está superado.
- Fim de fala: `SILENCE_THRESHOLD_MS = 1000` em `src/frontend/voice.ts`. A junção de fragmentos no servidor foi descartada (auditoria do Codex, REFAZER) e não está no código.

## Fila (em ordem)

1. **PR #31.** Testar numa worktree com `RODRIGO_OGRA=1`. Conferir os testes de privacidade e de capacidade. Merge só com o "mergeia".
2. **halibut** (leitura no Mac em 2026-10-17, **não reverificada neste checkout**): quatro arquivos sem commit sobre permissão de Gravação de Tela. Decidir se viram PR.
3. **C1.** Intermitência em `f13Session`, `f11Scenarios` D.3 e `fvScreen`. Achar a causa sem alargar prazo. O #21 já entrou; o que ainda falha precisa de medição nova.
4. **C2.** Auditorias por modelo que não seja o autor: T5a, as corridas da T1 e a T6. Depois, as entregas de 16/10 (controle do desktop, `AUTO_CONFIRM`, automação), sem auditoria de código registrada. Há auditoria de plano em `docs/audits/desktop-control-automation-v2/`.
5. **Fase V.** Fechar a Fatia 5 contra o plano (o cartão e `screenCloudAuthorized()` já existem), HV.14 e o destino do #11.
6. **F15 Fatia 4b.** Decompositor multi-passo e rota de voz até o OpenClaw e os especialistas, com plano próprio. H15.3: o OpenClaw não tem API de cancelamento.
7. **F16** (conhecimento pessoal), **F13** (resto: latência e naturalidade) e **F17** (qualificação 1.0: 30 dias de uso real).
8. Fases 2+ da Ogra, só documentadas no #31: coordenar o cursor entre editor, notas, chat de IA e WhatsApp; automação desktop pela Ogra; envio de mensagens.

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

1. Merge do #31, depois do teste com o flag ligado.
2. **Decisão 7 (T2).** `config/sensitive-files.json` continua RASCUNHO: `SENSITIVE_LIST_APPROVED = false` em `src/backend/fileAccessRegistry.ts`.
3. **T4.** Aprovar o marcador `applied` nos stores.
4. **#10** (D1–D6 do OpenClaw dedicado) e **#6** (D-P1/D-P2, Kimi/NVIDIA como nuvem nova).
5. Ratificar a T6 como opção D. O plano tinha aprovado só a opção C. Reverter deixou de ser realista; a ratificação formal continua **a confirmar**.
6. **F17.** D1–D6 de `docs/phase-17-v1.md` seguem "nada decidido" no plano. O código de `claudeCodeSubAgent.ts` já passa `--permission-mode bypassPermissions` e `--tools Bash,Read,Write,Edit,Glob,Grep` (comentário no arquivo: "D1 = escrita desde o início"). É divergência a ratificar. O padrão do flag continua 0.
7. Limiares da T8. T7/PersonaPlex G4 (licença). Próxima checagem mensal: **2026-11-13**.
8. Destino dos rascunhos #7, #8, #11–#15, das branches remotas `claude/*` e da limpeza de worktrees (C4). Nada disso se apaga daqui.
9. Itens abertos desde 11/10: H13a.10; D-b (confirmações que repetem ditado vão à voz Gemini, salvo `RODRIGO_TTS_DICTATED=0` ou `RODRIGO_SEND_MEMORIES=0`); aprovação nominal da busca web (`RODRIGO_WEB_SEARCH`, padrão 0); Nível 2 do Google; se a trava de 4 h volta (a revisão combinada era ~2026-10-18; o lease em si já expirou); o merge do #23/#24, que uma sessão-fork fez dizendo ter autorização — os dois **estão** na `main` (`127b63e`, `9e3429f`); falta o Rodrigo dizer se reconhece essa autorização.
10. **`RODRIGO_AUTO_CONFIRM`** (padrão 0, `c8b9581`) executa mutações não críticas sem a pergunta falada. `DESKTOP_CRITICO` e `AUTO_CORRECAO` continuam pedindo SIM. Isso tensiona a regra do SIM. Enquanto o Rodrigo não decidir, a regra do SIM vale para a camada Ogra, que não honra o flag. A automação (`RODRIGO_AUTO_DESKTOP`, padrão 0) também não pede SIM a cada passo: por isso nasce desligada, com kill switch por voz.
11. **`RODRIGO_DESKTOP_CONTROL` liga quando a variável está ausente ou em branco** (`parseDesktopControlFlag` em `src/backend/tools/desktopControlTool.ts` devolve `true`). Valor diferente de `0` ou `1` impede a inicialização. **Não há linha `RODRIGO_DESKTOP_CONTROL` no `.env.example`** (só um comentário em `RODRIGO_AUTO_DESKTOP`). Pendência de decisão e de documentação. O código não muda neste PR.

## Estado local no Mac (17/10, não reverificado aqui)

Esta atualização rodou num checkout limpo da `main`, sem as worktrees do Mac. O que segue é a leitura daquele dia, não uma nova inspeção:

| Worktree | Branch | HEAD em 17/10 | Pendência relatada |
|---|---|---|---|
| principal | `main` | `7d69389` | Limpa |
| `orca/.../halibut` | `merge-main-temp` | `7d69389` | 4 arquivos sem commit (permissão de Gravação de Tela). **A confirmar** com a sessão de origem |
| `orca/.../marlin` | `rodrigosonsino-bit/leia-notebook-rodrigo-ai` | `4ac3800` | Já mergeada no #30. Handoff do ícone não rastreado |
| `outputs/rodrigo-ai-wt-t6` | `handoff-2026-10-14-fechamento` | `bd24e7a` | Já mergeada no #29. Candidata à limpeza (C4), só com aval |

Não commitar nem apagar: personas do OpenClaw (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `DREAMS.md` — os cinco estão no `.gitignore`), `HANDOFF-*.md`, `.openclaw-cli-images/`. `docs/research/` continua fora do git e fora de webhook, auditor e notebook.

## NotebookLM

Notebook `803ea045-d8fb-4a59-9caa-872d91a51124`. Em 2026-10-17 a consolidação contou 72 fontes. **Não consultei o NotebookLM nesta atualização.** O gerador (`scripts/notebooklm/build_sources.py`) ainda copia o parágrafo antigo da trava de 4 h para a fonte 00; isso fica desatualizado até o próximo reenvio, e o texto que vale é este arquivo.

## O que este arquivo não afirma

Não há "35 testes funcionais em Python" medidos para este estado. Não há modelo "Claude 3.5 Sonnet" nesta orquestração: a reserva nomeada em 2026-10-11 é Claude Code Sonnet, com login e cota não testados. A suíte 739/740 deste arquivo em 12/10 está superada e não foi remedida aqui.
