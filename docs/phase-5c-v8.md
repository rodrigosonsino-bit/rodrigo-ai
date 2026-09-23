# Fase 5c — Mitigação do falso SIM sobre negação — v8

Corrige os 7 achados da rodada 1 (`agy`, REJEITADO — log completo em
`docs/audits/phase-5c-v7-agy-rodada1-2026-09-23.log`). §0, §1, §3 e §4 (exceto a nota de
proveniência) são inalterados da v7 — não repetidos aqui, ver `docs/phase-5c-v7.md`. Esta versão
reescreve por inteiro §2 (o mecanismo) e §6 (critérios de aceite), e ajusta §5.

**Antes de escrever esta versão, consultei o Jev (TypeSafe) em duas decisões** (gatilho: vale o
custo de outra rodada de auditoria? e como resolver o achado 3 sem repetir o erro que o causou?) —
ver §8. As duas respostas moldaram esta versão: mantive a lista de marcadores mínima em vez de
expandi-la por palpite linguístico (achado 3 pedia justamente o oposto do erro que o gerou), e a
plano segue para outra rodada de auditoria antes de implementar.

---

## 2. Mecanismo — reescrito (achados 1, 2, 3, 5)

### Achado 1 (CRÍTICA) corrigido: o gate agora só enxerga a saída da Camada 1

A v7 posicionava o gate fora do bloco que resolve `confirmed`, então ele também interceptava
vereditos SIM vindos da Camada 0 (`keywordConfirmation`, whitelist exata já auditada) — `'com
certeza'` está em `CONFIRM_YES_EXACT` mas não estava na lista de marcadores da v7, e seria
rebaixado indevidamente. Confirmado pelo auditor com evidência de código real e de teste unitário
existente; verifiquei de novo eu mesmo antes de escrever esta versão.

**Correção estrutural:** o gate entra **dentro** do bloco `if (confirmed === null)`, avaliado
apenas sobre o retorno de `this.engine.detectConfirmation(...)` — nunca sobre o retorno de
`keywordConfirmation`. Um SIM da Camada 0 não passa mais perto do gate, então nenhum marcador
precisa cobrir as frases da whitelist exata por construção (não por lista espelhada torcendo pra
não esquecer nenhuma — a arquitetura já garante isso).

### Achado 2 (ALTA) corrigido: lista de marcadores livre de palavras monossilábicas/ambíguas + veto de negação

A v7 incluía `'isso'`, `'pode'`, `'vale'`, `'valendo'` soltos — todos aparecem em negações reais
(`"pera, cancela isso"`, `"pode esquecer"`, `"não vale"`). Removidos como entradas soltas.
Substituídos por locuções compostas inequívocas onde a cobertura real dependia deles (ver
verificação item a item abaixo). Adicionado também um **veto de colisão**: se a transcrição contém
um marcador de negação inequívoco, o gate NUNCA aceita um marcador afirmativo como suficiente —
cobre casos como `"claro que não"` (contém "claro") ou `"jamais confirma"` (contém "confirma"), que
a v7 deixava passar se o LLM alucinasse SIM.

### Achado 3 (ALTA) — decisão: NÃO expandir a lista por palpite agora

A v7 já registrava que os marcadores vieram só da amostra já vista (9 casos SIM), e o auditor
mostrou que confirmações coloquiais comuns fora dela (`"tá bom"`, `"perfeito"`, `"combinado"`)
ficariam sem marcador. **Decisão desta versão, informada pela consulta ao Jev (§8): não adicionar
esses marcadores agora por julgamento linguístico** — é o mesmo mecanismo de risco que produziu o
achado 3 em primeiro lugar (desenhar a lista olhando pra um conjunto pequeno e achando que
generaliza). A lista fica deliberadamente mínima, focada em não deixar nenhum dos 9 casos já
observados sem cobertura, e a amostra hold-out nova (§6) vai medir de verdade quanto falso-negativo
isso causa — se for alto, a próxima versão expande com dado real, não com intuição.

