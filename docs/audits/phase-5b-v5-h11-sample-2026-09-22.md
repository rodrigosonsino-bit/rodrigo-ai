# Fase 5b v5 — Amostra de validação (hold-out) para H11

Data de congelamento: 2026-09-22
Plano avaliado: `docs/phase-5b-v5.md` (commit `20ef3e1`, anterior a este arquivo)
Critério: `docs/phase-5b-v5.md` §7, H11 — cobertura ≥ 80%, bloqueante.

## Proveniência

As 20 frases abaixo foram geradas por uma IA externa (não a que escreveu
`DETECT_TOOL_SYSTEM_PROMPT` em `docs/phase-5b-v5.md` §4.9), a partir do prompt reproduzido no
final deste arquivo, e coladas pelo usuário sem edição. Nenhuma delas foi vista por quem escreveu
o prompt de detecção antes deste commit.

## Estado no momento do congelamento

**O código da Fase 5b ainda não existe** — `docs/phase-5b-v5.md` é só plano, ainda sem passar por
rodada de auditoria adversarial nem por implementação. Este arquivo é committado agora, antes de
qualquer código, para que a amostra funcione como testemunha datada e imutável-na-prática da mesma
forma que o commit do plano funciona como testemunha do prompt (§0 do plano). **Este arquivo não
deve ser editado depois de commitado** — se a amostra precisar de correção, criar um novo arquivo
datado, nunca reescrever este.

## Quando H11 puder ser medido

Depois que `docs/phase-5b-v5.md` passar pela rodada 5 de auditoria e for implementado (ver
Rastreabilidade do plano, §10), rodar estas 20 frases contra o pipeline real (filtro
`mightBeTemporal` + `detect_tool` no worker MLX) e registrar o resultado — quantas das 20 foram
detectadas corretamente (`HORA` para as que pedem hora, `DATA` para as que pedem data) — num novo
arquivo de auditoria/implementação, citando este como a amostra usada.

## As 20 frases (verbatim, como recebidas)

1. Que horas são?
2. Qual é a data de hoje?
3. Me fala a hora aí?
4. Hoje é dia quanto?
5. Tá marcando quanto agora?
6. Já passou do meio-dia?
7. Em que dia a gente tá mesmo?
8. Ainda é cedo ou já tá ficando tarde?
9. Hoje caiu em qual dia do mês?
10. A gente já chegou no dia vinte e dois?
11. Tô meio perdido aqui, você consegue me dizer que horas tá dando agora?
12. Eu tava preenchendo um negócio aqui e esqueci, qual é a data de hoje mesmo?
13. Nossa, parece que esse dia não acaba… quanto tá dando no relógio?
14. Preciso colocar a data aqui antes de mandar isso, hoje é quanto?
15. Tô organizando meus compromissos e me embananei todo, em que dia nós estamos?
16. Ô, vê pra mim quanto é que tá dando aí?
17. Mano, hoje é dia quanto mesmo?
18. Eita, já são quantas?
19. Rapaz, nós tá em que dia hoje?
20. Peraí, hoje é vinte e dois já ou eu tô viajando?

## Prompt usado para gerar a amostra

```
Preciso de 20 frases em português do Brasil, faladas — não escritas —, que uma pessoa comum
diria para perguntar as HORAS atuais ou a DATA de hoje a um assistente de voz. São perguntas
de verdade, do dia a dia, não frases de manual ou de livro didático.

Divida em 4 grupos de 5 (2 pedindo hora, 2 pedindo data, 1 livre — misture) seguindo estes
estilos:

1. DIRETA E CURTA — a forma mais óbvia e objetiva de perguntar, poucas palavras.
2. INDIRETA — pede a informação sem necessariamente usar a palavra "hora"/"horas" ou
   "dia"/"data" de forma óbvia; um jeito mais rodeado de chegar na mesma pergunta.
3. EMBUTIDA EM FRASE MAIOR — a pergunta não é a frase inteira: vem no meio de uma fala mais
   longa, com um contexto ao redor (reclamação, comentário, started uma conversa antes de
   perguntar), do jeito que sai numa conversa de verdade.
4. REGIONAL / GÍRIA / MUITO INFORMAL — do jeito que uma pessoa realmente fala no dia a dia em
   alguma região do Brasil, com gíria, contração, informalidade — não a versão "educada" da
   pergunta.

Regras importantes:
- NÃO repita a mesma estrutura de frase duas vezes.
- NÃO comece toda frase com "Que horas..." ou "Que dia..." — varie a construção gramatical
  (inversão, afirmação com entonação de pergunta, pergunta embutida, etc.).
- Pode incluir contração, gíria, erro de concordância proposital se for como as pessoas
  realmente falam.
- NÃO explique nem categorize na resposta — só a lista numerada de 1 a 20, uma frase por
  linha, sem comentário antes ou depois.
- Português do Brasil, nunca português de Portugal.
```
