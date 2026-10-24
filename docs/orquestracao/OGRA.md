# Camada Ogra — fase 1 (estrutura)

Ogra é a orquestradora externa (Grok). No desenho do Rodrigo ela é o ouvido e a boca: o que o usuário fala vai para ela, e o que precisa ser dito ao usuário ela comunica. O Ork é o braço. Os outros agentes e subagentes do app ficam abaixo dela.

A resposta da Ogra leva 10–60 s e chega inteira, não em stream. Por isso a integração é assíncrona (no mesmo espírito do subagente OpenClaw), e não substitui o LLM que gera cada turno.

## Flag e variáveis

| Variável | Papel | Padrão |
|---|---|---|
| `RODRIGO_OGRA` | Liga a camada. Exatamente `0` ou `1`. Outro valor impede a inicialização. | `0` |
| `RODRIGO_OGRA_FALLBACK` | Com `1`, falha de transporte do webhook (HTTP fora de 2xx, prazo do POST, rede, webhook ausente) e o silêncio depois do 2xx (sem `POST /api/ogra/reply` dentro do prazo abaixo) seguem o mesmo turno pelo caminho de `RODRIGO_OGRA=0`. Uma tentativa. Com `0`, esses casos encerram o turno. A Ogra não entra na reserva do Gemini. Exatamente `0` ou `1`. | `1` |
| `RODRIGO_OGRA_REPLY_TIMEOUT_MS` | Milissegundos entre o 2xx do webhook e o `POST /api/ogra/reply`. Inteiro de 1000 a 600000. Vazio = padrão. Outro valor impede a inicialização. | `120000` |
| `GROK_WEBHOOK_URL` | URL do webhook de saída. Só é usada com a flag em `1`. | vazia |
| `GROK_WEBHOOK_KEY` | Bearer desse webhook. Não é impressa nem vai no corpo. | vazia |
| `RODRIGO_OGRA_CALLBACK_TOKEN` | Token local de `POST /api/ogra/reply` e `POST /api/ogra/tool` (`Authorization: Bearer`, comparação em tempo constante). Sem ele os dois recusam. | vazio |
| indicador `ogra_waiting` | Evento SSE `start`/`stop`. O painel mostra um spinner com "Aguardando a Ogra". Começa quando a fala é enviada. Para quando a resposta começa a ser falada, no prazo, no cancelamento ou no erro. Não há áudio de espera. | — |

Com a flag em `0` o caminho de voz permanece o de hoje. A flag não depende de `RODRIGO_CLOUD`: é outro destino. O cartão de privacidade e `GET /api/privacy` declaram o canal (`ogra` / `sends.ograUtterance`). O áudio do usuário não sai.

## Peças

- `src/backend/agents/ograSubAgent.ts` — `ISubAgent`. Passa o texto por `guardText`, posta o payload (mesmo formato de `scripts/avisar-grok.sh`: `source`, `project`, `message`, `session`; mais `taskId`, `sessionId` e o catálogo do `ExtensionRegistry`) e devolve `kind: 'async_deferred'`. Não segue redirecionamento. Mutação neste agente exige `confirmationToken` do mesmo jeito que o OpenClaw (presente, prefixo do turno, emitido pelo gatekeeper).
- `voiceRuntime.ts` registra o subagente só com `RODRIGO_OGRA=1`.
- `DELEGAR_OGRA` em `src/shared/voiceProtocol.ts`. O worker de intenção não emite esse nome: o roteamento é do app.
- `sessionManager.processTranscript` — depois de tratar confirmação pendente (mutação ou delegação), a fala vai à Ogra. Não há áudio de espera (nem TTS, nem sinal). O evento `ogra_waiting` liga o indicador visual no envio e apaga na fala, no prazo, no cancelamento ou no erro. A tarefa fica pendente até o callback ou o prazo. Microfone mutado (`POST /api/voice/session/mute`) não inicia turno de áudio e não chama o webhook; texto digitado continua. Uma fala nova não encerra a tarefa anterior: a resposta dela, se chegar dentro do prazo, ainda é falada. Eco do TTS, inclusive "Pensando...", não abre tarefa nem chama o webhook. Com uma tarefa já pendente, a fala nova espera (há log) e o webhook sai só quando essa tarefa encerra. Só o cancelamento explícito do turno (`POST /api/voice/session/cancel`), o fim da sessão ou o prazo descartam essa resposta. Se o POST falha, ou se a resposta não chega em `RODRIGO_OGRA_REPLY_TIMEOUT_MS` com o turno ainda ativo, e `RODRIGO_OGRA_FALLBACK=1`, o mesmo turno segue o caminho normal (classificação, ferramentas, geração) sem segunda ida à Ogra. Mutação nesse caminho pede SIM falado, mesmo com `RODRIGO_AUTO_CONFIRM=1`. A Ogra não entra em `GENERATION_MODELS`.
- `POST /api/ogra/reply` — contrato na seção abaixo. Host do `hostValidator` mais o token. O texto é dado não confiável (`memory/untrustedData.ts`: `neutralizeUntrusted`, depois o guarda de saída) e sai pelo TTS do turno.
- `POST /api/ogra/tool` `{ taskId, tool, args }` — passa por `runSubAgentDelegation` nas leituras (política de capacidade, orçamento, auditoria do caminho que já existe). Mutação não executa neste POST.