### Lista final e verificação item a item contra os 9 casos SIM conhecidos

```ts
/**
 * Fase 5c v8 — camada 2, só sobre veredito SIM vindo do LLM (Camada 1). Um SIM sem marcador
 * afirmativo reconhecível, OU com um marcador de negação explícito na mesma fala, é rebaixado
 * para NAO (fail-closed). Substring com fronteira de palavra (\b) sobre texto já normalizado
 * (normalizeConfirmation: minúsculas, NFD sem acento, sem pontuação final, espaços internos
 * colapsados — achado 5).
 */
const AFFIRMATIVE_MARKERS = [
  'sim', 'claro', 'confirmo', 'confirma', 'certo', 'certeza', 'exato', 'exatamente', 'positivo',
  'isso mesmo', 'bora', 'beleza', 'fechou', 'fechado', 'manda',
  'pode sim', 'pode criar', 'pode marcar', 'pode fazer',
  'ta valendo', 'blz', 'ok'
];

const NEGATION_MARKERS = [
  'nao', 'nem', 'nunca', 'jamais', 'cancela', 'cancelar', 'esquece', 'esquecer', 'tira', 'tirar'
];

const AFFIRMATIVE_REGEX = new RegExp(`\\b(?:${AFFIRMATIVE_MARKERS.join('|')})\\b`);
const NEGATION_REGEX = new RegExp(`\\b(?:${NEGATION_MARKERS.join('|')})\\b`);

export function hasAffirmativeMarker(transcript: string): boolean {
  const n = normalizeConfirmation(transcript);
  return AFFIRMATIVE_REGEX.test(n) && !NEGATION_REGEX.test(n);
}
```

| # | Frase real (amostra 2026-09-23) | Marcador que cobre |
|---|---|---|
| 1 | "sim, pode criar" | `sim`, `pode criar` |
| 2 | "manda ver" | `manda` |
| 3 | "pode sim, vai fundo" | `pode sim`, `sim` |
| 4 | "é isso mesmo, bora" | `isso mesmo`, `bora` |
| 5 | "confirma aí que tá certo" | `confirma`, `certo` |
| 6 | "isso, pode fazer" | `pode fazer` |
| 7 | "Beleza? Deixe a registrado." (STT degradado) | `beleza` |
| 8 | "fechou, pode marcar" | `fechou`, `pode marcar` |
| 9 | "anota sim, tá valendo" | `sim` |

As 9 continuam cobertas — nenhuma regressão de não-cobertura nos casos já observados. Nenhuma
contém marcador de `NEGATION_MARKERS`, então o veto não interfere em nenhuma delas.

Achado 1 recomendava adicionar `'certeza'`/`'com certeza'` como defesa em profundidade — mantido
(`'certeza'` na lista), mesmo não sendo mais estritamente necessário depois da correção estrutural,
porque é uma palavra inequívoca (sem colisão de negação conhecida) e protege contra uma futura
mudança na Camada 0 que remova a whitelist exata.

### Achado 5 (MÉDIA) corrigido: regex pré-compilado + espaço interno colapsado

`AFFIRMATIVE_REGEX`/`NEGATION_REGEX` acima são módulo-level, compilados uma vez, não por turno.
`normalizeConfirmation` (função existente, `sessionManager.ts`) ganha `.replace(/\s+/g, ' ')` antes
do `.trim()` final — aditiva, não quebra nenhum caso existente da Camada 0 (nenhuma entrada de
`CONFIRM_YES_EXACT`/`CONFIRM_NO_EXACT` depende de espaço duplo para não casar).

### Ponto de aplicação — pseudocódigo completo

