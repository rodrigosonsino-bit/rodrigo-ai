# Fase 5c — Lembretes e notas com confirmação obrigatória: relatório de implementação

Data: 2026-09-23
Base: commit `1ed8b33` (`Rodrigo AI v0.3.0` — versão do `package.json` não foi bumpada)
Plano implementado: `docs/phase-5c-v5.md`, combinação de 5 versões (v1 define o desenho; v2-v5
corrigem achados de auditoria em cima da anterior — cada versão só documenta o que mudou).

---

## 1. O que foi entregue

`LembreteTool` e `NotaTool` (`src/backend/tools/mutatingTools.ts`) criam e apagam lembretes/notas
por voz — a primeira capacidade do projeto que **muta estado** (tudo antes, Fases 1-5b, só lê).
Persistência em `data/lembretes.json`/`data/notas.json` (fora de `.runtime/`, que é regenerado por
`npm run setup:voice`, e fora do controle de versão). Nenhuma mutação executa sem confirmação
falada: o sistema detecta a intenção, faz a pergunta, e só executa depois de um "sim" real.

**A garantia central, e como ela é sustentada:** a pergunta de confirmação não autoriza a mutação
diretamente — ela arma um estado intermediário (`session.armedMutation`) que só é promovido a
`session.pendingMutation` **dentro de `markPlayed()`**, o método que o projeto já usa desde a Fase
2 para nunca gravar no histórico de conversa uma fala que o usuário não ouviu (proteção contra
barge-in). A Fase 5c reusa essa garantia já testada em vez de inventar uma paralela mais fraca —
decisão que só surgiu na 3ª rodada de auditoria, depois de duas tentativas com um mecanismo próprio
mais frágil (ver §2).

**Novos:** `src/backend/tools/mutatingTools.ts`, `src/backend/storage/jsonStore.ts`,
`src/backend/__tests__/{mutatingTools,storage}.test.ts`, `scripts/worker/test_mutation_parser.py`
(standalone, mesmo padrão de `test_tool_parser.py`). **Modificados:** `worker.py`
(`detect_mutation`/`detect_confirmation`, despacho nos dois pontos de
`stdin_reader_loop`/`work_loop`), `mlxWorkerEngine.ts`/`fakeEngine.ts`/`engine.ts` (mesmo padrão de
`detectTool` da 5b — timeout sem `SIGKILL`), `sessionManager.ts` (`armedMutation`/`pendingMutation`
em `Session`, `markPlayed()` estendido), `voiceRuntime.ts`, `registry.ts`, `.gitignore` (`data/`).

---

## 2. Processo: 5 versões, 4 rodadas de auditoria, 3 fornecedores diferentes

| Versão | Auditor / modelo | Veredito | Achado central |
|---|---|---|---|
| v1 | Hermes / longcat-2.0 | REJEITADO (1 ALTA + 6 média/baixa) | pseudocódigo incompleto, nada de desenho |
| v2 | agy / Gemini 3.8 Flash | REJEITADO (2 ALTA + 6 média/baixa) | camada de palavra-chave usava substring — "Isso tá errado" e "Pode esquecer" (recusas) casavam como confirmação positiva |
| v3 | Codex / gpt-5.6-sol | REJEITADO (2 ALTA + 4 média + 3 baixa) | **o achado mais profundo da fase**: "entrega confirmada" da v3 provava só que a síntese TTS tinha terminado, não que o usuário tinha ouvido a pergunta |
| v4 | Hermes / longcat-2.0 | APROVADO COM RESSALVAS | correção central (reuso de `markPlayed()`) confirmada sólida por execução; 3 dos 6 achados de "parte B" eram falsos — citavam estado de versões já superadas (ver nota abaixo) |
| v5 | — | aprovada para implementação | corrige os 2 achados reais da v4 (try/catch em `preview()`; mitigação de duplicata em `*_CRIAR`) |

