# Pacote de auditoria de código — Fase 17 (opção C), para o bot Code

Preparado em 2026-10-24 pelo Claude. **Não contém `docs/research/`** (material pessoal, nunca sai da máquina): o diff foi gerado com
`git diff origin/main...HEAD` e conferido (0 arquivos `docs/research`). Rodado `gitleaks` sobre este diretório.

## O que auditar
Branch `fase-17-claude-code` (commits locais; sem push, PR nem merge). Arquivo principal: `diff-vs-main.patch` (todo o diff contra a `main`, sem `docs/audits`).
Ler também, inteiros: `src/backend/agents/claudeCode.ts`, `src/backend/agents/claudeCodeSubAgent.ts`, `src/backend/agents/delegationNotice.ts`,
`src/backend/voice/sessionManager.ts` (blocos "Fase 17"), `docs/phase-17-v2.md` (plano e correções da auditoria do agy ao plano).

## Desenho em 6 linhas
1. Modo **leitura** (padrão): gatilho determinístico "pede pro Claude …" -> confirmação falada -> token de uso único -> `claude -p --permission-mode plan --tools Read,Grep,Glob`.
2. Modo **escrita** (agente `claude_code` da main, rota `DELEGAR_CODIGO`): `bypassPermissions` + `Bash,Read,Write,Edit,Glob,Grep`, agora dentro do mesmo isolamento.
3. Isolamento: raiz limpa (worktree sem `docs/research`), `sandbox-exec` que nega leitura e escrita no HOME (escrita só na raiz no modo escrita), ambiente em lista de permissão, prova (selftest) exigida.
4. Resultado do Claude = dado não confiável: voz do sistema (`SpeechKind 'untrusted'`) e fora do histórico do Gemini (`origin: 'claude'`).
5. Aviso à Ogra por webhook (`delegationNotice.ts`): pedido truncado, hora, status, conclusão curta, via guarda de saída.
6. Canal `RODRIGO_CLAUDE_CODE` desligado por padrão; só efetivo com `RODRIGO_CLOUD=1`.

## Perguntas adversariais (procure o que quebra)
- Existe caminho em que o processo `claude` nasce SEM token de confirmação, sem prova de isolamento ou fora da raiz limpa (em qualquer dos dois modos)?
- O perfil `sandbox-exec` deixa ler ou gravar algo fora da raiz (HOME, `/tmp`, `Library`)? Há TOCTOU entre `validateClaudeRoot` e o `spawn` (symlink trocado)?
- Algum segredo (`GEMINI_API_KEY`, `TYPESAFE_API_KEY`, `GROK_WEBHOOK_*`) chega ao filho? Algum texto vindo do Claude chega ao Gemini (voz, histórico, prompt) ou a AppleScript?
- O gatilho `detectClaudeDelegation` tem falso positivo perigoso ou ReDoS? A rota antiga `CLAUDE_CODE_HINT`/`DELEGAR_CODIGO` pode ser acionada sem a pergunta de confirmação?
- O aviso à Ogra pode vazar conteúdo de arquivo, abrir tarefa de resposta indevida ou derrubar uma delegação?
- Corridas: single-flight do runner, timeout, cancelamento, `onFinished` 0 ou 2 vezes, processo órfão; o modo escrita bloqueia o turno por até 10 minutos.
- Testes vácuos: algum teste novo passaria mesmo sem a proteção que diz cobrir?

## Como rodar
```bash
npm ci   # ou usar node_modules existente
npx tsc -p tsconfig.server.json && node --test dist/server/backend/__tests__/*.test.js
# só os da F17:
node --test dist/server/backend/__tests__/{claudeCode,claudeCodeFlow,claudeCodeWriteMode,delegationNotice,claudeCodeSubAgent}.test.js
```
Estado medido (2026-10-24): 979 testes, 0 falhas, 4 execuções seguidas. Mutações já conferidas: remover a checagem do token (H17.1), `shell:false` -> `true`, e o gate de prontidão do modo escrita reprovam os testes.

## Limites declarados (não são achados novos)
- Prova de isolamento com o `claude` real: aprovada em 14/10 (sem o perfil, o Claude leu um arquivo-isca fora da raiz; com o perfil, `EPERM`). **Hoje o login do `claude -p` está expirado** ("OAuth session expired"); o selftest pós-merge ainda não rodou.
- Teste por voz real: não feito. A cobertura de intenção por voz é desconhecida.
- `sandbox-exec` é obsoleto na Apple, não restringe rede nem gravação fora do HOME.
- Auditores que já viram partes: agy (só o plano v1). Kimi: não rodou. Este é o primeiro auditor do código.
