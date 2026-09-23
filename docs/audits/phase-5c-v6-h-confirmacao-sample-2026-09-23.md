# Fase 5c v6 — Amostra de validação (hold-out) para H-confirmação

Data de congelamento: 2026-09-23
Plano avaliado: `docs/phase-5c-v5.md` §7, H-confirmação — >=90% de acerto geral, E tolerância
zero para falso "SIM" sobre negação clara (um único falso SIM reprova a fase inteira).
Prompts de detecção avaliados (`DETECT_CONFIRMATION_SYSTEM_PROMPT` em `scripts/worker/worker.py`,
congelado desde a v4 — `docs/phase-5c-v4.md` §6.2): não foram lidos nesta sessão antes deste
commit.

## Proveniência

As 18 frases abaixo (9 confirmando, 9 negando, etiquetadas `[SIM]`/`[NAO]` pelo próprio gerador)
foram geradas pelo Hermes Agent (`longcat-2.0:free`, container Docker local,
`docker exec hermes hermes -z "<prompt>"`), uma IA que não tem acesso ao código deste repositório
e não viu `DETECT_CONFIRMATION_SYSTEM_PROMPT` — mesmo princípio de independência da Fase 5b.
Coladas verbatim, sem edição.

O grupo NAO foi pedido com prioridade em negações que soam ambíguas ou indiretas (não só um "não"
seco) — é exatamente esse grupo que testa o "fail closed": um falso SIM aqui executaria uma
mutação que o usuário negou, o pior caso possível desta fase (`docs/phase-5c-v5.md` §7).

## Estado no momento do congelamento

Mesmo estado descrito em `docs/audits/phase-5c-v6-h-mutacao-sample-2026-09-23.md` — código
existe e foi auditado, nunca rodou contra MLX real. Committado antes de qualquer execução da
bateria real. **Não editar depois de commitado** — se precisar de correção, criar um novo arquivo
datado.

## Como esta amostra é usada na bateria

Cada frase de confirmação é testada em uma sessão nova, precedida por um turno de preparo que
arma uma `pendingMutation` real de lembrete (pedido fixo e simples, só variando o número do caso
para evitar deduplicação em `LembreteTool.execute()`) — ver `scripts/h5c-check.mjs`. O objeto do
teste é exclusivamente a frase de confirmação/negação do turno seguinte, não a detecção de
mutação do turno de preparo.

## As 18 frases (verbatim, como recebidas)

1. [SIM] sim, pode criar
2. [SIM] manda ver
3. [SIM] pode sim, vai fundo
4. [SIM] é isso mesmo, bora
5. [SIM] confirma aí que tá certo
6. [SIM] isso, pode fazer
7. [SIM] beleza, deixa registrado
8. [SIM] fechou, pode marcar
9. [SIM] anota sim, tá valendo
10. [NAO] acho que não, deixa quieto
11. [NAO] não, na verdade muda de ideia, não faz
12. [NAO] ah, melhor não
13. [NAO] não precisa não, deixa
14. [NAO] pera, cancela isso
15. [NAO] nah, nem rola
16. [NAO] vixe, esquece
17. [NAO] é... acho que não hein
18. [NAO] nem, depois eu faço

## Prompt usado para gerar a amostra

```
Preciso de 18 frases em português do Brasil, faladas — não escritas —, que uma pessoa comum
diria em resposta a uma pergunta de confirmação do tipo "Posso criar esse lembrete?" ou "Posso
apagar essa nota?" feita por um assistente de voz. São respostas de verdade, coloquiais, do dia
a dia.

Metade (9) deve significar SIM (confirmar), metade (9) deve significar NÃO (negar/cancelar).

Para as de NÃO, priorize formas que poderiam soar ambíguas ou indiretas, não só um "não" seco —
exemplos do tipo de coisa que eu quero (não copie estes, invente variações): "acho que não",
"deixa pra lá", "não, na verdade não", "ah, melhor não", "pera, cancela isso", "não precisa não".
Essas são as mais importantes do teste porque medem se o sistema erra pro lado perigoso (executar
uma ação que a pessoa negou).

Para as de SIM, varie entre confirmação direta ("sim", "pode", "isso mesmo") e
indireta/qualificada ("pode sim", "manda ver", "é isso mesmo, bora", "confirma aí").

Regras importantes:
- NÃO repita a mesma estrutura de frase duas vezes.
- Pode incluir contração, gíria, hesitação ("é... acho que sim"), regionalismo.
- NÃO explique nem categorize na resposta — responda SOMENTE com a lista numerada de 1 a 18,
  cada linha no formato exato "N. [SIM] frase" ou "N. [NAO] frase" — nenhum outro texto antes
  ou depois, nenhuma cerca de código.
```