**Nota metodológica desta fase, sem precedente nas anteriores:** na rodada 4, três dos seis achados
de auditoria aberta foram **conferidos contra o texto atual dos documentos antes de qualquer ação**
— e revelaram-se falsos, citando arquivo:linha de conteúdo que já tinha sido corrigido em versões
anteriores. A disciplina "não aceitar autodeclaração do subagente" (já em vigor para
implementação) foi estendida aqui para "não aceitar achado de auditoria sem reler o arquivo que ele
cita" — um achado com citação precisa de arquivo:linha não é, por si, prova de que o arquivo ainda
diz aquilo. Detalhe completo em `docs/phase-5c-v5.md` §1.

Quatro fornecedores/modelos diferentes auditaram esta fase ao todo (Hermes, agy, Codex, Hermes de
novo) — nenhum fechou sozinho todas as rodadas.

---

## 3. Implementação: uma rodada de correção necessária

Implementado por `agy` (modo `accept-edits`). A primeira execução produziu 3 testes falhando e um
bug de infraestrutura real: um teste que falha não fechava o servidor HTTP que tinha aberto,
travando `npm test` para sempre (confirmado com `kill -SIGUSR2` e inspeção de handles TCP
referenciados — mesmo padrão de falha silenciosa já catalogado no `CLAUDE.md` global do usuário).
Devolvido ao `agy` com os três defeitos nomeados, não corrigido diretamente:

1. Texto de `preview()` divergia do texto esperado pelo próprio teste que o `agy` escreveu —
   cosmético, alinhado.
2. Teste do achado central (barge-in) esperava HTTP 400; o real era 401. **Confirmado contra
   `routes.ts` real antes de aceitar a correção**: `markPlayed()` retornando `false` gera 401, não
   400 — o teste tinha o valor errado, não o código. `agy` corrigiu o teste com a justificativa
   correta, verificada.
3. `tool.preview()` sem `try/catch` deixava uma falha cair no caminho normal (resposta genérica do
   modelo) em vez de falar `MUTATION_FAILURE_TEXT` — bug real de implementação, corrigido.
4. Todos os testes da Fase 5c ganharam `afterEach()` para fechar o harness mesmo quando a asserção
   lança — resolve o travamento.

**Verificado de forma independente antes do commit** (não a autodeclaração do `agy`): `npm run
build` limpo; `npm test` rodado do zero por mim, terminou sozinho sem travar, **100/100** (era
76/76 antes da 5c); `test_mutation_parser.py` **32/32**; os dois pontos de despacho no `worker.py`
confirmados por `grep`; timeout sem `SIGKILL` confirmado; `performance.now()` confirmado;
`package.json` e `docs/` intocados.

---

## 4. Auditoria de código: aprovado com mutation testing

Hermes rodou a suíte, leu `sessionManager.ts` inteiro à procura de qualquer escrita de
`pendingMutation` fora de `markPlayed()` (achou uma única, na linha correta), e quebrou 3
propriedades de propósito para confirmar que a suíte acusa cada uma:

| Mutação | Pega pela suíte? |
|---|---|
| Remove a checagem de `lastTurnId` em `markPlayed()` (proteção contra barge-in) | ✅ |
| `JsonStore.read()` engole qualquer erro como "vazio" | ✅ |
| `keywordConfirmation` vira substring em vez de whitelist exata | ✅ |

**Veredito: APROVADO COM RESSALVAS**, ambas BAIXA e sem afetar a garantia central:

1. Normalização Unicode (NFD) permite contornar a whitelist de confirmação com grafemas raros
   (`"sïm"` → `"sim"`) — superfície de ataque praticamente nula numa pipeline só de voz (Whisper
   nunca produz isso de fala natural). Aceito, não mitigado.
2. `markPlayed()` duplica entrada no histórico de conversa se chamado duas vezes para o mesmo
   `turnId` — **comportamento herdado da Fase 2**, não introduzido pela 5c (a função já fazia isso
   antes; a 5c só estendeu o corpo, por decisão deliberada do plano de não arriscar reescrever o que
   já funciona — v4 §5, achado 1). Fora do escopo desta fase.

Log completo: `docs/audits/phase-5c-codigo-hermes-2026-09-23.log`.

---

## 5. H-mutação e H-confirmação — verificação com MLX real: **NENHUM DOS DOIS CRITÉRIOS PASSOU**

