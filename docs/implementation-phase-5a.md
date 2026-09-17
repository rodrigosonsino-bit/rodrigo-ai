# Fase 5a — Conhecimento especializado: relatório de implementação

Data: 2026-09-17
Base: commit `cc9d9d7` (`Rodrigo AI v0.3.0`)
Plano implementado: `docs/phase-5a-v5.md`, com as 9 correções da 5ª auditoria aplicadas
diretamente no código (ver §2).

---

## 1. O que foi entregue

Os agentes de **Teologia** e **Virtologia** passam a consultar o material-fonte do próprio Rodrigo
(`docs/research/`) antes de responder: um trecho relevante é recuperado por BM25 léxico local e
injetado no system prompt do turno, entre o prompt do agente e o bloco universal de segurança.

`GERAL` e `AMBIGUO` continuam com o prompt **byte a byte idêntico** ao da Fase 4 — asserido em teste.

**Novos:** `src/backend/knowledge/{corpus,retriever,index}.ts`,
`src/backend/__tests__/knowledge.test.ts`.
**Modificados:** `voiceProtocol.ts` (`KNOWLEDGE_LIMITS`), `extensions/registry.ts`
(`registerKnowledge`, `resetForTesting`, 5º módulo), `extensions/tools.ts` (comentário de fase),
`voice/voiceRuntime.ts`, `voice/sessionManager.ts`, `scripts/bench-voice.mjs`,
`scripts/matrix-c6.mjs` (parametrização por `RODRIGO_CASES`), `__tests__/extensions.test.ts`,
`__tests__/voice.test.ts`.

---

## 2. Processo: 5 auditorias, 66 achados, e a decisão de parar de auditar

| Versão | Autor | Auditor | Achados | Motivo central da rejeição |
|---|---|---|---|---|
| v1 | Claude | `agy` | 12 | IDF inflado por stopword faltante (`dentro`) |
| v2 | Claude | `agy` | 9 | truncamento de prefixo quebra `perdoar`/`perdão` |
| v3 | subagente | Codex | 28 | stemmer artesanal colide `medo`/`medida`, `ponte`/`ponto` |
| v4 | Claude | `agy` | 8 | `splitByParagraph` não subdivide; falta `sem` nas stopwords |
| v5 | Claude | `agy` (rotação impossível — cota do Codex) | 9 | estouro de teto por concatenação; F10.9 oco; falta `voce`/`meu` |

As rodadas 1 a 3 mataram **o desenho** (a abordagem de normalização morfológica era uma família
condenada). As rodadas 4 e 5 acharam **defeitos de implementação**: estouro por concatenação, import
faltando, stopword faltando, caso de teste vazio. Essa é a classe que um compilador e um teste
unitário pegam em segundos — e estava custando 90 minutos de auditoria por rodada.

**Decisão do usuário (2026-09-17):** corrigir os 9 achados direto no código, pular a 6ª auditoria, e
**travar as invariantes em teste** em vez de em prosa auditada. O Gate 2 (verificação com áudio real)
continuou valendo integralmente.

Limitação de rotação registrada: a rodada 5 rodou no `agy`, que também auditou v1, v2 e v4 — a cota
da conta OpenAI (Codex) estava esgotada, e `chatgpt.com` compartilha o mesmo orçamento. **A aprovação
de uma rodada nessas condições não é equivalente a uma com auditor independente.**

---

## 3. Testes: de 39 para 62

Os testes novos travam exatamente o que as auditorias 4 e 5 encontraram — e como **propriedades**,
não exemplos, porque foram exemplos escolhidos à mão que deixaram os defeitos passar:

- **Propriedade:** nenhum trecho excede `MAX_CHUNK_CHARS`, verificada em 500 entradas geradas
  (parágrafos de 10 a 4.000 chars, com e sem pontuação). Antes de escrever o código, a mesma
  propriedade foi verificada em 3.000 entradas — 0 violações.
- **Propriedade:** nenhum conteúdo é descartado pela segmentação.
- **Regressão específica:** texto que precede uma fatia dura não é concatenado nela (o estouro real
  de 1.213 chars com teto de 1.200 que a 5ª auditoria achou).
- **Exaustivo:** toda variante da tabela de apelidos normaliza para a canônica — possível porque o
  domínio é fechado, que é a vantagem que justificou preferir apelidos a stemmer.
- **Integração:** com `FakeVoiceEngine` capturando `messages`, o corpo do trecho recuperado está no
  prompt que chega ao motor; `GERAL` não contém o preâmbulo; consulta sem casamento não injeta nada;
  o evento `routing` é emitido **exatamente uma vez** por turno.

`npm test`: **62 testes, 62 passam, 0 falham.**

---

## 4. Gate 2 — verificação com MLX real

Servidor real (`node dist/server/backend/index.js`, porta 4600), LLM `Qwen3-4B-Instruct-2507-4bit` +
`whisper-small-mlx`, áudio sintetizado. A medição "antes" usa **o mesmo código** com
`docs/research/` temporariamente fora do alcance — corpus ausente ⇒ retriever `null` ⇒ comportamento
idêntico ao da Fase 4. O corpus foi restaurado e conferido ao fim.

### 4.1 Latência, par-a-par, mesmo conjunto de perguntas

