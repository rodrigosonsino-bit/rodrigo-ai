# Fase 10 — opção registrada: TypeSafe Jev para a etapa de **classificação**

**Status: OPÇÃO REGISTRADA. Não é plano, não foi auditada, não está aprovada, não
implementar.** Registrada em 2026-09-17 a pedido do usuário, para não se perder até
a Fase 10 chegar. O repositório exige plano → auditoria adversarial → aprovação
antes de qualquer implementação (`CLAUDE.md`, "Development workflow"); nada disso
aconteceu para este documento.

Estado do projeto na data deste registro: Fases 1–4 e **5a implementadas**
(`docs/implementation-phase-5a.md`, commits `478f370` e `b71bae5`). Faltam as Fases
6–9 antes desta decisão existir. Nota: o `CLAUDE.md` e o
`docs/handoff-2026-09-15.md` ainda descrevem a 5a como não implementada — estão
desatualizados em relação ao log de commits.

---

## 1. O que a Fase 10 diz, literalmente

`README.md:198`:

> **Fase 10**: possível troca de modelo/provedor (inclusive pago) — sempre com
> plano auditado e autorização explícita antes de qualquer mudança, nunca
> silenciosa.

`CLAUDE.md:9`:

> This may change starting at Phase 10 of the roadmap (multi-model/multi-provider),
> but never silently — any move to a paid service requires an explicit plan and
> user sign-off, not an assumption.

O motivo documentado por trás dessa porta é a **qualidade do LLM local na geração**
(`docs/implementation-phase-4.md` §3.5 e §6; `docs/handoff-2026-09-15.md` §"O que
NÃO fazer sem perguntar"): o usuário perguntou se trocar para uma API em nuvem
resolveria, e a resposta registrada foi "provavelmente sim, mas é decisão separada".

## 2. Jev **não** é candidato ao que a Fase 10 trata

O Jev é um modelo *System One* da TypeSafe: recebe um `state` e perguntas tipadas,
devolve `noul` (probabilidade 0–1), `choice` (uma das opções que **você** define, com
distribuição e confiança) ou `score` (posição numa régua definida por você).
**Não gera texto.** Não há campo de saída textual na API.

Consequência direta: ele não pode substituir o `Qwen3-4B-Instruct-2507-4bit` em
`handle_generate()`, que é a dor que motivou a Fase 10. Se a Fase 10 for aberta
para resolver qualidade de geração, o candidato é um provedor de geração
(Gemini/Claude/etc.), não o Jev. **Registrar o Jev como "opção da Fase 10" sem esta
ressalva seria enganoso.**

## 3. Onde ele encaixa de fato: `engine.classify()`

A etapa de classificação de intenção (`sessionManager.runTurn()` → `engine.classify()`
→ `selectAgentForLabel()`, Fase 3/4) devolve exatamente um rótulo entre
`GERAL` / `TEOLOGIA` / `VIRTOLOGIA` / `AMBIGUO`. Isso é literalmente o primitivo
`choice`: 4 opções fixas, resposta = 1 opção + distribuição + confiança.

Há um ponto de dor **documentado** nessa etapa (`CLAUDE.md`, seção Orchestrator):

> The worker's classification prompt (`scripts/worker/worker.py`) needed a
> contrastive few-shot example to stop the model confusing everyday word senses
> with domain-technical ones (e.g. "aceitação" as a feeling vs. the Virtologia term)

Discriminação de sentido de palavra contra pista superficial é precisamente o que
foi medido no Jev em 2026-09-17 (43 chamadas, 0 erro):

- 10/10 em pares casados adversariais — negação dupla, ironia, atribuição de culpa,
  condicional irreal, e **urgência contra as palavras-chave** (texto com
  `URGENT ASAP CRITICAL` → 0.04; texto sem nenhuma palavra de urgência mas com
  prazo real implícito → 0.75).
- `choice` com confiança calibrada: caso nítido → 1.00; caso genuinamente ambíguo
  → 0.77 com a probabilidade se espalhando para a segunda opção.
- Latência mediana **0,78 s** por chamada (state pequeno), medida desta máquina.

A confiança calibrada tem uso direto aqui: `AMBIGUO` deixaria de ser um rótulo que o
modelo escolhe e passaria a ser **uma decisão do código** — por exemplo
`if (confidence < LIMIAR) → AMBIGUO → fallback Geral`, com o limiar como constante
revisável, alinhado ao desenho atual em que `AMBIGUO` não tem agente próprio.

## 4. O que isso custa e quebra — a ser respondido antes de virar plano

1. **Quebra a promessa do README de conversa 100% offline.** Hoje: "Durante a
   conversa/execução, o aplicativo opera 100% desconectado de serviços externos."
   Com Jev na classificação, cada turno faz uma chamada de rede. A promessa teria de
   ser reescrita, não contornada.
2. **Orçamento de latência.** Os benchmarks mais recentes (`docs/audits/voice-benchmark-*.json`,
   2026-09-17, 9 turnos cada) medem **mediana ~1,9–2,0 s** e **p95 ~2,1–2,2 s** de
   fim-de-fala até primeiro áudio, contra alvo ≤4 s / ≤8 s — bem melhor que os
   ~3,2 s / ~3,8 s ainda registrados no `CLAUDE.md`, que está desatualizado. A folga
   até o alvo é de ~2 s, e o Jev custa ~0,78 s de ida e volta, medido desta máquina.
   Cabe no papel. **Mas o custo atual da classificação local continua não medido
   separadamente**: o benchmark registra apenas `sttMs`, `firstAudioMs` e `totalMs`
   por turno — a classificação está embutida na janela entre STT e primeiro áudio,
   sem recorte próprio. Sem isolar esse número não dá para saber se a troca é ganho
   ou perda líquida. Acrescentar `classifyMs` ao `bench:voice` é pré-requisito desta
   decisão, e é barato.
3. **Novo modo de falha.** Rede fora = sem roteamento. Exige fallback para o
   classificador local, o que significa manter os dois caminhos, não substituir um
   pelo outro.
4. **Chave de API e custo por chamada.** A chave já existe nesta máquina
   (`TYPESAFE_API_KEY`). O **preço por chamada não está publicado** na documentação
   da TypeSafe — não foi encontrada página de pricing em 2026-09-17. Um turno de voz
   = uma chamada de classificação.
5. **Envio de transcrição para terceiro.** A fala do usuário sairia da máquina. Esta
   é a mudança mais relevante e não é técnica: é de privacidade, e a decisão é do
   usuário.
6. **Limiar é constante de produção.** Medido: um caso genuinamente vago recebeu
   0,69 num `noul` onde o corte ingênuo de 0,5 produziria falso positivo. Qualquer
   limiar aqui precisa ser calibrado contra transcrições reais e morar num único
   arquivo revisável.

## 5. Recomendação registrada

Se a Fase 10 for aberta, tratar como **duas decisões separadas**, não uma:

- **10a — provedor de geração** (o que o roteiro realmente descreve). Jev não
  concorre aqui.
- **10b — classificador.** Jev é candidato real, com o benefício concreto de
  confiança calibrada e o ponto de dor já documentado do sentido de palavra. Só
  depois de medir o custo atual da classificação local (item 4.2).

Nada disto deve ser implementado antes da Fase 10, nem discutido como correção de
bug. Esta é a mesma ressalva registrada em `docs/handoff-2026-09-15.md`: não pode
ser "uma correção de bug disfarçada".
