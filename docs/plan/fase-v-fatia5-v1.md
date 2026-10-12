# Plano curto — Fase V, Fatia 5: a imagem da tela ao Gemini, só por autorização falada (v1)

> Estado: **PROPOSTA. Sem código neste PR.** Nenhum código antes do aval do Rodrigo e da auditoria de um modelo de outra família.
> Autor: Claude Sonnet (reserva do orquestrador), 2026-10-12. Base: `origin/main` em `ccf03ca`.
> Plano-mãe: `docs/phase-vision-v3.md` (§3.2, §5.2, §7 HV.2/HV.13, §10, §11 fatia 5). Este documento **não o substitui**: só diz o que a Fatia 5 ainda precisa fazer, dado o que o código já tem.
> Pré-requisito já proposto: PR #9 (`RODRIGO_CLOUD_VISION` desligado por padrão, com cartão e README).

## 1. O que a Fatia 5 entrega

Quando o usuário pergunta sobre a tela **e** diz explicitamente que o Gemini deve olhar ("olha minha tela com o Gemini"), **e** `RODRIGO_CLOUD=1` **e** `RODRIGO_CLOUD_VISION=1`, uma captura (um quadro JPEG) vai ao Gemini, só naquele turno, e a resposta é falada. Em qualquer outro caso a imagem **não sai da máquina**. A página mostra "Tela enviada ao Google às HH:MM" a partir do despacho real.

## 2. O que o código já tem (verificado em `origin/main`)

