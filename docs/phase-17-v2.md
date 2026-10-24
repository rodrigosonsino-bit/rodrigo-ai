# Fase 17 — O app orquestra através do Claude Code (plano v2, implementada em branch local)

Data: 2026-10-14. Substitui `docs/phase-17-v1.md`. Estado: **implementada e testada (35 + 5 testes novos, suíte verde), auditoria de
CÓDIGO ainda pendente, prova de isolamento com o `claude` real ainda NÃO rodada, nada mergeado.**

## 1. Como a v1 foi corrigida (auditoria adversarial do agy, 2026-10-14)

| # | Achado | Veredito | O que mudou |
|---|---|---|---|
| 1 | CRÍTICO — `Read/Grep/Glob` aceitam `../` e caminho absoluto: a raiz sozinha não isola; `docs/research` poderia sair | **Procede** | O processo roda dentro de um perfil `sandbox-exec` (`buildSandboxProfile`) que **nega leitura do HOME inteiro** e reabre só a raiz validada e os arquivos do próprio Claude. Provado com `cat` no teste (dentro lê, fora é negado). Com o `claude` real, só vale depois do **selftest** (`scripts/claude-code-selftest.mjs`): controle positivo + isca fora da raiz; sem o arquivo de prova o app recusa a delegação |
| 2 | CRÍTICO — `isMutation:false` perde o token; `isMutation:true` exige `write_file` | **Procede, resolvido** | A delegação é mutação (precisa de token) e o agente declara `write_file` + `shell` + `read_file` (T3). `write_file` é verdadeiro: grava o registro da tarefa no store do app. NÃO concede `network` nem `sensitive_data`. Teste de coerência declaração × política |
| 3 | ALTO — `HOME` repassado dá acesso a `~/.ssh`, `.aws` | **Procede** | Mesmo perfil do item 1 nega o HOME; ambiente do filho é lista de permissão (`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_*`) |
| 4 | ALTO — T4 só aceita campos de uma lista fechada; o plano prometia gravar ordem/raiz/hash | **Procede** | O registro T4 continua exatamente como está (ação, ferramenta, executor, classe de dado); `CLAUDE_DELEGAR` passa pelo mesmo `withAudit`. A ordem e o resultado ficam no store `claude-jobs.json`, não no registro de auditoria |
| 5 | ALTO — nomes errados (`delegateToSubAgent` etc.) | **Procede** | O ponto único é `runSubAgentDelegation`; token emitido por `recordMutationConfirmation`, consumido no `ToolSubAgent`. Plano v1 citava nomes errados |
| 6 | ALTO — `pendingAsyncStore` é do OpenClaw e não tem "interrompida" | **Procede** | Não reaproveitado. Store próprio (`JsonStore<ClaudeJob>`), `recoverInterrupted()` marca "interrompida" e nunca reexecuta |
| 7 | MÉDIO — resumo falado/Gemini poderia receber texto não confiável | **Procede e era pior** | A voz e o histórico eram dois vazamentos: o texto do Claude iria ao Gemini TTS e, depois, ao Gemini de geração via histórico. Agora: `SpeechKind 'untrusted'` força a voz do sistema; `origin:'claude'` tira a frase do histórico (`windowHistory`). Resumo é truncamento local, sem LLM |
| 8 | MÉDIO — "nenhum código escrito" falso | Artefato de tempo (o agy rodou no worktree enquanto eu editava) | — |
| 9 | MÉDIO — single-flight e cancelamento após `async_deferred` | **Procede** | O runner tem seu próprio single-flight (`current`) e `cancel()` (botão na tela) mata o grupo de processos; não depende do `AbortController` do turno. Não usa o teto de 2 assíncronas do coordenador |
| 10 | MÉDIO — testes vácuos | Parcialmente | Testes novos checam argv exato, ambiente, `shell:false`, stdin, token, single-flight, timeout. Mutação feita: remover a checagem de token reprova H17.1; trocar `shell:false` por `true` reprova H17.2 |

## 2. Decisões (Jev, 2026-10-14, uma chamada, ~1 s)

D1 escrita na v1: `noul 0,18` => **só leitura**. D2 canal para a Anthropic sem nova pergunta: `0,38` => **entregue DESLIGADO; quem liga é o
Rodrigo** (`RODRIGO_CLAUDE_CODE=1`). D3 chamada real do `claude -p` agora: `0,47` => **indeciso; não rodei**, o selftest fica para o Rodrigo
(ou para um "pode rodar" dele). D4 confirmação: `toda_chamada (1,0)`. D5 raízes: `worktree_limpo (1,0)`. D6 auditar antes: `0,75` => feita (agy, plano).

## 3. Desvios do v1, e por quê

- **Gatilho determinístico em vez de rótulo do classificador**: só no INÍCIO da fala ("pede pro Claude …", "Claude, …", "pergunta ao Claude …"), ≥ 3 palavras de ordem.
  Cobertura baixa de propósito. Nada de nuvem na detecção; a ordem só vai à Anthropic depois do "sim".
- **Sem `GET /api/capabilities`**: o app descobre o que sabe fazer por `buildCapabilitiesBlock()`, montado do registro e injetado no prompt de todos os agentes
  (texto proíbe inventar servidor/webhook). Rota pública de manifesto ficou para depois.
- **Não há `async_deferred` do coordenador**: a ferramenta responde na hora ("Pedi ao Claude. Aviso quando terminar.") e o runner avisa ao concluir
  (notificação do sistema com texto fixo + fala por `announce`, só se houver sessão ociosa).
- Fala "o que o Claude respondeu?" lê o último resultado (voz do sistema).

## 4. Para ligar (nada disto foi feito, tudo depende do Rodrigo)