```ts
let confirmed = keywordConfirmation(transcript); // camada 0, inalterada — gate NÃO se aplica aqui
if (confirmed === null) {
  try {
    confirmed = await this.engine.detectConfirmation(turn.turnId, turn.epoch, transcript);
  } catch (err) {
    confirmed = 'NAO';
    console.error('[mutation] detecção de confirmação falhou, assumindo NÃO:', err);
  }

  // Fase 5c v8 — camada 2: só sobre o resultado da Camada 1 (LLM), nunca da Camada 0.
  if (confirmed === 'SIM' && !hasAffirmativeMarker(transcript)) {
    confirmed = 'NAO';
    // achado 7: console.warn, não console.error — decisão de negócio esperada, não falha técnica.
    console.warn('[mutation][gate] SIM da Camada 1 sem marcador afirmativo (ou com veto de negação) no texto original, rebaixado para NAO (fail-closed).');
  }
}
if (session.activeTurn !== turn) return;

const mutation = session.pendingMutation;
session.pendingMutation = null;
// ... resto inalterado
```

## 5. Arquivos afetados — ajustado (achado 6)

- `src/backend/voice/sessionManager.ts` — `hasAffirmativeMarker`, `AFFIRMATIVE_MARKERS`,
  `NEGATION_MARKERS`, gate movido para dentro do bloco `if (confirmed === null)`,
  `normalizeConfirmation` com colapso de espaço.
- **`src/backend/__tests__/mutatingTools.test.ts`** (não `voice.test.ts` — é onde os testes de
  `normalizeConfirmation`/`keywordConfirmation` da Camada 0 já vivem, achado 6): cada marcador
  afirmativo reconhecido isoladamente; cada marcador de negação vetando um marcador afirmativo
  presente na mesma frase (`"claro que não"` → sem match); `"embora"` não casa `bora`; `"incerto"`
  não casa `certo`; teste de regressão direto do caso #18 (`hasAffirmativeMarker("E, depois eu
  faço.") === false`); os 9 casos da tabela acima retornando `true`; teste de que um SIM da Camada 0
  (ex. `keywordConfirmation("com certeza") === 'SIM'`) nunca passa pelo gate — via teste de
  integração do fluxo completo em `sessionManager`, não só da função pura isolada.
- Nenhuma mudança em `scripts/worker/worker.py`, `DETECT_CONFIRMATION_SYSTEM_PROMPT`,
  `parse_confirmation_output`, ou `CONFIRM_YES_EXACT`/`CONFIRM_NO_EXACT`.

## 6. Critérios de aceite — reescrito (achado 4)

1. Testes unitários novos passam, suíte completa 100%, build limpo.
2. Teste de regressão do caso #18 (como listado em §5).
3. **Teste de regressão do achado 1**: uma resposta que bate exatamente com uma entrada de
   `CONFIRM_YES_EXACT` (ex. `"com certeza"`) resolve SIM sem nunca invocar `hasAffirmativeMarker` —
   prova de que o gate não toca mais na Camada 0.
4. **Ordem obrigatória de execução** (achado 4, ponto 3):
   1. Este plano (v8) aprovado numa rodada de auditoria adversarial.
   2. Plano commitado.
   3. Implementação + testes unitários locais escritos, suíte completa passando.
   4. Auditoria de código (Hermes), por regra já em vigor na skill `auditoria-plano-codex`.
   5. Implementação + testes commitados.
   6. **Só então** — nunca antes — solicitar a amostra hold-out (item 5 abaixo).
   7. Medir H-confirmação contra a amostra nova.