- `screenQuery.ts`: `mightBeScreenQuery` e `screenCloudAuthorized` (gramática com posição de comando, negação, metalinguística e aspas, conforme §3.2/§10.1). Existe teste em `fvScreen.test.ts`; **não auditei a matriz inteira**.
- `sessionManager.ts`: o turno de tela passa por captura de uso único, nunca por intenção, mutação, classificação ou geração; o histórico marca `origin: 'screen'`.
- `worker.py` `handle_describe_screen`: já tem o ramo Gemini (`gemini-flash-latest`, `Part.from_bytes`, cliente com prazo de 20 s e sem seguir redirecionamentos) e o ramo local (`mlx_vlm`), com prefixo "A visão pelo Gemini está desligada, então olhei aqui mesmo." quando o canal está desligado.
- Testes do worker: o ramo Gemini agora tem teste de padrão desligado (PR #9, `test_cloud_master.py`).

## 3. Lacunas da Fatia 5 (verificadas em código; cada uma vira trabalho)

| # | Lacuna | Evidência |
|---|---|---|
| L1 | **Não existe `describeScreen` na interface `VoiceEngine` nem no `FakeVoiceEngine`.** `sessionManager` só chama a visão se `this.engine instanceof MlxWorkerEngine`; com o motor falso responde sempre a frase fixa. Logo **HV.1 e a matriz de egresso HV.2 não são testáveis no Node** | `sessionManager.ts:709–713`; `engine.ts`/`fakeEngine.ts` sem o método |
| L2 | **A decisão de enviar a imagem está só no worker**, que lê `RODRIGO_CLOUD_VISION`/`RODRIGO_CLOUD` do ambiente. O Node passa apenas o resultado da gramática (`screenCloudAuthorized`) e não aplica `privacy.cloud && privacy.cloudVision`. Funciona hoje porque o worker é a última barreira, mas a política não tem uma fonte única nem teste no Node | `sessionManager.ts:709–711` |
| L3 | **O aviso "Tela enviada ao Google às HH:MM" não existe.** O worker emite `screen_sent`, mas nenhum código do Node nem da página o consome (nenhuma ocorrência fora de `worker.py`) | grep em `src` e `scripts` |
| L4 | **Não há teste de egresso da visão** (HV.2) nem de logs sem marcador (HV.11). O padrão existe para geração e TTS (`f12Egress`), não para a imagem | `fvScreen.test.ts` não cobre `describe_screen` |
| L5 | **A voz da resposta de tela é `local`** (voz do sistema). A decisão do usuário em 2026-10-08 foi "Voz do Gemini mesmo". Ver D1 | `sessionManager.ts:737` (`synthesizeSentence(..., 'local')`) |
| L6 | **O ramo Gemini do worker cai para a visão local em qualquer exceção, e a visão local pode não estar instalada** (`mlx-vlm` não está em `requirements.in` nem no setup). O usuário ouviria "Ainda estou aprendendo a enxergar a tela" em vez de uma explicação honesta de que o Gemini falhou | `worker.py` ramo `except` + `requirements.in` |

Fora do escopo desta fatia (continuam sendo da Fatia 4, que **não está concluída**): `mlx-vlm` no setup, escolha e revisão do modelo de visão local (hoje `Qwen2.5-VL-3B-Instruct-4bit`, o plano mediu `Qwen3-VL-4B`), HV.8–HV.12, e o teste do usuário HV.14.

## 4. Decisões do Rodrigo

| # | Decisão | Recomendação |
|---|---|---|
| D1 | **Com que voz falar a resposta de tela.** Em 2026-10-08 você escolheu "Voz do Gemini mesmo": o *texto* da resposta vai ao TTS do Google (a imagem não). O código hoje usa a voz do sistema (`local`). A resposta pode repetir texto lido da tela, que pode ser sensível, e iria ao Google mesmo no caminho **local** da visão | Manter `local` (voz do sistema) **até você reconfirmar**, já sabendo que o texto da resposta sobre a tela vai ao Google se escolher a voz do Gemini. Se reconfirmar, fica por trás de um controle próprio e é declarado no cartão. Mesma lógica da decisão D-b da Fase 13a |
| D2 | **Falha do Gemini na visão** | Manter: cair para a visão **local**, sem segundo modelo Gemini. Um segundo modelo na nuvem enviaria a imagem de novo; a regra da Fase 12 de fallback entre modelos vale para texto, não para uma imagem de tela |
| D3 | **`RODRIGO_CLOUD_VISION` desligado por padrão** (PR #9) | Confirmar |
| D4 | **Streaming** (o v3 §5.2 diz `generate_content_stream`; o código usa `generate_content`) | Manter sem streaming: a resposta tem até 3 frases e vira uma única fala. É um desvio do v3 e precisa constar na auditoria |

## 5. Mudanças propostas (testes que falham primeiro; prova de mutação em cada barreira)

**S1. Interface e motor falso (L1).** `VoiceEngine.describeScreen(turnId, imagePath, question, cloudAuthorized)`; `FakeVoiceEngine` com texto, `kind` e latência configuráveis, e registro do que recebeu. `sessionManager` deixa de depender de `instanceof MlxWorkerEngine`. Testes: HV.1 com o motor falso.

**S2. Política em um lugar só (L2).** O Node calcula `cloudAuth = screenCloudAuthorized(transcript) && privacy.cloud && privacy.cloudVision` e passa **já resolvido**; o worker continua checando por conta própria (defesa em profundidade, já testada no PR #9). Teste: matriz mestre × canal × autorização afirmativa/negada/ausente, com o motor falso registrando o que recebeu.

**S3. Aviso "Tela enviada ao Google" (L3).** O worker já emite `screen_sent`; o motor o repassa ao `sessionManager`, que emite um evento SSE `screen_sent` com a hora do despacho. A página mostra "Tela enviada ao Google às HH:MM". Testes: o evento só existe quando a imagem foi de fato despachada; nunca em turno local, com canal desligado ou cancelado antes do envio.

**S4. Matriz de egresso HV.2 e logs HV.11 (L4).** Teste no estilo `f12Egress`, com o **worker real e um Gemini falso em loopback** que registra cada corpo:
- dimensões: mestre × `CLOUD_VISION` × autorização {afirmativa, negada, ausente} × {ok, cancelado, Gemini falha};
- marcador plantado **na imagem** e **na pergunta**: a imagem só aparece no corpo de visão quando autorizado; pergunta e resposta de tela nunca aparecem em corpo de geração ou intenção, em 20 turnos alternados com turnos normais;
- se D1 = voz do Gemini, a resposta de tela aparece **somente** no corpo de TTS daquele turno;
- stdout/stderr do Node e do worker não contêm o marcador (HV.11).
Roda **no Mac** (precisa de `.runtime`). A parte de política do Node (S2) roda em qualquer lugar.

**S5. Falha do Gemini com honestidade (L6).** Se o Gemini falha e a visão local não está disponível, o app diz isso ("não consegui ver a tela pelo Gemini e a visão local não está instalada"), e não a frase de "ainda estou aprendendo". Teste com Gemini falso que devolve 503 e VLM ausente.

**S6. Cartão e README.** O PR #9 já declara que a imagem da tela não sai por padrão e que só sai com autorização falada. Esta fatia acrescenta a explicação do aviso "Tela enviada ao Google às HH:MM" e, conforme D1, a linha sobre o texto da resposta. `privacyConsistency.test.ts` continua passando.

**S7. Prova de mutação (HV.13).** Remover cada barreira e ver o teste correspondente falhar: filtro `screen` em `windowHistory`, consumo do `captureId`, negação na gramática, `cancelled_turns`, apagar no `finally`, **mais as novas**: `privacy.cloudVision` no Node (S2) e o gate do worker.

## 6. Critérios de aceite

HV.1, HV.2, HV.6, HV.7, HV.11 e HV.13 do v3; mais: **A5.1** o `screen_sent` só ocorre com despacho real; **A5.2** com Gemini falho e VLM ausente a fala é a explicação honesta; **A5.3** nenhuma asserção existente é afrouxada e `tsc` fica limpo. HV.8–HV.10, HV.12 e HV.14 pertencem à Fatia 4 e ao teste do usuário.

## 7. Riscos

| # | Risco | Mitigação |
|---|---|---|
| R1 | A gramática de autorização (§3.2) é de texto transcrito pelo Whisper; uma negação perdida pelo STT ("sem o Gemini" → "o Gemini") **autorizaria o envio** | É o mesmo defeito que apareceu na Fase 5c (negação perdida). A matriz do S4 não o cobre, porque parte do texto já transcrito. Mitigação proposta: pedir autorização pela gramática **e** exigir que o canal esteja ligado (padrão desligado, PR #9): quem não ligou o canal nunca envia. Para quem ligou, o risco permanece e deve ser dito no cartão |
| R2 | A imagem da tela pode conter dados pessoais de terceiros ou segredos | O envio só ocorre por fala explícita naquele turno, e o aviso com hora aparece na página. Não há como o app filtrar o conteúdo da imagem |
| R3 | O tier do Gemini do projeto (gratuito vs. pago) muda o que o Google faz com a imagem | Mesma advertência já exibida no cartão para o texto; a imagem deve ser incluída nela |
| R4 | A Fatia 4 incompleta faz o caminho local falhar, e o usuário acaba preferindo o Gemini só porque o local não funciona | S5 torna isso visível; concluir a Fatia 4 é a mitigação real |

## 8. Quem executa, aval e estimativa (minhas, não medidas)

| Etapa | Quem | Aval do Rodrigo | Estimativa |
|---|---|---|---|
| Decidir D1–D4 | Rodrigo | É o próprio aval | — |
| Auditoria deste plano (outra família, não Kimi) | Grok/Rodrigo, no Mac | Escolha do auditor | 1 auditoria |
| S1, S2, S3, S5, S6, S7 (Node e testes sem Python) | Claude, PRs em rascunho | Sim, cada PR | 6–9 h |
| S4 (egresso com worker real) e validação no Mac | Claude escreve; Grok roda no Mac | Sim | 3–4 h mais a execução |
| Revisão de código da fatia | Auditor de outra família | — | 1 rodada |

## 9. Ordem

1. Merge do PR #9. 2. Decisões D1–D4 e auditoria do plano. 3. S1 → S2 → S3 → S5/S6 → S7 (cada um com seu teste primeiro). 4. S4 no Mac. 5. Só então ligar `RODRIGO_CLOUD_VISION=1` em uso real, depois do HV.14 do usuário. A Fatia 4 (visão local) segue em paralelo, no Mac.