## Contrato do callback

O webhook de saída (`GROK_WEBHOOK_URL`) é de uma via: 2xx só confirma que a mensagem foi aceita. Não traz a resposta. A Ogra processa em seguida (em geral 10–90 s) e devolve o texto neste endpoint, no mesmo `taskId` e `sessionId` que o Ork enviou no POST do webhook.

`POST /api/ogra/reply`

Cabeçalhos:

- `Authorization: Bearer <RODRIGO_OGRA_CALLBACK_TOKEN>` — comparação em tempo constante. Sem token configurado, cabeçalho ausente, múltiplo ou diferente: **401**, e o texto não é falado.
- `Content-Type: application/json`
- `Host`: `127.0.0.1` ou `localhost`, na porta do app (o mesmo `hostValidator` do restante da API). Outro host: **403**.

Corpo JSON:

| Campo | Papel |
|---|---|
| `taskId` | Obrigatório. O mesmo `taskId` do POST do webhook. String de até 80 caracteres, `[A-Za-z0-9_.:-]`. |
| `sessionId` | O mesmo `sessionId` do POST do webhook. Se vier e não for o da tarefa pendente, a resposta é ignorada. |
| `text` | Obrigatório. O que o Ork fala naquela sessão, pelo TTS do turno. Até 8000 caracteres. |

```json
{
  "taskId": "7c1e0a4a-1b2c-4d5e-8f90-123456789abc",
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "text": "A capital é Brasília."
}
```

`final` é opcional e não faz parte do contrato que a Ogra precisa enviar. Ausente ou `true`: a tarefa encerra depois desta fala. `false`: o texto é falado e a tarefa continua pendente até uma resposta completa ou o prazo.

O que o Ork responde:

| HTTP | Corpo | Quando |
|---|---|---|
| 200 | `{ "ok": true }` | Texto aceito e mandado ao TTS |
| 200 | `{ "ok": true, "ignored": true }` | Duplicata, resposta depois do prazo, resposta depois do cancelamento explícito do turno, ou `sessionId` que não é o da tarefa. Uma fala nova não entra aqui. Não fala de novo. Não lança. |
| 401 | `{ "error": "Token do callback recusado." }` | Token ausente ou errado |
| 404 | `{ "error": "Tarefa desconhecida." }` | `taskId` que não está pendente e não foi encerrado aqui. Registrado em log, sem fala |
| 409 | `{ "error": "Sessão da tarefa não está ativa." }` | A sessão dona da tarefa não é a sessão corrente |
| 400 | `{ "error": "..." }` | JSON inválido, `taskId` inválido ou `text` inválido |

Com `RODRIGO_OGRA=0` a rota nem existe: 404 `Rota de API não encontrada.`

Se o prazo estoura e `RODRIGO_OGRA_FALLBACK=1`, o Ork fala "A Ogra não respondeu, vou seguir por aqui." e o mesmo turno segue classificação, ferramentas e geração. Uma resposta que chegue depois disso cai no 200 `ignored`. Com a flag em `0`, o turno encerra com "A Ogra não respondeu a tempo." e não classifica nem gera. Nos dois casos a Ogra não é chamada de novo e não entra na cadeia `gemini-flash-latest` → `gemini-3.5-flash-lite`.

## Regra do SIM

A Ogra propõe. O app pergunta em voz. O usuário confirma. Só então `recordMutationConfirmation` e `consumeMutationToken` liberam lembrete, nota ou memória. `markPlayed` continua sendo a prova de que a pergunta foi ouvida. `RODRIGO_AUTO_CONFIRM` não vale neste caminho. Corpo com `confirmationToken`, `isMutation` ou `skip` não executa nada.

Na fase 1 as ferramentas aceitas são hora, data e consulta de lembrete/nota/memória (leitura) e criar/editar/apagar lembrete, nota e memória (só depois do SIM).

## Fases

- **Fase 1 (esta):** a estrutura acima, atrás da flag, coberta por teste.
- **Fases seguintes (documentadas, não aplicadas):** coordenar o cursor entre editor de texto, notas, chat de IA, WhatsApp e outros apps para escrever texto ditado; automação de desktop; qualquer envio de mensagem para fora do app. Não há código que faça isso. Pedidos `DESKTOP_*`, `DIGITAR_*`, `DITADO_*`, `CONFIGURAR_*`, `AUTO_*`, `AUTOMACAO_*` e `DELEGAR_*` no endpoint de ferramenta são recusados.

## Fila de fala

`speakOutOfTurn` descartava a fala se havia um turno ativo. Com a flag ligada, a fala entra numa fila da sessão e sai no `turn_done` (e também se o turno termina em erro). Com a flag desligada, o descarte antigo permanece.
