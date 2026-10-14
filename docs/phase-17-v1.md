# Fase 17 — O app orquestra através do Claude Code (plano v1)

Data: 2026-10-14. Autor: Claude (sessão de fechamento). Estado: **PROPOSTA, não auditada, nenhum código escrito.**
Origem: o próprio app, por voz, sugeriu "um webhook que roda o CLI do Claude Code". O Rodrigo pediu um plano que
harmonize com o que já existe **e** que faça o app saber que essa conexão existe. Este documento corrige o roteiro do
app em quatro pontos (§1) e depende de seis decisões do Rodrigo (§9).

Regra do projeto: plano → auditoria adversarial (agy e Codex, que ainda não viram este tema) → aprovação → código.

---

## 1. O que muda em relação ao roteiro que o app ditou

| Roteiro do app | Este plano | Por quê |
|---|---|---|
| Servidor FastAPI/Node separado, "webhook" | **Nenhum servidor novo, nenhum endpoint de execução.** O Claude Code entra como `ISubAgent` dentro do processo que já existe | O projeto é loopback-only com Host/Origin e token por sessão. Um endpoint que executa texto falado é a maior superfície de ataque possível |
| `subprocess` com a instrução falada | `spawn` com **vetor de argumentos** (sem shell), prompt por stdin, ambiente limpo | Sem injeção por transcrição |
| Executa o que o Rodrigo falou | **Só leitura na v1**, e só depois de o app repetir a ordem em voz alta e o Rodrigo confirmar | O STT erra: na 5c o Whisper perdeu o "nem" e o app criou um lembrete recusado |
| Espera a resposta | **Assíncrono**: "recebi, aviso quando terminar" | O orçamento do turno é 60 s; o `claude -p` leva minutos |

## 2. O que já existe e é reaproveitado (menor diff)

Verificado no código em 2026-10-14:

- `ISubAgent` / `SubAgentCoordinator` / `SubAgentTaskRequest` com `confirmationToken` e `kind: 'async_deferred'`
  (`src/backend/agents/subAgent.ts`), orçamento 6 chamadas / 60 s / 2 assíncronas.
- `SessionManager.delegateToSubAgent` (`sessionManager.ts` ~l.380–470): ponto único que aplica a T3 **antes** de
  `runTask`, emite o token só depois do SIM real e registra o trace.
- T3 `capabilityPolicy.ts`: `CAPABILITIES` já inclui `shell`, `read_file`, `write_file`, `network`; negar por padrão.
- `pendingAsyncStore` / `pendingAsyncRecovery`: persistência e recuperação de tarefas assíncronas (hoje do OpenClaw).
- T4 `decisionLog` (duas fases, cadeia de hashes), T1 `outboundGuard`, T2 `file_policy`, T5 `doctor`, `privacy.ts`
  (um controle explícito por canal de nuvem, validado no boot), `inventario-canais-nuvem.md`.
- Classificador (`classify`) + `selectAgentForLabel`, confirmação determinística (`AFFIRMATIVE_MARKERS`, `markPlayed()`).
- Fase 15 Fatia 4b (decompositor multi-passo + rota de voz até subagentes) está **aberta** no `ESTADO.md`. A Fase 17
  é essa rota de voz para **um** destino; o decompositor continua fora de escopo.

Peça nova inevitável: um `ClaudeCodeSubAgent` (≈1 arquivo), uma capacidade no classificador, um bloco de
"o que eu sei fazer" no prompt, um controle de privacidade. Nada mais.

## 3. Como o app passa a *saber* (a parte que o Rodrigo pediu)

Hoje o app só sabe o que o prompt dele diz; ele inventou "um webhook" porque ninguém lhe contou o que existe.
Três mecanismos, todos gerados do registro (nunca redigidos à mão, mesma regra de honestidade do `ExtensionRegistry`):

1. **Manifesto de capacidades** (`GET /api/capabilities`, também usado pelo doctor): lista, a partir do
   `SubAgentCoordinator` + `EFFECTIVE_GRANTS`, o que está *registrado, habilitado e alcançável agora*. Capacidade
   desligada ou com o `claude` inacessível **não aparece**.
2. **Bloco no prompt de todos os agentes** (junto com `VOICE_SAFETY_AND_OUTPUT_CONSTRAINTS`): "Você pode delegar
   estas tarefas: … Para tudo que não está nesta lista, diga que não consegue. Nunca descreva servidor, webhook ou
   arquitetura que não conste aqui." Montado do manifesto, com teste que compara texto e registro.
