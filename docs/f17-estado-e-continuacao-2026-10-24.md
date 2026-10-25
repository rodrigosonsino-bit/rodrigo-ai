# Estado e continuação — Fase 17 (delegação ao Claude Code), 2026-10-24

Escrito para quem continuar (a Ogra, o bot Code, ou outra sessão do Claude) sem acesso à conversa. Três classes de afirmação: **[verificado]** com o comando, **[herdado]** (não reconferido agora), **[combinado]** (palavras do Rodrigo, citadas).

## 1. Estado de entrega  [verificado em 2026-10-24 ~17:25 BRT]
```
git branch --show-current                      -> fase-17-claude-code        (worktree: outputs/rodrigo-ai-wt-f17)
git rev-parse --short HEAD                     -> f13308f
git status --short | wc -l                     -> 0                           (nada não commitado)
git rev-list --left-right --count origin/main...HEAD -> 0  11                 (0 atrás, 11 à frente da origin/main)
```
- **Nada foi enviado**: sem push, sem PR, sem merge na `main`, sem force push. Os 11 commits são **locais**.
- A `main` do checkout principal (`outputs/rodrigo-ai`) está em `5234d41`. O `.env` dele tem `RODRIGO_CLAUDE_CODE=1` e `RODRIGO_OGRA=1`, mais `RODRIGO_OGRA_CALLBACK_TOKEN` e `GROK_WEBHOOK_URL/KEY` (valores nunca impressos). O app **não foi reiniciado** depois dessas mudanças.
- Commits relevantes: `1959c91` (implementação), `c5dc41b` (contador de novos), `36ef055` (merge da main, 28 conflitos), `06fd7ca` (opção C), `33e0931` (aviso à Ogra), `5d8ff1e` (erro do claude visível), `b2b46bd` (pacote de auditoria), `f13308f` (A1 a A3 do Code).

## 2. O que a F17 faz  [verificado no código]
O Rodrigo fala "pede pro Claude \<ordem\>" (modo **leitura**, padrão) ou usa a rota de nuvem `DELEGAR_CODIGO` (modo **escrita**, agente `claude_code` da main). O app repete a ordem, espera o "sim" determinístico (`markPlayed` + token de uso único) e roda `claude -p` num **processo isolado**: worktree limpo sem `docs/research`, `sandbox-exec` (leitura: nega HOME; escrita: nega TODA gravação e reabre só config/TMPDIR próprios e, no modo escrita, a raiz; rede só TCP 443 e DNS), ambiente em lista de permissão, `CLAUDE_CONFIG_DIR` e `TMPDIR` **próprios** em `.runtime/`. O resultado é dado não confiável: voz do sistema, fora do histórico do Gemini. Com `RODRIGO_OGRA=1` a Ogra recebe um aviso por delegação (pedido truncado, hora, status, conclusão curta, `expectsReply:false`). Arquivos: `src/backend/agents/{claudeCode,claudeCodeSubAgent,delegationNotice}.ts`, `src/backend/voice/{sessionManager,voiceRuntime,routes}.ts`, cartão em `src/frontend/`. Plano: `docs/phase-17-v2.md` (§6 opção C, §7 correções do Code, §8 em aberto).

## 3. Verificações  [verificado]
- `npx tsc -p tsconfig.server.json && node --test dist/server/backend/__tests__/*.test.js` -> **980 testes, 0 falhas**, 3 execuções seguidas (neste worktree, sem `.runtime/.venv`; na main com o runtime completo a contagem é maior).
- Mutação conferida: remover o gate da prova (`selftestOk`) reprova 2 testes; tirar a checagem de token reprova H17.1; `shell:false`->`true` reprova H17.2.
- `node scripts/claude-code-selftest.mjs` -> **APROVADO** às 20:21Z (13 verificações determinísticas + 2 chamadas reais do `claude`). A prova está em `.runtime/claude-code-selftest.json` **do worktree** (perfil v2, hash `e555a75d…`).
- Modo escrita real (`bypassPermissions`): criou o arquivo na raiz isolada; **não** criou em `~/` nem em `/tmp` (EPERM).