```
sh scripts/setup-claude-readonly.sh           # cria .runtime/claude-readonly, sem docs/research
npm run build && node scripts/claude-code-selftest.mjs   # 2 chamadas reais; grava .runtime/claude-code-selftest.json se aprovado
RODRIGO_CLAUDE_CODE=1  (no .env)               # liga o canal
```
O `npm run doctor` avisa o que falta.

## 5. Limites conhecidos

- O isolamento com o `claude` REAL é hipótese até o selftest passar: o perfil pode precisar de mais um caminho (Keychain/Library) e o selftest revela.
- O conteúdo que o Claude lê não passa pelo guarda de saída (só a ordem passa).
- Uma tarefa por vez; timeout 10 min; saída truncada em 12 000 caracteres.
- Cobertura de intenção por voz não medida (H17.5 é do Rodrigo).

## 6. Opção C e aviso à Ogra (2026-10-24, decisão do Rodrigo no chat)

A `main` já tinha uma Fase 17 de outra sessão (`claudeCodeSubAgent.ts`, comandos `Bash,Read,Write,Edit` com `bypassPermissions` na raiz do
projeto, que contém `docs/research`). O Rodrigo escolheu **unir as duas** em vez de descartar uma:

- **Modo leitura (padrão):** gatilho determinístico "pede pro Claude …", `plan` + `Read,Grep,Glob`, raiz limpa, isolamento `sandbox-exec`.
- **Modo escrita (agente `claude_code` da main):** continua com a rota de nuvem `DELEGAR_CODIGO` e a confirmação por voz, mas agora roda **no mesmo
  isolamento**: `cwd` = worktree limpo (sem `docs/research`), perfil `sandbox-exec` que nega leitura e escrita no HOME e libera escrita **só na raiz**,
  ambiente em lista de permissão, e **não cria processo** sem a prova de isolamento (selftest). A pergunta de confirmação avisa que o Claude pode criar
  e alterar arquivos numa cópia isolada. O que ele devolver é dado não confiável (voz do sistema, fora do histórico do Gemini).
- **Aviso à Ogra (ajuste 1):** `delegationNotice.ts`. Com `RODRIGO_OGRA=1` e webhook configurado, cada tarefa (nos dois modos) avisa início e fim: pedido
  (truncado), hora, status e conclusão curta; passa pelo guarda de saída; `kind: delegation_status`, `expectsReply: false`.
- **Limites que continuam:** o modo escrita bloqueia o turno até 10 minutos (não é assíncrono como o de leitura); `sandbox-exec` não restringe rede nem
  gravação fora do HOME (ex.: `/tmp`); uma versão nova do `claude` pode exigir ajuste do perfil (o selftest revela).

## 7. Parecer do Code (24/10, `~/auditoria-code.md`) e correções A1 a A3

Veredito do Code: **NÃO MERGEAR antes de corrigir A1 a A3** (nenhum crítico). Corrigidos nesta branch (M1, M4, M5, M6 e os baixos seguem abertos, ver §8):

| Achado | Correção |
|---|---|
| **A1** modo escrita persistia fuga em `~/.claude`/`~/.claude.json*` | O filho usa **`CLAUDE_CONFIG_DIR` próprio** (`<projeto>/.runtime/claude-home`, login separado: `sh scripts/claude-code-login.sh`) e **`TMPDIR` próprio** (`.runtime/claude-tmp`). O perfil não cita mais o `~/.claude` do usuário (nem `prefix`). Resolve também M2 (transcrições de outros projetos deixam de ser legíveis; `Library/Preferences` e `Caches` saíram do perfil) |
| **A2** escrita, execução e rede livres fora do HOME | `(deny file-write*)` **global**; reabre só config própria, TMPDIR próprio, `/dev/{null,tty,dtracehelper,zero}` e, no modo escrita, a raiz. Rede: `(deny network*)` + TCP 443 + DNS. **Limite honesto:** o SBPL não filtra por domínio, então 443 para qualquer host continua possível (reduz a superfície, não elimina a exfiltração) |
| **A3** isolamento opcional (fail-open) | **Obrigatório no tipo e na construção** nos dois modos (`IsolationDeps`; `ClaudeRunnerOptions.isolation`, `ClaudeCodeSubAgent(privacy, verify, isolation, ...)`, `registerClaudeCodeAgent(coordinator, privacy, isolation, ...)`). Removidos o caminho legado, o `buildChildEnv`, o `cwd: rootDir` e o aviso `console.warn`. Os testes injetam um isolamento falso (`helpers/claudeIsolation.ts`); nenhum caminho cria processo sem sandbox, raiz limpa e prova |
| **M3** (parcial, acoplado ao perfil novo) | `SANDBOX_PROFILE_VERSION = 2`; o marcador guarda o **sha256 dos dois perfis** (leitura e escrita) e só vale com o mesmo hash. O selftest ganhou uma **parte determinística sem LLM** (13 verificações com `sandbox-exec` + `sh`: negado ler a isca, negado ler/gravar `~/.claude`, negado gravar no HOME e em `/tmp` nos dois modos; liberado raiz/config/TMPDIR) antes das 2 chamadas reais |
| **B1** TOCTOU binário/raiz (acoplado) | O spawn usa o `bin` e a `root` devolvidos pela mesma verificação de prontidão |

Estado: parte determinística do selftest **aprovada (13/13)**; a parte real depende do login do Claude na configuração própria (ainda não feito).

## 8. Ainda aberto do parecer do Code
M1 (cancel/close duplo e single-flight), M4 (conclusão do Claude indo à Ogra: enviar só metadados), M5 (órfãos no modo escrita: `detached` + grupo), M6 (raiz ancestral do HOME), B2–B6, I1–I5. Aguardam o ok do Rodrigo para entrar nesta branch.
