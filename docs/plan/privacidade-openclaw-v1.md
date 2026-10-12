# Plano — Fatia de privacidade do OpenClaw (v1)

> Estado: **PROPOSTA para revisão e auditoria. Sem código neste PR.** Nenhum código antes do aval do Rodrigo e de uma auditoria de outra família de modelo (item 5 do parecer).
> Autor: Claude Sonnet (reserva do orquestrador), 2026-10-12, a pedido do ORQUESTRADOR_GROK. Base: `origin/main` em `ccf03ca`.
> Origem: itens 1 e 2 de `docs/orquestracao/revisoes/2026-10-12-ressalvas-claude-sonnet.md` (PR #7).

## 1. Correção ao meu parecer (leia primeiro)

O item 1 do parecer dizia que o cartão de privacidade estava incompleto "hoje". Ao ler o código para este plano, a situação é mais estreita:

- **Fato (verificado em código):** o app só fala com o OpenClaw pelo `OpenClawSubAgent`, e a única capacidade ligada (`wired: true`) é `openclaw_web` (`src/backend/agents/openClawCapabilities.ts`). Ela só executa se `webSearchEffective(cfg)`, isto é, `RODRIGO_CLOUD=1` **e** `RODRIGO_WEB_SEARCH=1` (padrão `0`), e só existe cliente HTTP se `RODRIGO_OPENCLAW_GATEWAY_TOKEN` estiver definido (`makeOpenClawHttpClient` devolve `null` sem token).
- **Fato (verificado em código):** nenhum código de produção origina uma delegação a `openclaw_web` a partir da voz: `runSubAgentDelegation` só é chamado com ids de ferramentas locais (`tool_<nome>`, `sessionManager.ts:450`), e `pendingAsyncRecovery` só retoma tarefas persistidas, que não existem enquanto nada as cria. A rota de voz até o OpenClaw é a **Fatia 4b**, ainda não feita (`ESTADO.md`).
- **Conclusão:** com os padrões atuais, **nada sai para o OpenClaw**. O risco do item 1 é **latente**: ele passa a ser real quando a Fatia 4b ligar a rota e o Rodrigo ligar o canal. Por isso esta fatia deve vir **antes** da 4b, e é barata agora.
- O que continua verdadeiro: o cartão (`privacyText.ts`) e o README §7 dizem "pode sair via OpenClaw" mas **não dizem para quem o OpenClaw envia** (hoje, por configuração do Mac, `nvidia/moonshotai/kimi-k3`, segundo `ESTADO.md`; não verificado por mim), e o conteúdo enviado não tem contrato escrito.

## 2. Objetivo

Antes de a Fatia 4b ligar a rota de voz, garantir que (a) o que pode ir ao OpenClaw e a quem ele o repassa estejam **declarados** na tela e no README, (b) o conteúdo enviado tenha um **contrato mínimo** testado, (c) agente e modelo sejam **fixados**, não herdados do padrão do gateway, e (d) `docs/research/` não possa chegar a um modelo de nuvem pelo caminho do OpenClaw.

## 3. Fatos que o plano usa

Verificados em código (`origin/main`):
1. `openClawHttpClient.ts`: faz `POST {baseUrl}/v1/chat/completions` com `{"messages":[{"role":"user","content":<prompt>}]}`. **Não envia `model` nem identificador de agente.** O padrão de `baseUrl` é `http://127.0.0.1:18789`.
2. `OpenClawSubAgent.execute`: bloqueia `openclaw_web` sem `webSearchEffective`; mutações exigem `confirmationToken` do turno.
3. `privacyText.ts`: a única menção ao OpenClaw é a frase da busca web; não há provedor nomeado. `workerPrivacyEnv` não envolve o OpenClaw (ele é chamado pelo Node, não pelo worker).
4. `privacy.ts`: não há declaração de provedores externos além do Gemini; o README §7 afirma "não há fallback para outro provedor".

**Não verificados (só o Grok/Rodrigo, no Mac):**
- como o gateway escolhe o agente/modelo de uma chamada sem `model` (agente padrão? campo `model` no estilo OpenAI?);
- qual modelo o agente padrão usa hoje, e se o gateway grava os prompts;
- se os agentes OpenClaw têm ferramentas de arquivo que leem `docs/research/` no disco do Mac (ver risco R1).

## 4. Decisões que são do Rodrigo

| # | Decisão | Minha recomendação |
|---|---|---|
| D1 | O que um agente de nuvem pode ler | Só `docs/conhecimento/` (sínteses). **Nunca** `docs/research/`, `data/` (notas, lembretes, memórias) nem `.env`. |
| D2 | Qual agente/modelo a rota do app usa | Um agente OpenClaw **dedicado ao app**, com modelo fixo declarado (hoje Kimi-K3 via NVIDIA, se for o escolhido), em vez do padrão do gateway. |
| D3 | Canal | Manter `RODRIGO_WEB_SEARCH` para a busca web. Cada capacidade futura (Drive, social) ganha o próprio canal, desligado por padrão. |
| D4 | Contrato do conteúdo enviado | Apenas o **texto da tarefa delegada** (uma frase/pergunta). Sem histórico da conversa, sem memórias, sem trechos de conhecimento, sem caminhos de arquivo. |

## 5. Mudanças propostas (cada uma com testes que falham primeiro)

**S1. Declaração obrigatória do provedor do OpenClaw.**
- Novo `RODRIGO_OPENCLAW_PROVIDER` (texto curto, só letras/dígitos/`/.-_ `, ex.: `nvidia/moonshotai/kimi-k3`). Com `RODRIGO_WEB_SEARCH=1` e a variável ausente, **a inicialização falha** (mesmo padrão de falha fechada da Fase 12): não se liga um canal de nuvem sem dizer para quem ele vai. É declaração, não medição (como o resto do cartão).
- `privacyText.ts` e `GET /api/privacy` passam a mostrar: "pedidos de busca na web saem via OpenClaw, que os repassa a `<provedor declarado>`".
- README §7: linha nova na tabela e atualização da frase "não há fallback para outro provedor" para distinguir **fallback** (continua não existindo) de **provedores declarados**.

**S2. Fixar agente/modelo da rota do app.** Adicionar `RODRIGO_OPENCLAW_AGENT` e enviá-lo no corpo no formato que o gateway aceitar (a verificar com o Grok, ver §3). Se o gateway não permitir escolha por chamada, a fixação é de configuração do OpenClaw (backup antes, teste de cada agente com um prompt curto, lição L8) e o plano só documenta e verifica. Sem decisão, não há código.

**S3. Contrato de conteúdo e teste de egresso.** Um teste novo no estilo `f12Egress` (gateway OpenClaw **falso em loopback**, que registra cada corpo recebido):
- planta marcadores únicos no histórico, nas memórias, no trecho de conhecimento e num caminho `docs/research/...`; dispara 20 delegações; **nenhum marcador pode aparecer em nenhum corpo**;
- com `RODRIGO_CLOUD=0`, com `RODRIGO_WEB_SEARCH=0` e sem token: **zero tentativas de conexão** ao gateway falso;
- controle positivo: com tudo ligado, a tarefa delegada chega.
Se o teste revelar vazamento, a correção é do construtor do prompt delegado.

**S4. Teste de provedores declarados.** Uma lista única `DECLARED_EXTERNAL_PROVIDERS` em `privacy.ts` (Gemini sempre; OpenClaw→`<declarado>` quando o canal está ligado). Um teste falha se algum item da lista não aparecer no texto do cartão e no README §7. Assim, acrescentar um provedor sem declará-lo quebra a suíte (hoje isso só falha para as frases proibidas).

**S5. Fronteira de `docs/research/`.** Teste que garante que nenhuma string do corpo enviado ao gateway contém `docs/research` nem o nome de um arquivo daquela pasta. A restrição do lado do OpenClaw (skills e ferramentas dos agentes) é configuração do Mac e fica registrada como verificação manual do Grok (R1).

## 6. Riscos

| # | Risco | Mitigação |
|---|---|---|
| R1 | Um agente OpenClaw com ferramenta de arquivo pode **ler `docs/research/` direto do disco** e mandá-lo ao modelo de nuvem, sem passar pelo prompt do app. Nenhum teste do repositório enxerga isso | Verificação manual no Mac (lista de ferramentas de cada agente que a rota do app pode alcançar) e, se existir a ferramenta, restringir o diretório de trabalho do agente dedicado (D2). Fica **fora do que o repositório consegue garantir**; o documento deve dizer isso |
| R2 | O gateway grava os prompts em log/histórico no Mac | Verificar e declarar; não afeta a nuvem, mas afeta "o que fica neste computador" |
| R3 | `RODRIGO_OPENCLAW_PROVIDER` é só declaração; pode divergir do que o OpenClaw realmente usa | Mesma limitação do cartão inteiro ("configuração declarada, não medição"); dizer isso no texto |
| R4 | Privacidade do provedor (retenção, treino) é desconhecida para NVIDIA/Moonshot | O cartão não afirma nada sobre isso; o aviso do nível gratuito do Gemini não se aplica. O Rodrigo decide se aceita |

## 7. Critérios de aceite

- H-OC.1: com os padrões, zero conexões ao gateway em 50 turnos (medido no gateway falso).
- H-OC.2: com o canal ligado, o corpo contém só o texto delegado (marcadores plantados nunca aparecem).
- H-OC.3: canal ligado sem `RODRIGO_OPENCLAW_PROVIDER` ⇒ o app não inicia, com mensagem em PT-BR.
- H-OC.4: o teste de provedores declarados reprova se um provedor sai do cartão ou do README (verificado por mutação).
- H-OC.5: `privacyConsistency.test.ts` e as frases proibidas continuam passando.
- Nenhum teste existente é afrouxado; `tsc` limpo.

## 8. Quem executa, aval e estimativa

| Etapa | Quem | Aval do Rodrigo | Estimativa (minha, não medida) |
|---|---|---|---|
| Decidir D1–D4 | Rodrigo | É o próprio aval | — |
| Verificar os fatos não verificados (§3) e R1/R2 | Grok, no Mac | Não | 0,5–1 h |
| Auditoria deste plano por outro modelo (não Kimi) | Grok/Rodrigo, no Mac | Escolha do auditor | 1 auditoria |
| Implementar S1, S3, S4, S5 (e S2 se o gateway aceitar) | Claude, em PR em rascunho | Sim, cada PR | 4–6 h |
| Configuração do agente dedicado no OpenClaw | Grok/Rodrigo, no Mac | Sim | 0,5–1 h |

## 9. Ordem e dependências

Esta fatia vem **antes** da Fatia 4b e antes do passo 3 do `PLANO-ESPECIALISTAS-UNIFICADOS.md` (instalar skills no OpenClaw). Não depende da Fase V Fatia 5.

## 10. Perguntas abertas para o Grok (só ele consegue responder)

1. Como `/v1/chat/completions` do gateway escolhe agente e modelo? Existe campo para fixá-los por chamada?
2. Qual agente/modelo atende hoje a uma chamada sem `model`?
3. Os agentes que a rota do app alcançaria têm ferramentas que leem o disco? Quais diretórios?
4. O gateway persiste os prompts? Onde?