`scripts/h5c-check.mjs`: variante de dois turnos de `h11-check.mjs`. Turno N pede a mutação e
confirma reprodução real via `/played` (é isso que promove `armedMutation` para `pendingMutation`,
`sessionManager.ts` `markPlayed()`); turno N+1 confirma ou nega. Resultado conferido pela fala E
pelo arquivo `data/lembretes.json` real (`RODRIGO_DATA_DIR` isolado, nunca `data/` de produção —
ver §6 abaixo). Amostras congeladas por uma IA independente (Hermes, que nunca viu
`DETECT_MUTATION_SYSTEM_PROMPT`/`DETECT_CONFIRMATION_SYSTEM_PROMPT`), mesmo protocolo da Fase 5b:
`docs/audits/phase-5c-v6-h-mutacao-sample-2026-09-23.md` (17 frases) e
`docs/audits/phase-5c-v6-h-confirmacao-sample-2026-09-23.md` (18 frases). Relatório completo:
`docs/audits/phase-5c-v6-result-2026-09-23.json`.

**A primeira execução real do script encontrou um bug real nele mesmo antes de medir qualquer
coisa do sistema**: o parser da amostra não tinha escopo — lia qualquer linha `"N. texto"` do
arquivo `.md` inteiro, inclusive a lista de exemplo dentro do bloco de prompt reproduzido na seção
"Prompt usado para gerar a amostra". Um 18º caso fantasma ("DIRETA E CURTA — a forma mais óbvia...")
foi enviado como frase real e quebrou o classificador do worker. Corrigido (parser agora isola a
seção "## As N frases" antes de extrair casos) e a bateria foi refeita do zero antes de qualquer
número ser aceito como resultado — mesma disciplina de "validar o harness antes de tratar sua
saída como evidência" que já existe no projeto.

### H-mutação: 13/17 = 76,5% — **NÃO ATINGIU a meta de ≥80%**

| # | Frase | Transcrição real (Whisper) | Resultado |
|---|---|---|---|
| 5 | "Você pode me ajudar a não deixar essa data passar?" | idêntica | não armou — resposta conversacional genérica, `detect_mutation` não reconheceu a intenção indireta |
| 9 | "Ah, deixa isso registrado pra mim." | "Aaaaah, deixa isso registrado pra mim." | não armou — respondeu "Claro, anotado" sem de fato criar nada |
| 11 | "Amanhã é aniversário da minha mãe, então me acorda cedo, tá?" | "A manhã é aniversário..." | não armou — respondeu como conversa social, ignorou o pedido de lembrete embutido |
| 14 | "Depois que eu sair do trabalho, tem uma carta que eu preciso achar, me dá um toque." | idêntica (STT ok) | não armou — o modelo **alucinou instruções de onde a carta estaria guardada**, resposta inteira inventada |

As quatro falhas são pedidos genuinamente indiretos/embutidos (grupos 2 e 3 da amostra, por
desenho) — nenhuma tem problema de transcrição. O caso #14 é o mais grave: não é só "não detectou",
é uma alucinação de conteúdo específico sem base nenhuma, no mesmo padrão de invenção que H11 da
Fase 5b já tinha flagrado como o comportamento que essas fases inteiras existem para eliminar.

### H-confirmação: 16/18 = 88,9% geral (meta ≥90%) **E 1 falso SIM sobre negação clara (meta: zero)**

| # | Frase | Transcrição real (Whisper) | Resultado |
|---|---|---|---|
| 7 | "beleza, deixa registrado" (esperado SIM) | "Beleza? Deixe a registrado." | detectado NAO — falso negativo (direção segura, mas erro de cobertura) |
| 15 | "nah, nem rola" (esperado NAO) | STT produziu saída degenerada (repetição de caracteres) | acertou NAO por acaso — a transcrição em si já estava corrompida antes de chegar ao detector |
| **18** | **"nem, depois eu faço" (esperado NAO)** | **"E, depois eu faço."** — Whisper **engoliu a palavra "nem"**, a única palavra de negação da frase | **"Lembrete criado." — executou a mutação que o usuário tinha negado** |

