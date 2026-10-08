# Auditoria do plano docs/phase-vision-v2.md — rodada 2 — agy (Antigravity, --mode plan, cópia isolada sem docs/research)

Tentativas anteriores nesta rodada: Codex (cota esgotada até 23:27), Kimi K3 (saída degenerada, sem arquivo), DeepSeek V4 Pro (erro de servidor). Resultado: APROVAR COM AJUSTES; 6 achados novos, todos verificados no código por Claude (voice.ts:376, voiceProtocol.ts:116, mlxWorkerEngine.ts:655-663, mutatingTools.ts:406) e incorporados na v3.

# Relatório de Auditoria Adversarial (Rodada 2) — Fase Vision v2

**Documento auditado:** [docs/phase-vision-v2.md](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md)  
**Auditoria de referência anterior:** [docs/vision-plan-codex-r1-2026-10-08.md](file:///tmp/claude-501/auditV/docs/vision-plan-codex-r1-2026-10-08.md)  
**Código confrontado:** [`src/`](file:///tmp/claude-501/auditV/src) e [`scripts/worker/worker.py`](file:///tmp/claude-501/auditV/scripts/worker/worker.py)  
**Veredito calibrado (JEV Choice — 100%):** **APROVAR COM AJUSTES**

---

## (A) Avaliação dos 17 Achados da Rodada 1 contra a v2

| # | Achado R1 Original | Classificação | Evidência e Análise |
|---|---|---|---|
| **1** | A descrição da visão local sai pelo TTS do Gemini sem autorização explícita | **RESOLVIDO** | O usuário arbitrou expressamente na Seção 0 a decisão vinculante: *"Com que voz o app fala a resposta da visão LOCAL? Voz do Gemini mesmo — uma voz só, mais natural; mas o TEXTO da resposta sobre a tela vai ao Google (a imagem não)"*. O plano formalizou em [phase-vision-v2.md:21, 109](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L21) essa fronteira aprovada (`kind: 'generated'`). Caso o canal de TTS esteja desligado (`RODRIGO_CLOUD_TTS=0` ou `RODRIGO_CLOUD=0`), o worker intercepta em [`worker.py:1195`](file:///tmp/claude-501/auditV/scripts/worker/worker.py#L1195) e o Node chaveia para voz local do sistema. |
| **2** | Consentimento de um turno Gemini retransmite a descrição em turnos seguintes | **RESOLVIDO** | Em [phase-vision-v2.md:22, 112-114](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L22), todo turno de tela (seja local ou Gemini) recebe `origin: 'screen'`. A função `windowHistory` remove incondicionalmente todas as mensagens `origin: 'screen'` (de usuário e assistente) de qualquer montagem posterior de prompt para o Gemini, inclusive com `sendHistory` ligado ou desligado. |
| **3** | A marca `screen-local` não tem percurso definido nos pontos de gravação do histórico | **RESOLVIDO** | Em [phase-vision-v2.md:38-47](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L38-L47), a proveniência `turn.provenance = 'screen'` é calculada **imediatamente após a transcrição**, antes de qualquer inserção em `session.history` ([`sessionManager.ts:391`](file:///tmp/claude-501/auditV/src/backend/voice/sessionManager.ts#L391)). Em [phase-vision-v2.md:110-111](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L110-L111), `emittedSentences` passa a propagar `origin` em cada frase até o `markPlayed` ([`sessionManager.ts:916`](file:///tmp/claude-501/auditV/src/backend/voice/sessionManager.ts#L916)), blindando confirmações tardias mesmo após `activeTurn = null`. |
| **4** | "Contém a marca explícita" aceita negação ou mera citação como autorização | **RESOLVIDO** *(ver Ajuste 1)* | Em [phase-vision-v2.md:58-63](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L58-L63) e critério HV.7, foi criada uma gramática afirmativa com precedência absoluta de negações ("não", "sem", "nunca", "nem", "evita"), bloqueando o envio e forçando visão local como fail-safe. *(Nota: a sintaxe específica de citação requer ajuste técnico apontado na seção B).* |
| **5** | Janela de 90 s vaza descrições; intenção em nuvem e memórias são saídas abertas | **RESOLVIDO** | A continuação automática de 90 s foi **completamente eliminada do escopo** da v2 ([phase-vision-v2.md:33, 164](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L33)), cumprindo a decisão do usuário de que cada pergunta deve citar a tela. Turnos `screen` desviam antes de [`sessionManager.ts:489`](file:///tmp/claude-501/auditV/src/backend/voice/sessionManager.ts#L489), nunca chamam o classificador de intenção em nuvem e nunca armam mutações para gravação em memória persistente. |
| **6** | Protocolo de quadro sem correlação suficiente nem consumo único | **RESOLVIDO** | Em [phase-vision-v2.md:69-75](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L69-L75), o servidor emite SSE com `captureRequest = { captureId: uuid, turnId, deadline }`. A rota `POST /api/voice/session/:id/screen?captureId=...` valida e consome atomicamente a requisição de forma síncrona antes de ler bytes para o disco, invalidando quadros obsoletos, duplicados, concorrentes ou de turnos cancelados (HV.3). |
| **7** | Upload grava imagem antes de autenticar e recria diretórios após encerramento | **RESOLVIDO** | Em [phase-vision-v2.md:73-75](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L73-L75), a rota autentica a sessão e valida a existência do `captureId` pendente **antes** de alocar arquivos no disco. Sessões inválidas, expiradas ou encerradas são rejeitadas imediatamente (401/400) sem tocar no [`AudioStore.dirFor`](file:///tmp/claude-501/auditV/src/backend/voice/audioStore.ts#L22). |
| **8** | Limite de áudio não valida imagem nem comporta PNG de alta entropia | **RESOLVIDO** | Em [phase-vision-v2.md:71, 76-77](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L71), o formato foi migrado para JPEG qualidade 0,8 com lado maior ≤ 1280 px. O upload tem teto dedicado de 3 MiB, validação de bytes mágicos (`FF D8 FF`), validação de dimensões no cabeçalho SOF ≤ 1600×1600 no Node e teto no worker com `PIL.Image.MAX_IMAGE_PIXELS = 1600*1600`. |
| **9** | "Apagar após resposta" deixa resíduos em cancelamentos/erros e processo vivo | **RESOLVIDO** | Em [phase-vision-v2.md:118-120](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L118-L120) e critério HV.4, a posse do JPEG pertence ao turno e sua exclusão é executada num bloco `finally` idempotente em todas as saídas (resposta, falha, cancelamento, prazo, rejeição ou restart do worker). |
| **10** | Cancelamento existente não alcança comandos enfileirados no worker | **RESOLVIDO** | Em [phase-vision-v2.md:86-90](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L86-L90) e critério HV.5, o worker implementa `cancelled_turns` (anel limitado aos últimos 64 turnos). O `handle_cancel` registra o ID antes do evento de sinalização, e o `work_loop` ([`worker.py:1443`](file:///tmp/claude-501/auditV/scripts/worker/worker.py#L1443)) descarta comandos da fila sem executar. `handle_generate` e `describe_screen` checam o conjunto imediatamente antes de qualquer chamada ao Gemini ou leitura de imagem. |
| **11** | Cancelabilidade do MLX-VLM e bloqueio da fila não demonstrados | **RESOLVIDO** | Em [phase-vision-v2.md:91-92](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L91-L92) e critério HV.8, a geração local utiliza `mlx_vlm.stream_generate` checando cancelamento a cada token. A v2 reconhece tecnicamente que o prefill não é interrompível na biblioteca e estabelece um teto p95 estrito de liberação do worker (próximo STT começa em ≤ 2,5 s). |
| **12** | Cliente sem interrupção imediata em captura/aquecimento | **RESOLVIDO** *(ver Ajuste 3)* | Em [phase-vision-v2.md:127-129](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L127-L129), o estado `aquecendo` foi removido do fluxo de fala (permanece em `processando`). O botão "Interromper" passa a responder em `processando` para turnos rotulados como `TELA`. Preempção por fala continua funcionando via chegada de novo áudio ao servidor. |
| **13** | Aviso "Mandando a tela" sem barreira para ser ouvido antes do envio | **RESOLVIDO** | A promessa inviável de barreira de fala antes do despacho foi removida ([phase-vision-v2.md:103-104](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L103-L104)). A autorização é a própria fala do usuário que ordenou o Gemini (§3.2), e a interface web atualiza visualmente com timestamp através do evento SSE real de despacho (`screen_sent`). |
| **14** | `mlx-vlm` sem provisionamento do modelo no runtime offline | **RESOLVIDO** | Em [phase-vision-v2.md:93-95](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L93-L95) e critério HV.12, o modelo é provisionado no script `setup:voice` com revisão fixada do Hugging Face e cache local isolado no app (`HF_HOME`). O teste HV.12 valida a inicialização limpa com `HF_HUB_OFFLINE=1`. |
| **15** | `redact` não mascara conteúdo de tela em logs e exceções | **RESOLVIDO** | Em [phase-vision-v2.md:121-123](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L121-L123) e critério HV.11, os logs registram exclusivamente contagens e tempos em formato estruturado. Erros utilizam identificadores estruturados (`kind`) sem interpolar strings de exceções de terceiros, com teste automatizado verificando ausência de marcadores em `stdout`/`stderr`. |
| **16** | Continuação automática captura qualquer fala e interfere em mutações | **RESOLVIDO** *(ver Ajuste 2)* | Sem continuação automática (§2). Em [phase-vision-v2.md:41-43](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L41-L43), `session.pendingMutation` tem precedência absoluta sobre turnos de tela. Em [phase-vision-v2.md:53-54](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L53-L54), verbos de mutação têm precedência sobre menções à tela (HV.6). |
| **17** | Critérios de aceite fracos permitiam aprovação de desenho vulnerável | **RESOLVIDO** *(ver Ajuste 4)* | Em [phase-vision-v2.md:131-149](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L131-L149), foram estabelecidos 14 critérios rigorosos com matriz de egresso (HV.2), testes de mutação de privacidade (HV.13), testes de concorrência e upload inválido (HV.3), prazos e percentis de interrupção (HV.8) e latência máxima (HV.9). |

---

## (B) Novos Problemas Introduzidos pela v2

Abaixo constam os novos achados identificados na revisão detalhada da v2 confrontada com o código-fonte em [`src/`](file:///tmp/claude-501/auditV/src) e [`scripts/worker/worker.py`](file:///tmp/claude-501/auditV/scripts/worker/worker.py):

### ACHADO NOVO 1: Contradição na especificação da gramática de autorização para citações (§3.2 vs HV.7)
- **EVIDÊNCIA:** [docs/phase-vision-v2.md:58-63](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L58-L63) e [docs/phase-vision-v2.md:141](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L141).
- **GRAVIDADE:** ALTA.
- **CONFIANÇA:** Alta.
- **ANÁLISE:** A seção 3.2 especifica a autorização por uma busca afirmativa: `(com|usa|usando|pelo|via|pergunta (pro|ao)) (o )?gemini`, combinada a um filtro de bloqueio com negações ("não", "sem", "nunca", "nem", "evita"). Logo em seguida, a linha 62 exige: `Matriz de testes: afirmativas, negações, citações ("o que significa 'usa o gemini'?" → local)`. Porém, a frase `"o que significa 'usa o gemini'?"` contém exatamente a substring `"usa o gemini"` e não contém nenhuma palavra de negação. Se implementada exatamente como redigida nas regras 1 e 2, a expressão avalia como **autorizada para nuvem**, contradizendo o teste e autorizando o envio da tela quando o usuário está apenas lendo ou perguntando sobre uma citação da tela.
- **AÇÃO:** Ajustar formalmente a gramática na seção 3.2: a autorização deve exigir direcionamento imperativo/preposicional associado à ação do turno (ex.: no início ou fim do comando principal, como `", manda pro gemini"` / `", com o gemini"`) e descartar explicitamente prefixos interrogativos ou metalinguísticos (`/^(o que significa|o que quer dizer|como assim)\b/i`), ou envoltos em aspas.

---

### ACHADO NOVO 2: O filtro de exceção de mutação em `mightBeScreenQuery` é incompleto e engole comandos válidos de notas e lembretes (§3.1)
- **EVIDÊNCIA:** [docs/phase-vision-v2.md:53-54](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L53-L54) confrontado com [`src/shared/voiceProtocol.ts:20-30`](file:///tmp/claude-501/auditV/src/shared/voiceProtocol.ts#L20-L30) (`MUTATION_NAMES`) e [`src/backend/voice/sessionManager.ts:77-81`](file:///tmp/claude-501/auditV/src/backend/voice/sessionManager.ts#L77-L81) (`ACTION_CLAIM_VERBS`).
- **GRAVIDADE:** MÉDIA.
- **CONFIANÇA:** Alta.
- **ANÁLISE:** A seção 3.1 define: *"Decisão: 'anota'/'lembra'/'memoriza' no início vencem (mutação), para não engolir pedido de nota"*. No entanto, o sistema suporta mutações completas de lembretes, notas e memórias (`LEMBRETE_CRIAR`, `NOTA_CRIAR`, `MEMORIA_GUARDAR`) que frequentemente se iniciam com outros verbos imperativos, tais como: *"Cria um lembrete para comprar a tela nova"*, *"Salva uma nota sobre a tela quebrada"*, *"Guarda na memória que a tela deu problema"*. Segundo a regra escrita, nenhuma dessas frases começa com "anota", "lembra" ou "memoriza"; todas contêm a palavra "tela". Como o turno `screen` desvia direto para §5 antes dos detectores de mutação ([phase-vision-v2.md:46-47](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L46-L47)), o app ignorará o pedido de criação do lembrete/nota e iniciará uma captura de tela desnecessária.
- **AÇÃO:** Substituir a lista de 3 palavras pela checagem direta do detector de mutação existente no início do fluxo (`mightBeMutation(transcript)`) ou por uma expressão abrangente de intenção de mutação (`/^(cria|crie|salva|salve|guarda|guarde|anota|anote|lembra|lembre|memoriza|memorize)\s+(um\s+lembrete|uma\s+nota|na\s+mem[oó]ria)/i`), garantindo que a mutação sempre prevaleça sobre a menção incidental da palavra "tela".

---

### ACHADO NOVO 3: Trava no frontend impede que `interruptManually()` funcione no estado `processando` (§6)
- **EVIDÊNCIA:** [docs/phase-vision-v2.md:128-129](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L128-L129) confrontado com [`src/frontend/voice.ts:376-380`](file:///tmp/claude-501/auditV/src/frontend/voice.ts#L376-L380) e [`src/frontend/main.ts:271`](file:///tmp/claude-501/auditV/src/frontend/main.ts#L271).
- **GRAVIDADE:** MÉDIA.
- **CONFIANÇA:** Alta.
- **ANÁLISE:** A seção 6 estabelece: *"O botão 'Interromper' passa a funcionar também em processando somente quando o turno ativo é de tela (evento routing com rótulo novo TELA)"*. O [`main.ts:271`](file:///tmp/claude-501/auditV/src/frontend/main.ts#L271) pode habilitar o elemento HTML, mas ao ser clicado ele invoca `voiceController.interruptManually()`. No arquivo [`src/frontend/voice.ts:376-380`](file:///tmp/claude-501/auditV/src/frontend/voice.ts#L376-L380), existe a checagem explícita:
  ```ts
  interruptManually(): void {
    if (this.state === 'falando') {
      this.triggerBargeIn();
    }
  }
  ```
  Como o estado é `processando`, o clique no botão será um no-op silencioso.
- **AÇÃO:** Atualizar a especificação da Seção 6 e registrar formalmente a modificação necessária em [`src/frontend/voice.ts:376`](file:///tmp/claude-501/auditV/src/frontend/voice.ts#L376) para que `interruptManually()` dispare `triggerBargeIn()` também quando `this.state === 'processando'` e o turno ativo tiver rótulo `TELA`.

---

### ACHADO NOVO 4: Contradição na sincronização de limpeza do JPEG entre Node e Worker (§5.4)
- **EVIDÊNCIA:** [docs/phase-vision-v2.md:118-120](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L118-L120) confrontado com [`src/backend/voice/mlxWorkerEngine.ts:677-681`](file:///tmp/claude-501/auditV/src/backend/voice/mlxWorkerEngine.ts#L677-L681).
- **GRAVIDADE:** MÉDIA.
- **CONFIANÇA:** Alta.
- **ANÁLISE:** A seção 5.4 declara: *"o Node só apaga depois do describe_screen resolver ou do cancelamento confirmado"*. Entretanto, em [`mlxWorkerEngine.ts:678-681`](file:///tmp/claude-501/auditV/src/backend/voice/mlxWorkerEngine.ts#L678-L681), o Node foi projetado expressamente para **nunca** esperar confirmação do worker no cancelamento (pois o worker pode estar bloqueado em inferência e travar o loop de eventos do Node). Se o Node aguardar a confirmação do cancelamento pelo worker para apagar o JPEG, a preempção deixa de ser instantânea. Se o Node não aguardar e apagar o arquivo imediatamente num bloco `finally`, e o worker tentar ler a imagem, pode ocorrer um `FileNotFoundError` no Python.
- **AÇÃO:** Esclarecer a responsabilidade em §5.4: o Node deve registrar o cancelamento e executar a exclusão do arquivo no seu bloco `finally` local sem esperar confirmação do worker; e o worker Python deve envelopar o `PIL.Image.open()` num `try/except FileNotFoundError` que verifica `if turn_id in self.cancelled_turns`, tratando o arquivo ausente em turno cancelado como encerramento silencioso e limpo, sem log de erro.

---

### ACHADO NOVO 5: Silêncio de até 30 s na carga fria do modelo local e proximidade do watchdog (§5.1, §6)
- **EVIDÊNCIA:** [docs/phase-vision-v2.md:93-94, 127-128, 143](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L93-L94) confrontado com [`src/shared/voiceProtocol.ts:116`](file:///tmp/claude-501/auditV/src/shared/voiceProtocol.ts#L116) (`TURN_TIMEOUT_MS: 60_000`) e [`src/backend/voice/mlxWorkerEngine.ts:660-663`](file:///tmp/claude-501/auditV/src/backend/voice/mlxWorkerEngine.ts#L660-L663).
- **GRAVIDADE:** BAIXA / MÉDIA.
- **CONFIANÇA:** Alta.
- **ANÁLISE:** A v2 retirou o estado sonoro `aquecendo` para turnos de tela (*"não usa aquecendo com fala"*), mantendo o turno em `processando`. No entanto, na primeira carga fria da visão local, carregar ~4 GB do disco para a memória pode levar até 30 s (HV.9) ou 60 s (timeout do §5.1). O usuário ficará em silêncio absoluto com a mensagem estática *"Processando sua fala..."* por até 30 segundos, sem feedback visual ou sonoro de que o modelo está sendo carregado. Além disso, se a carga somada à inferência se aproximar de 60 segundos, o watchdog de turno do Node dispara `SIGKILL` no worker.
- **AÇÃO:** Adicionar feedback visual na interface (ex.: estado ou texto secundário *"Carregando modelo de visão..."*) e garantir que o timeout de comando no Node para `describe_screen` contemple o tempo de carga fria sem acionar o `SIGKILL` do motor.

---

### ACHADO NOVO 6: Critério HV.9 com redação não restritiva para o pico de memória (§7)
- **EVIDÊNCIA:** [docs/phase-vision-v2.md:143](file:///tmp/claude-501/auditV/docs/phase-vision-v2.md#L143) confrontado com achado 17 de [docs/vision-plan-codex-r1-2026-10-08.md:125](file:///tmp/claude-501/auditV/docs/vision-plan-codex-r1-2026-10-08.md#L125).
- **GRAVIDADE:** BAIXA.
- **CONFIANÇA:** Alta.
- **ANÁLISE:** Em HV.9, a latência de fala (`≤ 9 s`) e a carga de disco (`≤ 30 s`) ganharam tetos numéricos estritos. Entretanto, o pico de memória do worker está redigido como *"pico de memória do worker com os 3 modelos registrado (alvo ≤ 9 GB)"*. Em suítes de teste automatizadas, a palavra "registrado (alvo)" permite que o teste apenas imprima o valor sem emitir um `assert` que falhe o teste caso o pico atinja, por exemplo, 9,8 GB.
- **AÇÃO:** Modificar a redação de HV.9 para: *"pico de memória do worker com os 3 modelos ≤ 9,5 GB (teto rígido que falha o teste caso excedido)"*.

---

## (C) Rastreamento de Caminhos Restantes de Saída para o Gemini

Auditando exaustivamente todos os fluxos de rede, memória, arquivos e histórico:

1. **A Imagem da Tela:**
   - **Na visão local (padrão):** O arquivo JPEG é gravado exclusivamente no diretório local de sessão, lido pelo worker via `PIL.Image` no processo Python e processado localmente pelo `mlx-vlm`. Não há nenhuma requisição de rede ou fallback que redirecione a imagem para o Gemini em caso de falha. **Zero bytes de imagem saem da máquina.**
   - **Na visão em nuvem (Gemini):** A imagem só é transmitida se houver autorização explícita na fala daquele turno, `RODRIGO_CLOUD_VISION=1` e `RODRIGO_CLOUD=1`. A requisição envia unicamente a imagem e a pergunta daquele turno.

2. **A Pergunta do Turno de Tela:**
   - **No turno atual:** Não é enviada para `detectIntent` (a intenção em nuvem é explicitamente ignorada em turnos `screen`), não é enviada para geração em nuvem (a visão local desvia diretamente para o worker local) e não vai para o TTS (o TTS recebe exclusivamente o texto gerado da resposta).
   - **Em turnos seguintes:** A mensagem de entrada do usuário é gravada no histórico com `origin: 'screen'`. A função `windowHistory` filtra e descarta todas as entradas com essa marca antes de qualquer requisição posterior ao Gemini. O turno de tela também é impedido de acionar mutações ou gravar dados em `memorias.json`.

3. **A Resposta do Turno de Tela:**
   - **No turno atual:** O texto da resposta é enviado para o TTS do Gemini para conversão em áudio falado. **Esta saída foi formalmente aprovada pelo usuário na Seção 0** (*"Voz do Gemini mesmo — uma voz só, mais natural; mas o TEXTO da resposta sobre a tela vai ao Google"*). Se `RODRIGO_CLOUD_TTS=0`, o texto é sintetizado localmente via `say`.
   - **Em turnos seguintes:** Gravada no histórico via `markPlayed` com `origin: 'screen'`. Descartada por `windowHistory` em qualquer chamada futura de geração de texto.

**Conclusão do Item C:**  
Ressalvada a necessidade de calibrar a gramática de autorização (Achado Novo 1, para evitar que uma citação na pergunta ative indevidamente a visão em nuvem), **não resta nenhum caminho pelo qual a imagem ou o par pergunta/resposta de um turno de tela escape para o Gemini fora do que a seção 0 declara expressamente aprovado.**

---

## (D) Análise dos Critérios de Aceite (§7)

Os critérios de aceite do §7 representam um salto substancial de rigor em relação à v1 e **falham objetivamente** em caso de implementação incorreta:

1. **HV.2 (Matriz de Egresso com Canários):** Utiliza um servidor Gemini mock em loopback inspecionando todos os corpos JSON enviados (`generate_content`, `intent`, `tts`). Marcadores plantados na imagem, na pergunta e na resposta provam objetivamente que:
   - A imagem só aparece na API de visão quando autorizada.
   - Pergunta e resposta nunca aparecem nos endpoints de geração e intenção dos 20 turnos subsequentes.
   - Qualquer falha na remoção do histórico em `windowHistory` quebra o teste imediatamente.
2. **HV.3 (Consumo Atômico de `captureId` e Validação de Upload):** Garante falha objetiva caso requisições duplicadas, expiradas, concorrentes ou com imagens adulteradas (> 3 MiB, sem cabeçalho JPEG ou > 1600 px) deixem qualquer arquivo gravado em disco.
3. **HV.4 (Limpeza de Disco):** Realiza asserção no sistema de arquivos varrendo `.runtime/tmp/` após cada saída do ciclo de vida, falhando se restar qualquer arquivo `.jpeg`.
4. **HV.5 (Descarte de Fila Cancelada):** Valida via teste Python e mock de rede que comandos cancelados na fila do worker não disparam chamadas externas.
5. **HV.8 (Tempo de Liberação em Barge-in):** Impõe teto numérico de `p95 ≤ 2,5 s` em 20 medições para que o worker esteja livre para transcrever áudio após interrupção.
6. **HV.11 (Higiene de Logs):** Captura `stdout` e `stderr` dos processos Node e Python, falhando caso canários plantados na pergunta ou imagem vazem em logs de diagnóstico ou traces de exceção.
7. **HV.13 (Prova de Mutação):** Exige mutação proposital do código removendo cada barreira de segurança (ex.: remover o filtro `screen` de `windowHistory`, remover a checagem de negação, desativar o consumo de `captureId`) para certificar que os testes correspondentes de fato falham.

**Conclusão do Item D:**  
Os critérios do §7 são sólidos e verificáveis programaticamente, necessitando apenas do pequeno ajuste redacional no critério HV.9 para transformar o teto de memória em asserção rígida.

---

## Veredito Final

### **APROVAR COM AJUSTES**

O plano **phase-vision-v2.md** resolveu com sucesso os 17 achados da rodada anterior, estabeleceu um protocolo seguro de captura de uso único, blindou o cancelamento de comandos enfileirados e respeitou rigorosamente as decisões de arquitetura e privacidade fixadas pelo usuário na Seção 0. 

Os 4 ajustes técnicos descritos abaixo devem ser incorporados ao texto do plano antes de iniciar a codificação:

1. **Ajuste na Gramática de Autorização (§3.2):** Exigir amarração imperativa/preposicional na autorização e descartar perguntas metalinguísticas ou de citação para cumprir o teste `"o que significa 'usa o gemini'?" → local`.
2. **Ajuste na Precedência de Mutações (§3.1):** Integrar `mightBeMutation` ou ampliar a lista de verbos imperativos (`cria`, `salva`, `guarda`) para impedir que lembretes e notas incidentais sobre a tela sejam classificados como visão.
3. **Ajuste no Frontend para Interrupção Manual (§6):** Adequar `src/frontend/voice.ts:376` para permitir a execução de `triggerBargeIn()` quando o estado for `processando` e o turno for `TELA`.
4. **Ajuste na Sincronização de Limpeza do JPEG (§5.4):** Não bloquear o Node aguardando confirmação do worker para apagar o JPEG no `finally`; em contrapartida, instruir o worker a tratar `FileNotFoundError` como encerramento limpo se o turno estiver em `cancelled_turns`.
