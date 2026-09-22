# Fase 5c — Ações que mutam estado (lembretes e notas) — v5

Versão: v5
Data: 2026-09-22
Base: commit `38478a2`
Antecessora: v4 (APROVADO COM RESSALVAS pelo Hermes, rodada 4 — mas ver §1: metade dos achados de
"Parte B" não sobreviveram à verificação contra os documentos reais).

---

## 0. Escopo — inalterado, ver v1 §0

---

## 1. A quarta rodada, e o que sobreviveu à verificação

Hermes (rodada 4) confirmou por execução/leitura real que a correção central da v4 (reuso de
`markPlayed()`) fecha o achado 1 da rodada 3 de verdade — testou barge-in, `/played` duplicado, e
leu `src/frontend/voice.ts` real para confirmar que o cliente só chama `/played` depois de
`source.onended` (reprodução completa). **Essa parte do veredito é sólida.** Log completo:
`docs/audits/phase-5c-v4-hermes-2026-09-22.log`.

A "Parte B" (auditoria aberta) trouxe 6 achados. **Antes de agir em qualquer um, conferi cada um
contra o texto real dos documentos** — disciplina que este projeto já aprendeu a golpes (rodada 5
da Fase 5b: "não aceitar autodeclaração do subagente", agora estendida de "o subagente implementou
certo?" para "o subagente auditor leu o arquivo certo?"). Resultado: **3 dos 6 eram falsos, citando
estado de versões já superadas.**

| # | Achado do Hermes | Veredito da verificação | Ação |
|---|---|---|---|
| 1 | `IMutatingTool` ainda contradiz o pseudocódigo (`preview(content)` vs. chamada com 2 args) | **FALSO** — `docs/phase-5c-v3.md` §6.1 já corrige isso desde a v3, com `kind` como primeiro parâmetro; conferido linha por linha no arquivo real, presente no mesmo workspace que o Hermes recebeu | Nenhuma — já corrigido |
| 2 | `mightBeMutation`/`MUTATION_GATE` ainda sem regex especificada | **FALSO** — `docs/phase-5c-v3.md` §4.2 tem a regex completa desde a v3 (`MUTATION_GATE`, prefixos de radical) | Nenhuma — já corrigido |
| 3 | `DETECT_CONFIRMATION_SYSTEM_PROMPT` autocontraditório ("UMA PALAVRA" com exemplos de 3-6 palavras) | **PROVAVELMENTE FALSO** — os exemplos seguem `<frase do usuário> -> <PALAVRA>`, o mesmo formato de todo prompt de detecção do projeto desde a 5b (`DETECT_TOOL_SYSTEM_PROMPT`), já implementado e medido em produção sem essa confusão. A frase multi-palavra é o lado ESQUERDO (o que o usuário diz), não o que o modelo deve responder | Nenhuma — formato já validado pela 5b |
| 4 | `armedMutation` não inicializado em `createSession` | **FALSO** — `docs/phase-5c-v4.md` linha 235 já tem `armedMutation: null`, ao lado de `pendingMutation: null` | Nenhuma — já corrigido |
| 5 | `tool.preview()` sem try/catch pode derrubar a sessão com erro cru | **REAL**, confirmado contra o texto exato da v4 §6.3 (linha 257 chamava `tool.preview(action, content)` sem proteção nenhuma) | §6.3 (corrigida) |
| 6 | Mitigação barata pro achado 5 da rodada 3 (feedback não ouvido) foi descartada sem considerar uma versão trivial | **REAL** e uma boa sugestão — checar duplicata exata antes de criar é 3 linhas, não exige a infraestrutura de deduplicação entre turnos que a v4 tinha rejeitado por escopo | §4.4 (adotada, parcialmente — ver abaixo) |

**Por que isso importa além desta fase:** um achado com `EVIDÊNCIA: arquivo:linha` e trecho de
código citado parece prova. Três dos seis eram citações precisas de um estado que **já não existia**
— o auditor não releu o arquivo referenciado por "inalterado, ver vX §Y" antes de julgar. O formato
estruturado não é a prova; o arquivo é. Esta seção documenta a verificação, não só o resultado, para
que a rastreabilidade (§9) mostre o trabalho, não só a conclusão.

Nenhum achado, real ou falso, atacou §1/§2/§3.

---

## 2. Premissa da fase — inalterada, ver v1 §2

---

## 3. Escopo — inalterado, ver v1 §3

---

## 4. Decisões de projeto

### 4.1 a 4.3 — inalteradas, ver v4 (a correção central da v4 foi confirmada sólida na rodada 4)

### 4.4 Execução — mitigação barata contra duplicata exata em `*_CRIAR` (achado 6, adotado parcialmente)

A v4 §8 tinha aceitado o risco de repetição por feedback não ouvido sem nenhuma mitigação, citando
que uma solução exigiria "deduplicação entre turnos". Hermes está certo que isso é exagero para o
caso mais comum: **conteúdo idêntico ao último item criado do mesmo tipo.**

```ts
execute(kind: MutationName, content: string | null): string {
  if (kind === 'LEMBRETE_CRIAR' || kind === 'NOTA_CRIAR') {
    const store = this.store.read();
    const last = store.items[store.items.length - 1];
    if (last && last.text === content) {
      return 'Isso já estava salvo.'; // não duplica, não lança — não é falha, é no-op honesto
    }
    store.items.push({ id: crypto.randomUUID(), text: content!, createdAt: new Date().toISOString() });
    this.store.write(store);
    return kind === 'LEMBRETE_CRIAR' ? 'Lembrete criado.' : 'Nota criada.';
  }
  // *_APAGAR — inalterado, ver v1 §4.4
}
```

**O que isso resolve, e o que continua aceito como risco (honestidade sobre o escopo da correção):**
resolve o caso `CRIAR` repetido — não cria duplicata, e ainda fala algo sensato. **Não resolve** o
caso `APAGAR` repetido (apagar duas vezes ainda remove dois itens diferentes, porque "o mais
recente" muda depois da primeira remoção) — esse continua aceito, documentado em §8, pela mesma
razão que a v4 já dava: resolver isso pediria identidade de pedido entre turnos, capacidade fora do
escopo combinado com o usuário (§0). A diferença é que agora só um dos dois casos (não os dois)
carrega esse risco em aberto.

---

## 5. Arquivos afetados — inalterado, ver v4 §5

---

## 6. Pseudocódigo

Seções não tocadas por nenhum achado real (`IMutatingTool`, `worker.py`, `markPlayed()`,
`selectMutatingToolByAction`, `JsonStore`) permanecem como na v4, citadas por referência.

### 6.3 `sessionManager.ts` — `tool.preview()` protegido (achado 5)

Substitui o trecho correspondente da v4 §6.3 (o resto do bloco — detecção, `armedMutation`,
`markPlayed()` estendido, TTL — é idêntico, não repetido):

```ts
const [action, content] = detected;
if (action !== 'NENHUMA') {
  const tool = selectMutatingToolByAction(action, this.mutatingTools);

  if (!tool) {
    // Ferramenta ausente/indisponível — problema de ambiente, não desta requisição.
    // Cai no caminho normal abaixo, como se não houvesse detecção (achado 4 da rodada 2).
  } else {
    let question: string;
    let previewFailed = false;
    try {
      question = tool.preview(action, content);
    } catch {
      // Achado 5 da rodada 4 (Hermes) — preview() sem try/catch deixava uma falha subir
      // até o catch externo de runTurn (state:'erro' cru). Diferente de `tool === null`
      // acima: aqui a intenção FOI detectada, então cair no caminho normal responderia à
      // pergunta errada — melhor falar a falha e encerrar sem armar nada (mesmo padrão da
      // 5b com TOOL_FAILURE_TEXT).
      question = MUTATION_FAILURE_TEXT;
      previewFailed = true;
    }

    this.emit(session, { type: 'routing', turnId: turn.turnId, label: 'GERAL', handled: true });
    this.emit(session, { type: 'state', state: 'falando' });

    turn.expectedSentences.add(0);
    turn.pendingSynthesis.push(this.synthesizeSentence(session, turn, cleanTextForSpeech(question), 0));
    await Promise.allSettled(turn.pendingSynthesis);

    if (session.activeTurn === turn) {
      if (!previewFailed) {
        // Achado 1 (ALTA, rodada 3) — grava armedMutation, NUNCA pendingMutation
        // diretamente; a promoção só acontece em markPlayed() (v4 §6.3, inalterado).
        // Se preview() falhou, não houve pergunta de verdade — não arma nada.
        session.armedMutation = { kind: action, content, turnId: turn.turnId };
      }
      this.emit(session, { type: 'turn_done', turnId: turn.turnId });
      this.emit(session, { type: 'state', state: 'ouvindo' });
      session.activeTurn = null;
    }
    return;
  }
}
```

### 6.7 `LembreteTool`/`NotaTool.execute()` — checagem de duplicata (achado 6, ver §4.4 para o código completo e o raciocínio)

---

## 7. Critérios de aceite

Lista da v4 §7, mais:

- **Teste de regressão direto do achado 5 (rodada 4):** `tool.preview()` configurado para lançar —
  turno termina com `MUTATION_FAILURE_TEXT` falado, `session.armedMutation === null`, sem
  `state: 'erro'`.
- **Teste de regressão direto do achado 6 (rodada 4):** `execute('LEMBRETE_CRIAR', X)` duas vezes
  seguidas com o mesmo `X` — segunda chamada não duplica o item no `JsonStore`, retorna "Isso já
  estava salvo."; com `X` diferente na segunda vez, cria normalmente (não trava criação legítima
  subsequente).

---

## 8. Riscos

Tabela da v4 §8, com a linha do achado 5 (rodada 3) especializada:

| Risco | Prob. | Mitigação |
|---|---|---|
| Feedback de sucesso não ouvido em `*_CRIAR` leva a pedido repetido | Baixa agora | Checagem de duplicata exata contra o último item — repetição não cria uma segunda entrada |
| **Aceito, não mitigado:** feedback de sucesso não ouvido em `*_APAGAR` leva a apagar um segundo item numa repetição | Baixa-Média | Fora de escopo — pediria identidade de pedido entre turnos. Cada repetição ainda passa pela própria confirmação — nada executa sem um "sim" para aquela mutação específica |

Demais linhas da v4 inalteradas.

---

## 9. Rastreabilidade

- v1 (Hermes, REJEITADO), v2 (agy, REJEITADO), v3 (Codex, REJEITADO), v4 (Hermes, APROVADO COM
  RESSALVAS — mas com 3 de 6 achados de Parte B refutados por verificação direta, ver §1), v5
  (esta).
- **Prática nova a partir desta rodada:** todo achado "Parte B" de uma auditoria — não só os que
  atacam o mecanismo central — é conferido contra o texto atual do documento referenciado antes de
  virar uma correção. Um achado com citação de arquivo:linha não é, por si, prova de que o arquivo
  citado ainda diz aquilo.
- Único achado real restante (o parcial do risco de `*_APAGAR` repetido) é aceito e documentado,
  não corrigido — mesmo padrão de aceitação explícita já usado para outros riscos de baixo impacto
  nesta fase.
- Pronta para uma rodada final de confirmação, ou para implementação direta caso o usuário julgue
  que a rodada 4 (com a verificação desta versão) já é suficiente.
