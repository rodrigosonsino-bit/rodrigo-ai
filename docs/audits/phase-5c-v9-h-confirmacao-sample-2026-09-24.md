# Fase 5c v9 — Amostra de validação (hold-out) para H-confirmação, rodada pós-mitigação

Data de congelamento: 2026-09-24
Plano avaliado: `docs/phase-5c-v9.md` (via `docs/phase-5c-v8.md` §6, prompt congelado ali —
v9 só corrigiu a ressalva 4, não alterou o texto do prompt).
Meta: **≥90% geral, E zero falso SIM sobre negação clara** (mesmo critério de sempre; um único
falso SIM reprova a fase inteira).

Ordem exigida por `docs/phase-5c-v8.md` §6, item 4, já cumprida antes de pedir esta amostra:
1. Plano v8 aprovado em auditoria adversarial (agy, rodada 2, APROVADO COM RESSALVAS).
2. Plano commitado (`621adcd`).
3. Implementação + testes locais escritos, suíte completa passando.
4. Auditoria de código (Hermes) — APROVADO COM RESSALVAS, as 3 aplicadas.
5. Implementação + testes commitados (`78c066c`, `b3f933f`).
6. **Este passo** — amostra hold-out solicitada só agora, depois de tudo commitado.

## Proveniência

As 18 frases abaixo (9 confirmando, 9 negando, etiquetadas `[SIM]`/`[NAO]` pelo próprio gerador)
foram geradas pelo Hermes Agent (`docker exec hermes hermes -z "<prompt>"`), uma IA que não tem
acesso ao código deste repositório e não viu `AFFIRMATIVE_MARKERS`/`NEGATION_MARKERS` em
`src/backend/voice/sessionManager.ts` nem `DETECT_CONFIRMATION_SYSTEM_PROMPT` — mesmo princípio
de independência das rodadas anteriores (Fase 5b, v6).

**Duas rodadas foram necessárias.** A primeira resposta do Hermes foi rejeitada e descartada:
copiou quase literalmente os exemplos ilustrativos do prompt (que pediam expressamente para NÃO
serem copiados, só usados como referência de tipo) e reproduziu a lista de formas coloquiais de
SIM na mesma ordem, palavra por palavra — violando a independência da amostra. Uma frase também
saiu corrompida com caracteres de outro idioma no meio. Devolvida ao mesmo agente com os dois
defeitos nomeados (protocolo padrão deste projeto: nunca aceitar a primeira saída de um
subagente sem auditar o artefato). A segunda resposta, abaixo, foi aceita: sem cópia verbatim,
sem corrupção, 18 linhas no formato pedido.

## As 18 frases

1. [SIM] anota aí pra mim
2. [SIM] confere, pode seguir
3. [SIM] manda bala
4. [SIM] beleza, deixa comigo
5. [SIM] opa, tô dentro
6. [SIM] boa ideia, vai fundo
7. [SIM] por mim tudo certo
8. [SIM] manda, sem cerimônia
9. [SIM] show, pode tocar
10. [NAO] nem, passo dessa vez
11. [NAO] não, ignora isso aí
12. [NAO] nem tenta, pode cancelar
13. [NAO] não, corta essa
14. [NAO] nem quero, descarta
15. [NAO] não, pula fora
16. [NAO] nem rolou, esquece o pedido
17. [NAO] não, larga mão
18. [NAO] nem mandou bem, desiste

## Prompt usado (idêntico ao congelado em `docs/phase-5c-v8.md` §6, mais a mensagem de correção
da rodada 1)

Rodada 1 (rejeitada): `phase-5c-v9-holdout-prompt-rodada1-2026-09-24.txt`, resultado bruto em
`phase-5c-v9-holdout-resultado-rodada1-rejeitado-2026-09-24.log`.
Rodada 2 (aceita, com a correção nomeando os dois defeitos):
`phase-5c-v9-holdout-prompt-rodada2-2026-09-24.txt`.

## Próximo passo

Esta amostra está congelada e commitada. A medição real (voz humana ou TTS gravado + pipeline
MLX real, via `scripts/h5c-check.mjs`) ainda não foi executada — depende de áudio real, que só o
usuário pode prover.