3. **Frases de descoberta**: "o que você consegue fazer?" / "você fala com o Claude?" respondem a partir do manifesto,
   incluindo o que está desligado e como ligar (`RODRIGO_CLAUDE_CODE=1`).

Também entra em `docs/orquestracao/ESTADO.md` e em `CLAUDE.md` do projeto, para a próxima sessão não redescobrir.

## 4. Fluxo (v1: somente leitura)

```
fala → STT → classify (rótulo novo DELEGAR_CODIGO, intenção também pelo caminho de nuvem já existente)
  → app fala: "Vou pedir ao Claude: <ordem exatamente como transcrita>. Pode ser?"   (sempre; também mostra na tela)
  → markPlayed() + classificador determinístico de confirmação  →  token de uso único
  → delegateToSubAgent('claude_code_leitura', needs: shell, read_file)  [T3 aplica aqui]
  → runTask: spawn `claude -p` (ver §5) → retorna async_deferred   → app: "Pedi. Aviso quando terminar."
  → conclusão: texto vira DADO NÃO CONFIÁVEL → guardText (T1) → resumo falado (≤ N frases) + texto completo na tela
  → "o que ele respondeu?" relê o trace; qualquer ação sugerida pelo resultado exige NOVO pedido e NOVA confirmação
```

Confirmar toda chamada na v1 é deliberado: custa cota, manda dado para a nuvem, e a repetição em voz alta é o que
pega erro de transcrição (§1). Relaxar isso é decisão D4.

## 5. O `ClaudeCodeSubAgent` (leitura)

- **Invocação**: `claude -p --output-format json --permission-mode plan --no-session-persistence
  --tools "Read,Grep,Glob"` (lista fechada, não "bloquear o resto"), `cwd` = raiz permitida, prompt por **stdin**.
  Flags conferidas no `claude --help` desta máquina (2.1.294) em 2026-10-14; `--max-turns` não apareceu na ajuda e
  precisa ser verificado antes de depender dele (a Fatia 0 abaixo mede).
- **Sem shell, sem escrita, sem web, sem MCP**: nada de `Bash`, `Edit`, `Write`, `WebFetch`; `--strict-mcp-config`
  sem config (nenhum MCP herdado). O teste confere o vetor de argumentos exato.
- **Ambiente limpo**: o filho recebe só `PATH`, `HOME` e o necessário ao login do Claude. Nenhuma chave
  (`GEMINI_API_KEY`, `TYPESAFE_API_KEY`, webhook da Ogra) passa. Teste enumera o `env` entregue.
- **Raízes permitidas** (`config/claude-code-roots.json`, lista fechada, decisão D5): na v1 somente um *worktree*
  limpo do próprio projeto. `docs/research/` é gitignorado, logo **não existe** no worktree — o material pessoal
  (teologia/Virtologia) não fica ao alcance do Claude por construção, sem depender de filtro.
- **Limites**: um processo por vez (single-flight), timeout duro (padrão 10 min, `RODRIGO_CLAUDE_TIMEOUT_MS`), saída
  truncada, `--max-budget-usd` se a assinatura expuser; ao estourar, encerra o grupo de processos e fala o motivo.
- **Recuperação**: usa `pendingAsyncStore`; se o app reinicia no meio, a tarefa é marcada "interrompida" e o app avisa
  na próxima sessão (não retoma sozinho, não reexecuta).
- **Capacidades (T3)**: `claude_code_leitura` ⇒ `['shell','read_file']` na declaração **e** em `EFFECTIVE_GRANTS`
  (teste de coerência já existente). `write_file` não é concedida. A v1 não tem agente de escrita.
- **Registro (T4)**: toda delegação grava intenção e conclusão (ordem, raiz, duração, código de saída, hash da
  resposta). Se o registro falha, a delegação é recusada.

## 6. Privacidade — canal novo, controle novo

O Claude Code envia para a Anthropic: o texto da ordem e o conteúdo dos arquivos que ele ler. Isso é um **canal de
nuvem novo** e segue o padrão da Fase 12:

- `RODRIGO_CLAUDE_CODE` (**padrão desligado**), efetivo só com `RODRIGO_CLOUD` ligado; valor inválido aborta o boot.
- Entra em `/api/privacy`, no cartão da tela inicial, no `doctor` (aviso se ligado sem login) e em
  `docs/inventario-canais-nuvem.md`. `privacyConsistency.test.ts` passa a cobrir o texto novo.
