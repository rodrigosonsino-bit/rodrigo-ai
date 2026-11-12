# Plano — Fatia de privacidade do OpenClaw (v2)

> Estado: **PROPOSTA para revisão e auditoria. Sem código neste PR.** Nenhum código antes do aval do Rodrigo e de uma auditoria de outra família de modelo (item 5 do parecer).
> Autor: Claude Sonnet (reserva do orquestrador), 2026-10-12. Base: `origin/main` em `ccf03ca`.
> Origem: itens 1 e 2 de `docs/orquestracao/revisoes/2026-10-12-ressalvas-claude-sonnet.md` (PR #7).
> **v2:** incorpora as respostas do ORQUESTRADOR_GROK ao §10 da v1 (comentário no PR #10, leitura somente-leitura no Mac, OpenClaw 2026.10.1). Esses fatos vêm da config e da doc instalada lidas por ele; **nada foi exercitado por HTTP** e eu não os verifiquei. Estão marcados como *(Grok)*.

## 1. Situação, em uma página

1. **Hoje nada sai para o OpenClaw, por dois motivos independentes.** (a) No app: só `openclaw_web` está ligado, exige `RODRIGO_CLOUD=1`, `RODRIGO_WEB_SEARCH=1` (padrão `0`) e token; e nenhum caminho de voz origina essa delegação (`runSubAgentDelegation` só recebe ids `tool_<nome>`, `sessionManager.ts:450`). (b) No OpenClaw: o endpoint `/v1/chat/completions` está **desligado** (`gateway.http` não definido) *(Grok)*. Isto corrige o item 1 do parecer ("incompleto hoje"): o risco é **latente**.
2. **Ligar a rota é uma decisão de segurança, não só de funcionalidade.** Segundo a doc do OpenClaw *(Grok)*, quem usa o Bearer de segredo compartilhado (o caso do app) recebe **escopo completo de operador** e a chamada é tratada como **turno do dono**; se a política do agente-alvo permite ferramentas sensíveis, o endpoint pode usá-las. A config não tem `tools.allow/deny` nem sandbox *(Grok)*, então valem os padrões, sem isolamento.
3. **O app hoje não escolhe agente nem modelo.** `openClawHttpClient.ts` envia só `{"messages":[...]}`. Pela doc *(Grok)*, o campo `model` seleciona o **agente** (`openclaw/<agentId>`), o header `x-openclaw-model` fixa o **modelo do provedor**, e sem eles a chamada cai no agente padrão `main`, que está em `anthropic/claude-sonnet-5-5`, sem chave no gateway: tenderia a falhar. Não é uma falha segura que se deva deixar ao acaso.
4. **O prompt provavelmente fica gravado no disco do Mac** (sqlite do agente, `~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite`) e é visto pelo provedor de nuvem do modelo *(Grok)*. Isso precisa entrar no cartão de privacidade, com retenção definida.
5. **O pior caminho é o agente `orquestrador-de-voz`:** o workspace dele é o próprio repositório, que inclui `docs/research/` *(Grok)*. Nunca deve ser o alvo da rota do app.

## 2. Objetivo

Antes de a Fatia 4b ligar a rota de voz, garantir que: (a) o app **só** chame um agente dedicado, com o modelo fixado por ele, nunca o padrão; (b) esse agente não tenha ferramentas de arquivo, shell ou navegador; (c) o que é enviado tenha um contrato mínimo testado; (d) o cartão e o README declarem para onde o texto vai e que fica gravado no Mac; (e) `docs/research/` não possa chegar a um modelo de nuvem por esse caminho.

## 3. Fatos usados

**Verificados por mim em código (`origin/main`):** cliente sem `model`/agente (`openClawHttpClient.ts`); gate de `openclaw_web` por `webSearchEffective`; nenhuma delegação de voz ao OpenClaw; `privacyText.ts` e README §7 sem provedor nem retenção do OpenClaw.

**Informados pelo Grok, não verificados por mim:** tudo o que está marcado *(Grok)* no §1, mais: workspaces por agente (`main` → `~/.openclaw/workspace`; os seis agentes de papel → `~/.openclaw/workspace-<id>`; `engenheiro-prompt` → subpasta do workspace; `orquestrador-de-voz` → o repositório); modelos atuais (seis agentes em `nvidia/moonshotai/kimi-k3`; `engenheiro-prompt` e o padrão dos agentes em `google/gemini-3.7-flash`; `main` e `orquestrador-de-voz` em `anthropic/claude-sonnet-5-5`); o endpoint é stateless por chamada, a menos que se envie `user` ou `x-openclaw-session-key`.

## 4. Decisões que são do Rodrigo

| # | Decisão | Minha recomendação |
|---|---|---|
| D1 | O que um agente de nuvem pode ler | Só `docs/conhecimento/`. **Nunca** `docs/research/`, `data/` (notas, lembretes, memórias) nem `.env`. |
| D2 | Agente e modelo da rota do app | Um **agente novo, dedicado** (nome sugerido: `rodrigo-app-web`), com workspace vazio, `tools.deny` para fs/exec/navegador conforme a necessidade real, sandbox ligado, e **modelo fixo**. Nunca `main`, `orquestrador-de-voz` nem o agente padrão. |
| D3 | Qual modelo/provedor | Decisão do Rodrigo. Observação de privacidade: um modelo Google (`google/gemini-3.7-flash`) mantém o conjunto de destinatários já aceito (Google); `nvidia/moonshotai/kimi-k3` acrescenta NVIDIA/Moonshot, com retenção e treino desconhecidos para mim. |
| D4 | Contrato do conteúdo enviado | Apenas o **texto da tarefa delegada** (uma frase ou pergunta). Sem histórico, memórias, trechos de conhecimento ou caminhos de arquivo. |
| D5 | Retenção no disco do Mac | Definir por quanto tempo as sessões do agente dedicado ficam em `~/.openclaw/agents/rodrigo-app-web/` e quem limpa (ex.: rotina semanal da revisão do Grok). Sem decisão, o cartão só pode dizer "fica gravado". |
| D6 | Ligar o endpoint `chatCompletions` | É a decisão que abre a rota. Só depois de D2 estar configurado e testado. Se o OpenClaw permitir um token de escopo menor que o segredo compartilhado, preferi-lo (ver §9). |

## 5. Mudanças propostas (cada uma com testes que falham primeiro)

**S1. Agente e modelo fixados pelo app, obrigatórios.**
- Novas variáveis `RODRIGO_OPENCLAW_AGENT` (id do agente dedicado) e `RODRIGO_OPENCLAW_MODEL` (`provedor/modelo`). Com `RODRIGO_WEB_SEARCH=1` e qualquer uma ausente, **a inicialização falha** (falha fechada, como na Fase 12). Os apelidos de padrão (`openclaw`, `openclaw/default`, `main`, `orquestrador-de-voz`) são rejeitados por nome.
- O cliente passa a enviar sempre `model: "openclaw/<agente>"` e o header `x-openclaw-model: <provedor/modelo>`.
- Efeito colateral útil: o provedor mostrado no cartão **é o valor que o app impõe na própria requisição**, e não uma declaração solta. Continua sendo configuração declarada, não medição de tráfego.

**S2. Cartão e README.** Linha nova no cartão e na tabela do README §7: "pedidos de busca na web saem via OpenClaw para `<provedor do modelo fixado>`; **o OpenClaw guarda a tarefa enviada no disco deste computador** (retenção: D5)". O parágrafo "não há fallback para outro provedor" passa a distinguir **fallback** (continua não existindo) de **provedores declarados**.

**S3. Contrato de conteúdo e egresso.** Teste no estilo `f12Egress` com um **gateway OpenClaw falso em loopback** que registra corpo e headers de cada requisição:
- marcadores únicos plantados no histórico, nas memórias, no trecho de conhecimento e num caminho `docs/research/...`, em 20 delegações: nenhum aparece em corpo nem header;
- o corpo tem `model` igual a `openclaw/<agente>` e o header `x-openclaw-model` está presente, nas 20 chamadas;
- sem `user` nem `x-openclaw-session-key` com conteúdo do usuário;
- com `RODRIGO_CLOUD=0`, com `RODRIGO_WEB_SEARCH=0` e sem token: **zero tentativas de conexão**;
- controle positivo: com tudo ligado, a tarefa delegada chega.

**S4. Teste de provedores declarados.** Lista única `DECLARED_EXTERNAL_PROVIDERS` em `privacy.ts` (Gemini sempre; o provedor do `RODRIGO_OPENCLAW_MODEL` quando o canal está ligado). Um teste falha se um item da lista não aparecer no cartão e no README §7, verificado por mutação.

**S5. Fronteira de `docs/research/`.** Nenhuma string do corpo ou dos headers enviados ao gateway contém `docs/research` nem o nome de um arquivo daquela pasta (parte do S3). A restrição do **lado do OpenClaw** não é verificável pelo repositório (R1).

**S6. Configuração do OpenClaw (feita pelo Grok no Mac, com backup antes e teste do agente, lição L8).** Criar `rodrigo-app-web` com as restrições de D2; habilitar `gateway.http.endpoints.chatCompletions` somente depois (D6).

## 6. Riscos

| # | Risco | Mitigação |
|---|---|---|
| R1 | Mesmo com o app fixando o agente, **a segurança real da rota é a política de ferramentas do agente**, e ela vive na config do OpenClaw, fora do repositório. Um agente com fs/exec pode ler `docs/research/` direto do disco e enviá-lo ao modelo de nuvem | D2/S6 + verificação manual: depois de configurado, o Grok testa que o agente não consegue listar nem ler arquivos fora do workspace vazio. O documento deve dizer que isto **não** é garantido pelo código do app |
| R2 | Escopo completo de operador com o segredo compartilhado: um erro no app pode acionar ferramentas sensíveis de um agente com política frouxa | Agente dedicado com `deny` (D2); preferir token de escopo menor se existir (§9) |
| R3 | Prompt gravado em sqlite no Mac | S2 declara; D5 define retenção e limpeza |
| R4 | O provedor declarado é o que o app impõe via header, mas não há medição do que o gateway de fato envia | Mesma limitação do cartão inteiro ("configuração declarada, não medição"); dizer isso no texto |
| R5 | Privacidade de NVIDIA/Moonshot (retenção, treino) desconhecida para mim | O cartão não afirma nada sobre isso; D3 é do Rodrigo |

## 7. Critérios de aceite

- H-OC.1: com os padrões, zero conexões ao gateway falso em 50 turnos.
- H-OC.2: com o canal ligado, nenhum marcador plantado aparece no corpo nem nos headers; `model` e `x-openclaw-model` estão presentes em todas as chamadas.
- H-OC.3: canal ligado com `RODRIGO_OPENCLAW_AGENT` ou `RODRIGO_OPENCLAW_MODEL` ausentes, ou com um apelido de padrão, ⇒ o app não inicia, com mensagem em PT-BR.
- H-OC.4: o teste de provedores declarados reprova se o provedor sair do cartão ou do README (por mutação).
- H-OC.5: `privacyConsistency.test.ts` e as frases proibidas continuam passando.
- H-OC.6 (manual, Grok): com o agente `rodrigo-app-web` configurado, uma chamada pedindo para ler um arquivo do repositório **falha**; registrar a evidência no `ESTADO.md`.
- Nenhum teste existente é afrouxado; `tsc` limpo.

## 8. Quem executa, aval e estimativa (minhas, não medidas)

| Etapa | Quem | Aval do Rodrigo | Estimativa |
|---|---|---|---|
| Decidir D1–D6 | Rodrigo | É o próprio aval | — |
| Auditoria deste plano por modelo de outra família (não Kimi) | Grok/Rodrigo, no Mac | Escolha do auditor | 1 auditoria |
| S1–S5 em PR de rascunho | Claude | Sim, cada PR | 5–7 h |
| S6 (agente dedicado, restrições, backup, teste H-OC.6) | Grok, no Mac | Sim | 1–2 h |
| Ligar o endpoint (D6) | Grok, depois de S6 e H-OC.6 | Sim | minutos |

## 9. Perguntas que continuam abertas (só o Grok, no Mac)

1. O OpenClaw aceita um token de escopo menor que o segredo compartilhado para esta rota (sem `operator.admin`)?
2. Com `operator.admin` e `x-openclaw-session-key`, é possível pedir uma sessão **incógnita** (só em memória) para esta rota, evitando o sqlite? Se sim, isso reduz R3 sem custo de limpeza.
3. O padrão de ferramentas de arquivo, sem `deny`, restringe ao workspace do agente ou alcança o disco todo? (Ele registrou que não confirmou; o plano assume o pior.)
4. Os modelos `anthropic/*` do `main` e do `orquestrador-de-voz` continuam sem chave? (Relevante só para garantir que a rota nunca caia neles.)

## 10. Ordem e dependências

Esta fatia vem **antes** da Fatia 4b e antes do passo 3 do `PLANO-ESPECIALISTAS-UNIFICADOS.md` (skills no OpenClaw). Não depende da Fase V Fatia 5.