| Conjunto | mediana antes | mediana depois | Δ | p95 antes | p95 depois | Δ |
|---|---|---|---|---|---|---|
| `geral` (controle, sem consulta) | 1.861ms | 2.025ms | **+165ms (+8,8%)** | 2.182ms | 2.138ms | −44ms |
| `teologia` | 2.476ms | 2.599ms | +123ms (+5,0%) | 2.836ms | 3.584ms | +748ms |
| `virtologia` | 2.204ms | 3.008ms | **+804ms (+36,5%)** | 2.994ms | 3.460ms | +466ms |

Metas: mediana ≤4.000ms, p95 ≤8.000ms. **Os três conjuntos passam depois da mudança.**

**Leitura honesta do controle:** `geral` não recebe consulta nenhuma e ainda assim variou +8,8%. Isso
mede o ruído do experimento, e implica que o +5,0% de `teologia` **é indistinguível de ruído**. O
custo real e acima do ruído está em `virtologia`: +36,5%, ainda a 3.008ms contra meta de 4.000ms.

Relatórios: `docs/audits/voice-benchmark-{geral,teologia,virtologia}-{antes,depois}.json`.

### 4.2 Recuperação com voz real

O log do servidor confirma o recuperador acionado em turnos reais, com o trecho e o score. Exemplos
colhidos: "Que fontes você considera confiáveis para pesquisa teológica?" → **5. PESQUISA, FONTES E
RIGOR (score 7.984)**; "O que é uma virtude como competência neural?" → **A. Virtudes como
Competências Neurais, Modelo CHA (4.550)**; "Explique a Aceitação" → **4. Exemplo Central: o
Conceito de Aceitação (2.384)**.

### 4.3 O risco do Achado 8 (instrução dentro do corpus) — **verificado e contido**

A seção "5. PESQUISA, FONTES E RIGOR" contém literalmente *"Sempre que possível, forneça link para
publicação original, DOI, página da editora ou periódico"* — uma ordem direta ao modelo que colide
com "nunca use links" do bloco de voz. Com o trecho injetado, a resposta falada **não leu nenhuma URL
nem DOI**. A neutralização do preâmbulo funcionou no caso real que a motivou.

---

## 5. Pendências abertas — nenhuma delas resolvida, todas registradas

### 5.1 O trecho injetado induz formatação em lista (achado novo, encontrado no Gate 2)

Na resposta à pergunta sobre fontes, o modelo produziu **lista de marcadores** ("As mais importantes
são: - Os textos bíblicos..."), que o bloco de voz proíbe. A seção injetada é formatada em lista no
corpus, e o modelo imitou a formatação do trecho. `cleanTextForSpeech` remove markdown antes do TTS,
então o efeito audível é atenuado, mas a estrutura da resposta ainda é de lista falada.

**Não foi medido** quanto isso piora em relação à Fase 4, nem se ocorre com outros trechos. Precisa
de comparação par-a-par própria.

### 5.2 A hipótese central da §3 do plano continua **não testada**

O plano declara que a recuperação não distingue "o corpus cobre" de "não cobre", e que o custo disso
é orçamento de contexto e não resposta errada. O caso eleito para testar isso falhou duas vezes:

- "Em que ano foi o Concílio de Niceia?" → não injeta nada (apontado pela 5ª auditoria).
- "Quem foi Policarpo de Esmirna?" → rotulado TEOLOGIA, mas **não injetou**.
- "Quantos capítulos tem o livro de Isaías?" → **rotulado GERAL pelo classificador real**, nunca
  chegou ao recuperador.

**Descoberta que corrige o próprio plano:** a população de ruído que de fato alcança o recuperador é
definida pelo **classificador real**, e eu a modelei por suposição em vez de medir. Duas das três
sondas fora do corpus não chegaram lá. Isso significa que a sobreposição declarada na §3 do plano
está medida contra uma população que **não é** a entrada real do componente — o mesmo erro que a
observação 25 descreve, cometido pela terceira vez nesta linha de trabalho, agora em sentido inverso
(superestimando o ruído em vez de subestimá-lo).

Fechar isso exige medir quais rótulos o classificador real atribui a um conjunto de perguntas fora do
corpus, e só então recalibrar. **Não foi feito.**

### 5.3 Dívida declarada: a consulta não aparece na interface

O evento SSE `routing` não ganhou campo `knowledge` (decisão de redução de escopo). O trecho
consultado vai para o log do servidor e é asserido em teste, mas o usuário não vê em tempo real qual
material fundamentou a resposta. Isso enfraquece o princípio de explicabilidade que a Fase 3
estabeleceu. **É dívida a resgatar, não simplificação neutra.**

### 5.4 Achados fora de escopo (herdados, não resolvidos)

1. **`MAX_CONTEXT_TOKENS` é constante morta** — `src/shared/voiceProtocol.ts` é a única ocorrência no
   repo; o único limite efetivo é `MAX_CONTEXT_TURNS`. Esta fase compensa com teto em caracteres na
   construção do índice. Merece plano próprio.
2. Uma rodada de auditoria independente (Codex) sobre a v5 continua devida — §2.

---

## 6. Estado da fase

**Implementada, testada e verificada com voz real**, com três pendências abertas e registradas
(§5.1, §5.2, §5.3). O Gate 1 foi substituído deliberadamente por travas em teste, com aprovação
explícita do usuário e o motivo registrado em §2.

Não é correto chamar esta fase de "fechada" enquanto a §5.2 não for medida: a afirmação central do
plano sobre o comportamento fora do corpus continua sem evidência.