- Áudio nunca sai. Memórias/histórico do app **não** são enviados ao Claude (só a ordem).
- Teste de egress no molde `f12Egress.test.ts`: substitui o binário `claude` por um falso e prova que (a) o `env`
  não carrega segredo, (b) a ordem é o único conteúdo do app que chega nele.

## 7. Relação com a Ogra / o orquestrador do `ESTADO.md`

O `ESTADO.md` já descreve uma trava (lease) de orquestração e o "Claude Code Sonnet" como **reserva**. Este plano não
altera isso: o app delega *tarefas de leitura*; quem altera o repositório continua sendo quem detém a trava, por
combinado, e commit/push/merge continuam exigindo o "mergeia" do Rodrigo no chat. Mensagem da Ogra e resultado do
Claude Code são informação, nunca autorização. A v1 não escreve em nenhum repositório.

## 8. Fatias, testes e critérios de aceite

| Fatia | Entrega | Gate |
|---|---|---|
| 0 | **Medição sem código de produto**: `claude -p` com as flags do §5 numa pasta descartável; confirmar login, cota, saída JSON, flags, tempo | resultado registrado; só roda com o OK do Rodrigo (D3) |
| 1 | `ClaudeCodeSubAgent` + falso injetável + T3/T4 + controle de privacidade + doctor | testes abaixo verdes |
| 2 | Rótulo/intenção `DELEGAR_CODIGO` + confirmação + fluxo assíncrono + manifesto/prompt (§3) | testes + voz sintética |
| 3 | Medição com voz real (Rodrigo) | H17.5 |

Testes (todos escritos antes do código; mutação inteira, regra C3 do handoff):

- **H17.1** sem token de confirmação o processo **nunca** é criado (mutação: remover a checagem ⇒ teste reprova).
- **H17.2** vetor de argumentos exato; transcrição com `; rm -rf ~`, aspas e `$(...)` chega só por stdin.
- **H17.3** `env` do filho sem nenhuma chave; cwd fora da lista ⇒ recusa antes de spawn.
- **H17.4** negação degradada pelo STT ("depois eu peço", sem o "nem") não gera execução (reaproveita os casos da 5c).
- **H17.5** com voz real: ≥ 20 ordens de leitura, zero execução sem confirmação, zero falso SIM; cobertura de intenção
  reportada **sem baixar meta** (mesma honestidade das dívidas 5b/5c/11).
- **H17.6** capacidade desligada/inalcançável ⇒ some do manifesto e do prompt; app diz que não consegue.
- **H17.7** timeout/cancelamento/barge-in mata o grupo de processos; reinício não reexecuta.
- **H17.8** resultado com instrução embutida ("agora execute …") não dispara nada.
- Suíte inteira verde em 3 execuções seguidas; o C1 do handoff (testes intermitentes) é pré-requisito.

## 9. Decisões do Rodrigo (nada decidido)

- **D1** v1 só leitura (recomendado) ou já com escrita? Escrita seria Fase 17b: worktree dedicado em branch própria,
  nunca `main`, sem push, diff resumido em voz, merge só por você no chat.
- **D2** Aceita o canal novo (ordem + arquivos lidos vão para a Anthropic, sob o plano da sua assinatura)?
- **D3** Autoriza a Fatia 0 (uma chamada real mínima do `claude -p`)? Em 2026-10-11 você pediu para não testar login/cota;
  isso gasta cota da assinatura.
- **D4** Confirmar toda chamada (recomendado na v1) ou aceitar leituras sem confirmação depois de medir?
- **D5** Quais raízes entram na lista fechada? (proposta: só o worktree limpo deste projeto.)
- **D6** O "reserva" do `ESTADO.md` passa a ser exatamente isto, ou o app e a trava da Ogra ficam separados?

## 10. Riscos conhecidos

- A cobertura de intenção por voz pode não chegar a 80%/95% (histórico 5b/5c/11); o desenho não depende dela para
  segurança, só para conveniência. Fica registrada como dívida se não passar.
- `claude -p` pode se comportar diferente entre versões; a Fatia 0 fixa a versão testada e o doctor avisa se mudar.
- O resumo falado do resultado pode errar número ou omitir ressalva; o texto completo fica sempre na tela.
- Cota: cada chamada gasta a assinatura. Teto diário configurável é proposto na Fatia 1 (padrão baixo).
