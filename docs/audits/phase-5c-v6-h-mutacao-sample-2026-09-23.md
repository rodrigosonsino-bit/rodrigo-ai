# Fase 5c v6 — Amostra de validação (hold-out) para H-mutação

Data de congelamento: 2026-09-23
Plano avaliado: `docs/phase-5c-v5.md` §7, H-mutação — cobertura >= 80%.
Prompts de detecção avaliados (`DETECT_MUTATION_SYSTEM_PROMPT` em `scripts/worker/worker.py`,
congelado desde a v4 — `docs/phase-5c-v4.md` §6.2): não foram lidos nesta sessão antes deste
commit.

## Proveniência

As 17 frases abaixo foram geradas pelo Hermes Agent (`longcat-2.0:free`, container Docker local,
`docker exec hermes hermes -z "<prompt>"`), uma IA que não tem acesso ao código deste repositório
e não viu `DETECT_MUTATION_SYSTEM_PROMPT` — mesmo princípio de independência usado na Fase 5b
(`docs/audits/phase-5b-v5-h11-sample-2026-09-22.md`). Coladas verbatim, sem edição — inclusive o
artefato de geração no item 6 ("tsuma" em vez de, presumivelmente, "sumiu"), preservado de
propósito: corrigi-lo seria a pessoa que administra o teste polindo a amostra com conhecimento
que ela não deveria ter sobre o que o detector espera.

## Estado no momento do congelamento

O código da Fase 5c já existe e foi auditado (`docs/audits/phase-5c-codigo-hermes-2026-09-23.log`),
mas nunca rodou contra MLX real — `data/` não existe no repositório (ver handoff
`docs/handoff-2026-09-23.md` §1). Este arquivo é committado agora, antes de qualquer execução da
bateria real, para funcionar como testemunha datada e imutável-na-prática. **Não editar depois de
commitado** — se precisar de correção, criar um novo arquivo datado.

## Quando H-mutação pode ser medida

Rodando `scripts/h5c-check.mjs` contra o servidor real (worker MLX ativo, `RODRIGO_DATA_DIR`
apontando para diretório isolado) — ver `docs/implementation-phase-5c.md` para o resultado.

## As 17 frases (verbatim, como recebidas)

1. Apaga o lembrete de amanhã, por favor.
2. Cria um lembrete pra eu não esquecer a reunião.
3. Anota isso pra mim, vai.
4. Me lembra de ligar pro médico às 14h.
5. Você pode me ajudar a não deixar essa data passar?
6. Essa informação tsuma da minha cabeça, guarda isso aí.
7. Se eu esquecer de pagar a conta, me dá um toque.
8. Tira esse compromisso da minha lista, não vou poder ir.
9. Ah, deixa isso registrado pra mim.
10. Vou sair agora, mas antes anota que o cliente ligou pedindo desconto.
11. Amanhã é aniversário da minha mãe, então me acorda cedo, tá?
12. Não posso esquecer isso de jeito nenhum, coloca um alarme pra mim.
13. Olha, aquela reunião de sexta foi cancelada, pode remover isso da agenda.
14. Depois que eu sair do trabalho, tem uma carta que eu preciso achar, me dá um toque.
15. Ô, acelera aí e grava isso antes que eu esqueça, né?
16. Dá uma anotação aí no seu caderninho digital, parceiro.
17. Apaga aquele negócio lá, não serve mais, brother.

## Prompt usado para gerar a amostra

```
Preciso de 18 frases em português do Brasil, faladas — não escritas —, que uma pessoa comum
diria pedindo para um assistente de voz CRIAR ou APAGAR um lembrete ou uma nota. São pedidos de
verdade, do dia a dia, não frases de manual ou livro didático.

Divida em 4 grupos (misturando criar/apagar lembrete/nota) seguindo estes estilos:
1. DIRETA E CURTA — a forma mais óbvia e objetiva de pedir, poucas palavras (4-5 frases).
2. INDIRETA — pede a ação sem necessariamente usar a palavra 'lembrete'/'nota' de forma óbvia,
   um jeito mais rodeado (4-5 frases).
3. EMBUTIDA EM FRASE MAIOR — o pedido não é a frase inteira, vem no meio de uma fala mais longa
   com contexto ao redor (4-5 frases).
4. REGIONAL/GÍRIA/MUITO INFORMAL — do jeito que uma pessoa fala no dia a dia em alguma região do
   Brasil, com gíria e informalidade (4-5 frases).

Regras importantes:
- NÃO repita a mesma estrutura de frase duas vezes.
- NÃO comece toda frase com "Cria um lembrete..." — varie a construção gramatical.
- Pode incluir contração, gíria, erro de concordância proposital.
- Misture pedidos de CRIAR e de APAGAR (a maioria criar, uns 3-4 de apagar).
- NÃO explique nem categorize na resposta — responda SOMENTE com a lista numerada de 1 a 18,
  uma frase por linha, formato exatamente "N. frase" — nenhum outro texto antes ou depois,
  nenhuma cerca de código.
```

(O modelo devolveu 17 das 18 pedidas; aceito como está — não solicitei complemento para não
correr o risco de enviesar a amostra editando a mão.)