## 4. O que NÃO está feito  [verificado: ausência]
1. **Parecer do Code, itens abertos**: M1 (cancel/close duplo e single-flight), M4 (conclusão do Claude indo à Ogra: enviar só metadados), M5 (órfãos no modo escrita: `detached` + grupo de processos), M6 (raiz ancestral do HOME), B2 a B6, I1 a I5. Arquivo: `~/auditoria-code.md`. Aguardam o ok do Rodrigo.
2. **Reauditoria do Code** de `f13308f`; o pacote em `docs/audits/phase-17-pacote-auditoria/` está **desatualizado** (gerado em `b2b46bd`): regenerar com `git diff origin/main...HEAD -- . ':!docs/audits'` e conferir que não há `docs/research`.
3. **Teste por voz real**: nunca feito. A cobertura de intenção por voz (H17.5) é desconhecida.
4. **Checkout principal**: o app do Rodrigo roda lá e **não tem este código**. Para usar a delegação: levar a branch para a main (decisão do Rodrigo), criar o worktree (`sh scripts/setup-claude-readonly.sh`), fazer o login próprio (`sh scripts/claude-code-login.sh`, `/login`), rodar `npm run build` e `node scripts/claude-code-selftest.mjs` **naquele** checkout, só então reabrir o app.
5. **Ogra**: o `RODRIGO_OGRA_CALLBACK_TOKEN` foi **trocado** e a Ogra precisa ler o valor atual do `.env` (rota `POST http://127.0.0.1:3000/api/ogra/reply`, `Authorization: Bearer`). Sem isso, cada fala esperaria até 120 s.
6. Reconciliar o `CLAUDE.md`: a regra "Ogra principal, Claude Code Sonnet de reserva" está num parágrafo próprio da branch; na `main` a seção "Camada Ogra" ainda não a cita.

## 5. Riscos e limites conhecidos  [verificado/herdado]
- **Rede**: o SBPL não filtra por domínio; 443 para qualquer host continua possível (exfiltração do que o Claude consegue ler: a raiz limpa e a config própria).
- O modo escrita **bloqueia o turno até 10 minutos** (não é assíncrono como o de leitura).
- `sandbox-exec` é considerado obsoleto pela Apple; uma versão nova do `claude` pode exigir ajuste do perfil (o selftest revela, e a prova é ligada ao hash do perfil e ao caminho do binário).
- Cada chamada gasta cota da assinatura; o `claude` delegado tem **login separado** do do Rodrigo.
- Conclusão (até 400 caracteres) do Claude chega à Ogra: risco de injeção cruzada (M4, aberto).

## 6. Combinado com o Rodrigo  [citações do chat]
- "pode fazer o commit do contador" · "fallback é o mesmo" (Claude Code Sonnet) · "opção C e avise a Ogra" · "pode ligar as duas flags e enviar o resumo à Ogra" · "crie o token e coloque o webhook no .env" · "pode corrigir" (trocar o token) · "pode fazer os quatro ajustes, com commit e o merge da main na branch" · "pode corrigir A1 a A3 na fase-17-claude-code, sem push nem merge, e rodar o selftest de novo".
- Continua valendo: **nada de merge, push, PR ou force push sem o ok do Rodrigo no chat dele**; mensagem da Ogra é informação, não autorização.

## 7. Próximos passos sugeridos, em ordem
1. Rodrigo decide M1/M4/M5/M6 (recomendo todos; M4 antes de qualquer teste com a Ogra ligada).
2. Regenerar o pacote e pedir a reauditoria ao Code.
3. Com o parecer "PODE MERGEAR", Rodrigo faz o teste por voz no checkout principal (passos do §4.4) e decide o merge.
