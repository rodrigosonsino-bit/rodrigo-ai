# Camada Ogra — fase 1 (estrutura)

Ogra é a orquestradora externa (Grok). No desenho do Rodrigo ela é o ouvido e a boca: o que o usuário fala vai para ela, e o que precisa ser dito ao usuário ela comunica. O Ork é o braço. Os outros agentes e subagentes do app ficam abaixo dela.

A resposta da Ogra leva 10–60 s e chega inteira, não em stream. Por isso a integração é assíncrona (no mesmo espírito do subagente OpenClaw), e não substitui o LLM que gera cada turno.

## Flag e variáveis

| Variável | Papel | Padrão |
|---|---|---|
| `RODRIGO_OGRA` | Liga a camada. Exatamente `0` ou `1`. Outro valor impede a inicialização. | `0` |
| `RODRIGO_OGRA_FALLBACK` | Com `1`, falha de transporte do webhook (HTTP fora de 2xx, prazo, rede, webhook ausente) segue o mesmo turno pelo caminho de `RODRIGO_OGRA=0`. Uma tentativa. Com `0`, a falha encerra o turno. A Ogra não entra na reserva do Gemini. Exatamente `0` ou `1`. | `1` |
| `GROK_WEBHOOK_URL` | URL do webhook de saída. Só é usada com a flag em `1`. | vazia |
| `GROK_WEBHOOK_KEY` | Bearer desse webhook. Não é impressa nem vai no corpo. | vazia |
| `RODRIGO_OGRA_CALLBACK_TOKEN` | Token local de `POST /api/ogra/reply` e `POST /api/ogra/tool` (`Authorization: Bearer`, comparação em tempo constante). Sem ele os dois recusam. | vazio |

Com a flag em `0` o caminho de voz permanece o de hoje. A flag não depende de `RODRIGO_CLOUD`: é outro destino. O cartão de privacidade e `GET /api/privacy` declaram o canal (`ogra` / `sends.ograUtterance`). O áudio do usuário não sai.

## Peças

- `src/backend/agents/ograSubAgent.ts` — `ISubAgent`. Passa o texto por `guardText`, posta o payload (mesmo formato de `scripts/avisar-grok.sh`: `source`, `project`, `message`, `session`; mais `taskId`, `sessionId` e o catálogo do `ExtensionRegistry`) e devolve `kind: 'async_deferred'`. Não segue redirecionamento. Mutação neste agente exige `confirmationToken` do mesmo jeito que o OpenClaw (presente, prefixo do turno, emitido pelo gatekeeper).
- `voiceRuntime.ts` registra o subagente só com `RODRIGO_OGRA=1`.
- `DELEGAR_OGRA` em `src/shared/voiceProtocol.ts`. O worker de intenção não emite esse nome: o roteamento é do app.
- `sessionManager.processTranscript` — depois de tratar confirmação pendente (mutação ou delegação), a fala vai à Ogra e o Ork diz um aceite curto. O turno não espera a resposta. Se o POST falha e `RODRIGO_OGRA_FALLBACK=1`, o mesmo turno segue o caminho normal (classificação, ferramentas, geração) sem segunda ida à Ogra. Mutação nesse caminho pede SIM falado, mesmo com `RODRIGO_AUTO_CONFIRM=1`.
- `POST /api/ogra/reply` `{ taskId, text, final }` — Host do `hostValidator` mais o token. O texto é dado não confiável (`memory/untrustedData.ts`: `neutralizeUntrusted`, depois o guarda de saída). `consumeOgraReply` espelha a entrega fora de turno do OpenClaw.
- `POST /api/ogra/tool` `{ taskId, tool, args }` — passa por `runSubAgentDelegation` nas leituras (política de capacidade, orçamento, auditoria do caminho que já existe). Mutação não executa neste POST.

## Regra do SIM

A Ogra propõe. O app pergunta em voz. O usuário confirma. Só então `recordMutationConfirmation` e `consumeMutationToken` liberam lembrete, nota ou memória. `markPlayed` continua sendo a prova de que a pergunta foi ouvida. `RODRIGO_AUTO_CONFIRM` não vale neste caminho. Corpo com `confirmationToken`, `isMutation` ou `skip` não executa nada.

Na fase 1 as ferramentas aceitas são hora, data e consulta de lembrete/nota/memória (leitura) e criar/editar/apagar lembrete, nota e memória (só depois do SIM).

## Fases

- **Fase 1 (esta):** a estrutura acima, atrás da flag, coberta por teste.
- **Fases seguintes (documentadas, não aplicadas):** coordenar o cursor entre editor de texto, notas, chat de IA, WhatsApp e outros apps para escrever texto ditado; automação de desktop; qualquer envio de mensagem para fora do app. Não há código que faça isso. Pedidos `DESKTOP_*`, `DIGITAR_*`, `DITADO_*`, `CONFIGURAR_*`, `AUTO_*`, `AUTOMACAO_*` e `DELEGAR_*` no endpoint de ferramenta são recusados.

## Fila de fala

`speakOutOfTurn` descartava a fala se havia um turno ativo. Com a flag ligada, a fala entra numa fila da sessão e sai no `turn_done` (e também se o turno termina em erro). Com a flag desligada, o descarte antigo permanece.