**O caso #18 é o achado central desta medição.** É exatamente o pior caso que `docs/phase-5c-v5.md`
§7 nomeia como motivo da tolerância zero: o STT perdeu a única palavra de negação da frase antes de
qualquer detecção rodar, o `detect_confirmation` recebeu texto que soa afirmativo ("E, depois eu
faço") e classificou como SIM, e o sistema **criou um lembrete real que o usuário havia recusado**.
A garantia de "nunca muta sem confirmação ouvida" (§1 deste documento) se sustenta — a pergunta foi
feita e reproduzida antes de qualquer coisa ser armada; o que falhou foi a camada de STT
**antes** da confirmação, um ponto que a arquitetura da fase não cobre porque assume (corretamente
para o código, incorretamente para o pipeline completo) que a transcrição chega intacta ao detector.
Contra-verificado no arquivo real: `data/lembretes.json` do diretório de teste isolado tem 9 itens
após a bateria — 8 confirmações SIM corretas mais este falso positivo, número que bate exatamente
com o relatório (nunca aceitar a autodeclaração do script sem conferir o artefato).

Nenhuma mudança foi feita no prompt, no filtro, no gate de deduplicação ou no código em resposta a
este resultado. Como na Fase 5b, a decisão de como (e se) mitigar fica para uma sessão futura,
deliberadamente — inclusive a pergunta de se a mitigação certa é no STT (ex.: normalizar
transcrições curtas de uma palavra contra uma whitelist antes do detector) ou em alguma camada de
verificação adicional sobre `pendingMutation`.

---

## 6. Decisão §3.3 do handoff — isolamento de dados de teste

`voiceRuntime.ts` passou a respeitar `RODRIGO_DATA_DIR` (se definida) no lugar do `data/` fixo em
`rootDir` — mesma lógica de injeção de `baseDir` que `AudioStore`/`JsonStore` já usavam, só que
agora também configurável por variável de ambiente porque `createVoiceRuntime()` não recebe esse
parâmetro do chamador (`server.ts`). Esta bateria rodou inteira contra `/tmp/rodrigo-h5c-data`,
nunca tocando `data/` do repositório — `data/` continua não existindo no working tree.

---

## 7. Estado da fase

**IMPLEMENTADA, COM CÓDIGO AUDITADO, MEDIDA COM MLX REAL — NENHUM DOS DOIS CRITÉRIOS BLOQUEANTES
PASSOU.** Mesmo padrão de honestidade da Fase 5b (H11: 75%, abaixo da meta): a fase não é
apresentada como pronta porque a medição real, definida antes de qualquer execução
(`docs/phase-5c-v5.md` §7), não passou.

- **H-mutação: 76,5%** (meta ≥80%) — quatro falhas, todas pedidos indiretos/embutidos genuínos, uma
  delas (#14) uma alucinação de conteúdo, não só uma detecção perdida.
- **H-confirmação: 88,9% geral** (meta ≥90%) **e 1 falso SIM sobre negação clara** (meta: zero,
  bloqueante por si só independente da porcentagem) — causado por perda da palavra de negação no
  STT antes do detector rodar.
- Nenhuma pendência escondida: os dois números, o achado do falso positivo e o bug do harness
  encontrado e corrigido no meio do processo estão registrados aqui, na íntegra, sem arredondar pra
  cima. Decisão sobre próximos passos (mitigar agora vs. seguir roteiro e voltar depois, mesma
  postura já adotada para a Fase 5b) fica para o usuário.

---

## 8. Mitigação do falso SIM — implementada e auditada (2026-09-23, mesmo dia)

O achado de segurança do §5 (falso SIM sobre negação, caso #18) foi mitigado no mesmo dia da
medição. Processo completo, do plano ao código:

- **Plano v7** (`docs/phase-5c-v7.md`) — rodada 1 de auditoria (`agy`): **REJEITADO**, achado
  crítico real e confirmado (gate posicionado fora do bloco que deveria restringi-lo, quebraria
  `"com certeza"`, já na whitelist da Camada 0). Log: `docs/audits/phase-5c-v7-agy-rodada1-2026-09-23.log`.
- **Plano v8** corrige os 7 achados da rodada 1 — rodada 2 (`agy`, mesma ferramenta, regra da
  skill permite até a 2ª rodada): **APROVADO COM RESSALVAS**, 6/7 achados confirmados resolvidos
  por execução real em Node.js contra 9 frases de colisão adversarial; 4 ressalvas vinculantes
  (marcadores cobriam só o verbo "criar", faltava "nada" no veto de negação, Whisper expande "tá"
  para "está", inconsistência entre o prompt da amostra e a lista de marcadores). Log:
  `docs/audits/phase-5c-v8-agy-rodada2-2026-09-23.log`.
- **Plano v9** (`docs/phase-5c-v9.md`) aplica as 4 ressalvas — decisão de não gastar rodada 3
  (mudanças mecânicas em listas já testadas) informada por consulta ao Jev/TypeSafe (98% de
  confiança pela aplicação direta).
- **Implementação**: delegada ao `agy` em modo `accept-edits` (primeira vez nesta sessão que uma
  ferramenta externa escreve código de produção diretamente, não só audita) — `src/backend/voice/
  sessionManager.ts` (gate + `hasAffirmativeMarker` + `AFFIRMATIVE_MARKERS`/`NEGATION_MARKERS`) e
  `src/backend/__tests__/mutatingTools.test.ts` (testes da função pura). **Verificado
  independentemente antes de aceitar** (nunca só a autodeclaração): diff revisado linha a linha —
  posição do gate dentro do bloco `if (confirmed === null)` confirmada contando as chaves à mão —
  e `typecheck`/`build`/`test` rerodados do zero, 106/106.
- **Auditoria de código** (Hermes, `docker exec hermes hermes -z`, material copiado — só código e
  testes, nunca `docs/research/`): **APROVADO COM RESSALVAS**. Confirmou por execução real (116
  casos adversariais, script Node próprio) que o achado crítico da rodada 1 do plano não se
  repetiu no código, e que `scripts/worker/worker.py` ficou intocado. 3 ressalvas reais:
  1. `'esta bom'` faltando (mesmo padrão do par `'ta valendo'`/`'esta valendo'`, só que numa
     palavra diferente) — corrigido.
  2. Testes cobriam só a função pura `hasAffirmativeMarker`, não o fluxo de integração no
     `SessionManager` — dois testes novos adicionados em `voice.test.ts`: um prova que `"com
     certeza"` (Camada 0) nunca aciona `detectConfirmation` nem o gate; outro é a regressão direta
     do caso #18 real através do fluxo HTTP/SSE completo, não só da função isolada.
  3. **Limite estrutural, documentado, não corrigível por código**: o gate só vê o texto da
     transcrição — se o Whisper engolir a palavra de negação e o texto residual coincidir com um
     marcador afirmativo (ex. `"não, pode fazer"` → STT `"pode fazer"`), o gate não tem como saber
     que houve negação. Protege o padrão real do caso #18 (resíduo sem nenhum marcador), não o
     caso geral de perda de negação. Documentado no código (comentário em `AFFIRMATIVE_MARKERS`)
     e com teste que nomeia o limite explicitamente, em vez de fingir que não existe.
  Log completo: `docs/audits/phase-5c-v9-codigo-hermes-2026-09-23.log`.
- **Estado final, verificado por mim antes de escrever isto**: `npm run typecheck`, `npm run
  build` e `npm test` rodados do zero — **110/110 passando** (104 de antes da mitigação + 6 da
  função pura + 2 de integração do gate — a contagem exata mudou entre rodadas conforme achados
  novos pediam testes novos; o número que vale é o último, medido agora).

**Nada disto remedeu H-mutação** (§5, 76,5%) — continua fora de escopo, gap reconhecido, não
resolvido. Falta ainda, antes de considerar o falso SIM oficialmente corrigido: medir de novo
contra uma amostra hold-out nova (protocolo de congelamento — commitar a implementação primeiro,
só depois pedir a amostra, prompt já congelado em `docs/phase-5c-v9.md` §6).

## 9. Remedição de H-confirmação contra amostra hold-out nova (2026-09-24): **NÃO PASSOU — coverage caiu para 61,1%, mas a propriedade de segurança se manteve e foi observada em ação de verdade**

Ordem exigida por `docs/phase-5c-v8.md` §6.4 cumprida integralmente antes de pedir a amostra:
plano v9 auditado e commitado, implementação + testes commitados (§8 acima), auditoria de código
Hermes aplicada e commitada — só então a amostra foi solicitada (`docs/audits/
phase-5c-v9-h-confirmacao-sample-2026-09-24.md`; duas rodadas de geração pelo Hermes, a primeira
rejeitada por cópia verbatim dos exemplos do prompt e uma frase corrompida). Amostra congelada e
commitada antes de qualquer medição (`d345852`).

**Bateria rodada contra o servidor real** (`.runtime` já configurado, `npm run build` limpo,
`scripts/h5c-check-v9-confirmacao.mjs` — cópia de `h5c-check.mjs` rodando só H-confirmação, já
que H-mutação está fora de escopo desta remedição), TTS via `say -v Luciana` alimentando o
pipeline MLX real (Whisper + Qwen3 + `DETECT_CONFIRMATION_SYSTEM_PROMPT` + gate v9), 18 casos
reais, dois turnos cada (armar pendingMutation + confirmar), `markPlayed()` real em cada um.

**Resultado: 11/18 = 61,1% geral (meta ≥90% — NÃO PASSOU), 0 falso SIM sobre negação clara (meta
0 — PASSOU).** Relatório bruto: `docs/audits/phase-5c-v9-result-2026-09-24.json`; log do
servidor: `docs/audits/phase-5c-v9-server-log-2026-09-24.log`.

**Isto é pior em porcentagem bruta que a medição do §5 (88,9%)**, mas as duas amostras não são
diretamente comparáveis — são conjuntos de frases diferentes, gerados em rodadas diferentes por
um gerador (Hermes) que produz variações imprevisíveis a cada chamada. O que importa não é a
comparação de porcentagem entre amostras distintas, é decompor **onde** os 7 erros desta amostra
vieram, porque as duas causas são estruturalmente diferentes:

- **3 casos (n.3, n.4, n.9) o gate v9 nunca chegou a atuar** — o log do servidor confirma que
  `[mutation][gate]` não disparou antes deles. A própria Camada 1 (LLM `detectConfirmation`) já
  classificou como NAO. Isto não é um efeito colateral da mitigação — é o mesmo tipo de gap de
  generalização do detector de confirmação que já existia antes do gate (frases coloquiais fora
  do que o prompt/exemplos da Camada 1 cobrem: "manda bala", "show, pode tocar", e um caso onde o
  Whisper transcreveu "beleza, deixa comigo" como "Beleza? Deixe-a comigo." — pontuação e
  conjugação mudam o sentido percebido pelo LLM).
- **4 casos (n.1, n.2, n.5, n.6) o gate v9 rebaixou de fato** — a Camada 1 disse SIM, mas nenhuma
  entrada de `AFFIRMATIVE_MARKERS` bateu no texto original ("anota aí pra mim", "opa, tô dentro",
  "boa ideia, vai fundo", e um caso onde o Whisper destruiu "confere" virando "com feri"). Este é
  exatamente o risco que `docs/phase-5c-v7.md` §4 já havia nomeado antes de implementar: o gate
  troca falsos SIM perigosos por falsos NAO seguros em frases afirmativas que a lista de
  marcadores não cobre. O risco previsto se materializou, na direção prevista (fail-closed, nunca
  fail-open) — não é uma surpresa, é o trade-off assumido conscientemente em troca de zero
  tolerância à negação.
- **1 caso (n.18, "nem mandou bem, desiste", NAO esperado) o gate v9 capturou uma reincidência real
  do padrão original do caso #18** — o Whisper engoliu a negação e transcreveu "Ninguém do bem
  desiste.", a Camada 1 leu isso como SIM, e o gate rebaixou corretamente para NAO porque nenhum
  marcador afirmativo bateu no resíduo. **Esta é a primeira vez que o mecanismo do gate foi
  observado prevenindo, em execução real contra MLX real, exatamente a classe de falha que
  motivou todo o plano v7→v9** — não é mais só teoria de código ou teste unitário sintético.

**Honestidade sobre o que isto significa:** a propriedade de segurança que a fase inteira existe
para garantir (nunca executar uma mutação que o usuário negou) se manteve — zero falsos SIM em
duas medições reais consecutivas (§5 e aqui), incluindo um caso onde o gate interveio de verdade.
Mas o critério de cobertura (H-confirmação ≥90%) segue **não atendido**, e a causa majoritária
(4 dos 7 erros) é justamente o gate que acabamos de adicionar — cobertura de marcadores
afirmativos coloquiais continua incompleta, e ampliar `AFFIRMATIVE_MARKERS` indefinidamente para
perseguir cada nova frase que o Hermes inventa não escala (a lista já cresceu de v7 para v9 e o
problema de fundo — um detector de Camada 1 que não generaliza bem para afirmações coloquiais
raras — continua sem solução estrutural). Isto não foi decidido nem mitigado nesta sessão; é um
gap real, aberto, na mesma classe de honestidade do H11 da Fase 5b e do H-mutação do §5 acima —
registrado aqui, não escondido, sem resolução automática proposta.

## 10. Decisão de fechamento da fase (2026-09-24): gap de cobertura aceito, fase não bloqueia o roteiro

Consultado o Jev (TypeSafe) antes de decidir — não para decidir por mim, para não confiar só em
julgamento não-calibrado numa escolha de "vale investir mais agora ou seguir": `proximo_passo`
(choice) favoreceu `aceitar_e_seguir` (57%) sobre `redesenhar_camada1` (40%), com confiança baixa
(0,35) — genuinamente dividido, não um veredito forte — mas **descartou quase por completo**
continuar expandindo `AFFIRMATIVE_MARKERS` linha por linha (`expandir_lista`, 3%), confirmando
que essa via já esgotou o retorno. `vale_investir_agora` (noul) = 0,35, pesando contra investir
agora. `risco_de_deixar_em_aberto` (score) = 1,07/2, dominante em "médio" (58%) — **não** "baixo",
então a decisão abaixo não trata isto como inofensivo, trata como um trade-off consciente.

**Decisão do usuário, informada por essa consulta:** documentar o gap como está e seguir para o
próximo item do roteiro, sem investir agora numa rodada de plano+auditoria para redesenhar a
Camada 1 do detector de confirmação.

**Estado final da Fase 5c, registrado sem eufemismo:**
- Implementada, code-audited (Hermes), com a garantia central (nunca mutar sem confirmação real
  de voz, via `markPlayed()`) validada em produção-símile (execução real contra MLX) e o gate v9
  comprovadamente funcional contra pelo menos um caso real de STT engolindo negação.
- **H-mutação: 76,5% (meta ≥80%) — NÃO PASSOU.** Fora de escopo desde o plano v7 §0; não
  remedido.
- **H-confirmação: 61,1% na amostra mais recente (meta ≥90%) — NÃO PASSOU**, com zero falso SIM
  sobre negação clara medido duas vezes reais consecutivas (o critério de segurança, o mais
  importante dos dois por desenho da fase, foi atendido nas duas).
- Estes dois gaps somam-se ao H11 da Fase 5b (75%, meta ≥80%) como pendências reconhecidas e
  aceitas por decisão explícita do usuário, não escondidas, não bloqueando as fases seguintes —
  mesmo padrão de honestidade nas três.
- `Rodrigo AI` segue funcional e testado no que foi implementado; os três gaps de cobertura ficam
  registrados como dívida técnica conhecida, candidatos a revisão futura se o usuário decidir
  investir numa reformulação estrutural do detector de confirmação de Camada 1 (não decidido
  agora).

O roteiro segue para a **Fase 6** (memória entre sessões, ver `docs/phase-5a-v1.md` e
`docs/phase-5c-v1.md` para as referências de escopo já registradas em fases anteriores).
