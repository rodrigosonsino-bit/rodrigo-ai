# Fase 5c — Mitigação do falso SIM sobre negação — v7

Base: `docs/implementation-phase-5c.md` §5 (medição real de 2026-09-23) e
`docs/audits/phase-5c-v6-result-2026-09-23.json`. v6 não existe como plano — o número foi usado
para as amostras/resultado da medição com MLX real (mesma convenção da Fase 5b: v5 implementado,
v6 = resultado). Este é o primeiro plano novo desde a v5, escrito em cima do CÓDIGO REAL já
implementado e auditado, não de pseudocódigo.

---

## 0. Escopo — deliberadamente estreito

Este plano corrige **um** achado, o mais grave dos dois medidos: o falso SIM sobre negação clara
em H-confirmação (caso #18 da amostra, `docs/audits/phase-5c-v6-h-confirmacao-sample-2026-09-23.md`).
**Não** tenta resolver:

- **H-mutação (76,5%, meta ≥80%)** — gap de cobertura em pedidos indiretos/embutidos, incluindo uma
  alucinação de conteúdo (caso #14). Diferente do achado desta seção, nenhuma dessas quatro falhas
  executa uma ação — o sistema simplesmente não percebe o pedido e segue pelo caminho normal, o
  mesmo tipo de gap que a Fase 5b já tem registrado e não bloqueou o roteiro (`docs/implementation-
  phase-5b.md`). Mesma decisão aqui, por simetria: registrado, deliberadamente fora deste plano.
- Qualquer redesenho do fluxo de confirmação, do prompt congelado, ou da UX de voz.

Se o usuário quiser um plano pra H-mutação depois, é outro documento — misturar os dois infla o
escopo de auditoria de um achado de segurança real com um achado de cobertura que já tem precedente
de não bloquear.

## 1. O achado que motiva este plano

Caso #18 da amostra de confirmação: usuário disse **"nem, depois eu faço"** (negação — não quer
confirmar a mutação). O Whisper transcreveu **"E, depois eu faço."** — a única palavra de negação
da frase inteira (**"nem"**) desapareceu na transcrição. O texto residual, sem nenhum marcador de
nenhum dos dois lados, foi enviado ao `DETECT_CONFIRMATION_SYSTEM_PROMPT` (congelado desde a v4,
`scripts/worker/worker.py`), que respondeu **SIM**. `parse_confirmation_output()` já degrada
qualquer coisa que não seja exatamente "SIM" para NAO (fail-closed no parsing) — mas aqui o modelo
gerou literalmente o token "SIM", então o parser não tinha o que corrigir. O sistema criou um
lembrete real que o usuário tinha negado.

**O que isso NÃO é:** não é um bug de código. `markPlayed()` como único caminho pra
`pendingMutation` (a garantia central da fase) funcionou — a pergunta foi feita e a reprodução
confirmada antes de qualquer coisa ser armada. O TTL de 60s não expirou. O parser fez exatamente o
que foi desenhado pra fazer. A falha está numa camada anterior a tudo isso: o STT perdeu
informação que nenhuma lógica downstream pode recuperar, porque ela nunca chegou ao texto.

**O que este plano NÃO faz:** não toca em `DETECT_CONFIRMATION_SYSTEM_PROMPT`. Esse prompt está
congelado desde a v4 (`docs/phase-5c-v4.md` §6.2), foi auditado 4 vezes, e reescrevê-lo abriria um
novo ciclo de congelamento + amostra hold-out nova só pra essa mudança — desproporcional ao achado.
A mitigação proposta é uma camada NOVA, determinística, depois da saída do LLM — nunca dentro dele.

## 2. Mecanismo proposto — gate de marcador afirmativo pós-LLM

Nova função pura em `src/backend/voice/sessionManager.ts`, ao lado de `normalizeConfirmation`/
`keywordConfirmation` (mesmo padrão de função pura testável que o arquivo já usa):

```ts
/**
 * Fase 5c v7 — um SIM só é aceito se o texto original do usuário contiver pelo menos um
 * marcador afirmativo reconhecível. Cobre o caso onde o STT engole a palavra de negação e
 * o texto residual, sem marcador de nenhum lado, ainda soa afirmativo o bastante pro LLM
 * responder SIM (docs/phase-5c-v7.md §1, caso real: "nem, depois eu faço" -> STT "E, depois
 * eu faço." -> LLM respondeu SIM). Substring com fronteira de palavra (\b), nunca substring
 * cru — "embora" não pode casar "bora", "incerto" não pode casar "certo".
 */
const AFFIRMATIVE_MARKERS = [
  'sim', 'claro', 'confirmo', 'confirma', 'certo', 'exato', 'exatamente', 'positivo',
  'isso', 'bora', 'beleza', 'fechou', 'fechado', 'manda', 'vale', 'valendo', 'pode',
  'blz', 'ok'
];

export function hasAffirmativeMarker(transcript: string): boolean {
  const n = normalizeConfirmation(transcript);
  return AFFIRMATIVE_MARKERS.some((m) => new RegExp(`\\b${m}\\b`).test(n));
}
```

Ponto de aplicação — `sessionManager.ts`, imediatamente após a resolução de `confirmed` (camada 0
whitelist + camada 1 LLM), antes de `session.pendingMutation` ser consumido:

```ts
let confirmed = keywordConfirmation(transcript); // camada 0, inalterada
if (confirmed === null) {
  try {
    confirmed = await this.engine.detectConfirmation(turn.turnId, turn.epoch, transcript);
  } catch (err) {
    confirmed = 'NAO';
    console.error('[mutation] detecção de confirmação falhou, assumindo NÃO:', err);
  }
}
if (session.activeTurn !== turn) return;

// Fase 5c v7 — camada 2: gate de marcador afirmativo pós-LLM.
if (confirmed === 'SIM' && !hasAffirmativeMarker(transcript)) {
  confirmed = 'NAO';
  console.error('[mutation] SIM sem marcador afirmativo no texto original, rebaixado para NAO (fail-closed).');
}

const mutation = session.pendingMutation;
session.pendingMutation = null;
// ... resto inalterado
```

Nota de desenho: a camada 0 (`keywordConfirmation`) já é um subconjunto dos marcadores afirmativos
(`sim`, `claro`, `confirmo`, `certo`, `exato`, `exatamente`, `positivo`, `isso mesmo`, `pode
confirmar`, `com certeza`) — todo SIM que sai da camada 0 automaticamente teria marcador. O gate só
tem efeito real sobre SIM vindo da camada 1 (LLM). Nenhuma mudança na camada 0 nem no parser Python.

## 3. Alternativas consideradas e descartadas

| Alternativa | Por que não |
|---|---|
| Reescrever `DETECT_CONFIRMATION_SYSTEM_PROMPT` com mais few-shots cobrindo negação corrompida | Reabre o congelamento de um prompt já auditado 4x; exigiria amostra hold-out nova só pra essa mudança — desproporcional a um achado que uma camada determinística resolve sem tocar o LLM |
| Segunda rodada de confirmação ("você disse sim, confirma?") | Reduz mas não elimina o mesmo modo de falha (STT pode engolir a segunda negação também) — e adiciona fricção em TODA mutação, não só nas ambíguas. Estrutural demais pra um achado pontual |
| `initial_prompt` do Whisper enviesado pra vocabulário de negação | Ideia real, mas afeta a transcrição inteira (não só confirmação), é mais difícil de isolar/testar, e não tem o mesmo grau de determinismo/testabilidade unitária. Registrado como possível melhoria futura, fora deste plano |
| Threshold de confiança do LLM | `detect_confirmation` não expõe probabilidade — geração é 1 token com `temp=0.0`; extrair confiança exigiria mudar a geração (logprobs), outro ciclo de congelamento |

**Escolhido: gate determinístico pós-LLM.** Mais barato, testável sem nenhuma chamada a modelo
(função pura), e não toca em nada já auditado.

## 4. Risco introduzido — falso NAO em SIM legítimo sem marcador

Direção seguramente aceitável, mesma filosofia de fail-closed já adotada em toda a fase (pior caso:
usuário repete a confirmação de forma mais clara; nenhum dado é perdido, nenhuma mutação indesejada
executa). Dois marcadores da lista merecem atenção adversarial específica na auditoria de plano:

- **`pode`** — verbo modal ambíguo fora de contexto ("pode ser que não" é tecnicamente uma negação
  que contém "pode"). Mantido porque apareceu em 4 das 9 frases SIM reais da amostra já coletada
  (`"sim, pode criar"`, `"pode sim, vai fundo"`, `"isso, pode fazer"`, `"fechou, pode marcar"`) —
  removê-lo custaria cobertura real. Mas o auditor deve testar frases tipo "pode ser que eu não
  queira" antes de aprovar esta lista como está.
- **`vale`/`valendo`** — mesmo raciocínio ("vale a pena pensar melhor" não é confirmação).

**Nota de proveniência da lista:** os 9 marcadores centrais (`sim`, `pode`, `manda`, `isso`,
`bora`, `confirma`, `certo`, `beleza`, `fechou`, `valendo`) foram extraídos por inspeção da amostra
de 18 frases já coletada e medida (`docs/audits/phase-5c-v6-h-confirmacao-sample-2026-09-23.md`).
Isso é **inspiração de desenho, não validação** — a amostra já foi vista por quem escreve este
plano, então não pode servir de critério de aceite (§6). Confirmei que os 9 casos SIM da amostra
mantêm marcador mesmo na transcrição real (inclusive o caso #7, cuja transcrição veio degradada:
"Beleza? Deixe a registrado." ainda contém "beleza") — mas isso é só verificação de não-regressão
óbvia, não medição.

## 5. Arquivos afetados

- `src/backend/voice/sessionManager.ts` — nova função `hasAffirmativeMarker` + gate no fluxo de
  `pendingMutation` (~15 linhas líquidas).
- `src/backend/__tests__/voice.test.ts` (ou arquivo de teste dedicado) — testes unitários da função
  pura: cada marcador reconhecido isoladamente; `"embora"` não casa `bora`; `"incerto"` não casa
  `certo`; teste de regressão direto do caso #18 (`hasAffirmativeMarker("E, depois eu faço.") ===
  false`); teste de que os 9 casos SIM da amostra real mantêm `true`.
- Nenhuma mudança em `scripts/worker/worker.py`, `DETECT_CONFIRMATION_SYSTEM_PROMPT`,
  `parse_confirmation_output`, ou `keywordConfirmation`/`CONFIRM_YES_EXACT`/`CONFIRM_NO_EXACT`.

## 6. Critérios de aceite

1. **Testes unitários novos passam**, suíte completa continua 100% (build limpo, sem regressão).
2. **Teste de regressão direto do caso #18**: `hasAffirmativeMarker("E, depois eu faço.")` retorna
   `false`; com o gate aplicado, um `confirmed === 'SIM'` sobre esse texto vira `'NAO'`.
3. **Bloqueante — protocolo de congelamento (observação 56, já aplicada a esta própria skill de
   auditoria na revisão de 2026-09-23):** este plano é commitado ANTES de qualquer amostra nova ser
   pedida ou vista. Só depois do commit, solicitar duas amostras hold-out **novas e independentes**
   (não reaproveitar as 18+17 frases já vistas — essas são material de desenho, contaminado para
   medição):
   - Amostra de confirmação nova (~15-20 frases, mesmo protocolo de independência das anteriores:
     gerada por uma IA que não viu este plano nem `AFFIRMATIVE_MARKERS`), com ênfase em negações
     onde o STT plausivelmente perderia a palavra de negação (frases curtas, negação no início ou
     isolada — o padrão exato do caso #18).
   - Medir H-confirmação contra a amostra nova: meta inalterada — **≥90% geral, zero falso SIM
     sobre negação clara**.
4. **H-mutação não é remedida por este plano** (fora de escopo, §0) — permanece 76,5%, gap
   reconhecido e não resolvido aqui.
5. A amostra de 18 frases já usada (`...-h-confirmacao-sample-2026-09-23.md`) pode ser rerodada
   como checagem informal de não-regressão (os 9 SIM devem continuar SIM, o caso #18 deve virar
   NAO), mas **não conta como critério de aceite** — já foi vista, não é hold-out.

## 7. Rastreabilidade

- v1-v4 (rejeitados/aprovados com ressalvas, ver `docs/phase-5c-v5.md` §9 pra histórico completo).
- v5 — implementado, auditado (código, Hermes — `docs/audits/phase-5c-codigo-hermes-2026-09-23.log`).
- v6 — não é plano; tag da medição real com MLX (`docs/implementation-phase-5c.md` §5). Achou os
  dois gaps que motivam este documento.
- **v7 (este)** — mitigação cirúrgica do achado de segurança (falso SIM), escopo explicitamente
  restrito, H-mutação deliberadamente fora.
- Próximo passo: rodar este plano pela `auditoria-plano-codex` (Codex e/ou agy, read-only/plan)
  antes de implementar — trata-se de um plano que MUTA código de produção que já executa mutações
  reais, risco médio-alto por definição do próprio critério de risco da skill. Depois de
  implementado: auditoria de código (Hermes), por regra já registrada na mesma skill ("toda fase
  que entrega código passa por auditoria de código antes de fechar").