5. **Uma única amostra hold-out nova** (achado 4, ponto 1 — a v7 mencionava "duas amostras" por
   resíduo do desenho original da bateria; H-mutação está fora de escopo desde o §0, então só existe
   uma amostra a coletar aqui): confirmação, ~18-20 frases, mesmo protocolo de independência já
   usado (gerada por uma IA — Hermes — que não viu este plano nem `AFFIRMATIVE_MARKERS`/
   `NEGATION_MARKERS`), com ênfase em negações curtas onde o STT plausivelmente perderia a palavra
   de negação — o padrão exato do caso #18. **Prompt congelado agora** (achado 4, ponto 2), a ser
   enviado verbatim quando o passo 6 da ordem acima for alcançado:

   ```
   Preciso de 18 frases em português do Brasil, faladas — não escritas —, que uma pessoa comum
   diria em resposta a uma pergunta de confirmação do tipo "Posso criar esse lembrete?" ou "Posso
   apagar essa nota?" feita por um assistente de voz. São respostas de verdade, coloquiais, do dia
   a dia.

   Metade (9) deve significar SIM (confirmar), metade (9) deve significar NÃO (negar/cancelar).

   Para as de NÃO, priorize frases CURTAS onde a negação depende de uma ou duas palavras isoladas
   no início ou meio da frase (o tipo de construção onde um sistema de reconhecimento de voz real
   pode perder a palavra de negação e a frase residual soar ambígua ou até afirmativa) — exemplos
   do tipo de coisa que eu quero (não copie estes, invente variações): "nem, depois eu faço",
   "não, deixa quieto", "nem vou fazer isso", "nunca, esquece". Essas são as mais importantes do
   teste porque medem se o sistema erra pro lado perigoso quando a transcrição de voz degrada.

   Para as de SIM, varie entre confirmação direta ("sim", "pode", "isso mesmo") e indireta/
   qualificada, incluindo formas coloquiais comuns fora do óbvio ("tá bom", "perfeito", "combinado",
   "beleza", "fechou", "manda ver").

   Regras importantes:
   - NÃO repita a mesma estrutura de frase duas vezes.
   - Pode incluir contração, gíria, hesitação, regionalismo.
   - NÃO explique nem categorize na resposta — responda SOMENTE com a lista numerada de 1 a 18,
     cada linha no formato exato "N. [SIM] frase" ou "N. [NAO] frase" — nenhum outro texto antes
     ou depois, nenhuma cerca de código.
   ```

   Meta inalterada: **≥90% geral, zero falso SIM sobre negação clara**.
6. H-mutação (76,5%) continua fora de escopo, não remedida por este plano.
7. A amostra de 18 frases já vista (v6, 2026-09-23) pode ser rerodada como checagem informal de
   não-regressão, mas não conta como critério de aceite.

## 8. Consulta ao Jev (TypeSafe) antes de escrever esta versão

Duas perguntas, agrupadas numa chamada, 0,96s, `jev-1.13.0`:

- **Vale gastar outra rodada de auditoria adversarial antes de implementar?** `noul: 0.72` — leva a
  favor, não unânime. Peso decisivo: o código tocado executa mutação real de estado; a assimetria de
  custo (rodada de auditoria vs. um segundo falso SIM em produção) favorece verificar de novo.
- **Como tratar o achado 3 (cobertura)?** `choice: lista_minima_e_medir`, confiança 0,99 (contra
  0,01 de expandir agora por palpite) — decisão aplicada em §2.
- Risco estimado de a v8 ser rejeitada de novo numa rodada 2: `score: 0.41` (baixo-médio, mais perto
  de baixo — 64% de probabilidade na categoria "baixo"), mas com confiança baixa nessa estimativa
  específica (0,38) — não tratar como garantia.

## 9. Rastreabilidade

- v1-v6: ver `docs/phase-5c-v7.md` §7.
- v7 — REJEITADO, rodada 1, `agy`, 2026-09-23. 7 achados (1 CRÍTICA, 2 ALTA, 1 MÉDIA, 3 BAIXA),
  nenhum achado descartado por verificação própria — todos confirmados reais antes de corrigir.
- **v8 (esta)** — corrige os 7 achados. Rodada 1 e 2 podem usar o mesmo auditor (`agy`) por regra da
  skill; troca de auditor só passa a ser obrigatória a partir da 3ª rodada sobre este plano.
