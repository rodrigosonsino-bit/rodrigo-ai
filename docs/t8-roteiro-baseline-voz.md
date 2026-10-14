# T8: roteiro do baseline de turno com voz real (execução do Rodrigo)

**Estado:** documento pronto para você rodar; **nenhum limiar abaixo foi aprovado** (decisão 8: limiar só depois de medir e com seu aval). Código de medição: nenhum nesta entrega; o app já registra o que a T8 precisa? **Não conferi** (ver "Pendências"). Plano: `docs/plans/openjarvis-voz-desktop-v2.md` §3.8.

## 1. Correção ao plano: o tamanho da amostra
O plano diz "da ordem de 110 repetições por categoria (unilateral; ~140 bilateral)" e marca como "aritmética minha, a conferir". **Conferi em 2026-10-13** (aproximação normal e binomial exata):

| Pergunta | n por categoria |
|---|---|
| Detectar taxa de 15% contra 5%, unilateral, alfa 5%, poder 80% (normal) | 43 |
| Provar taxa < 15% quando a verdadeira é 5% (normal) | 59 |
| Idem, **binomial exata** | **59**, aceitando **até 4 falhas** |
| Detectar 15% contra 5% (exato) | 52, rejeitando a partir de 6 falhas |

Os ~110 do plano estavam **cerca de 2× altos** (conservador, mas dobra o seu trabalho). Recomendo **60 repetições por categoria**, 5 categorias = **300 falas**, em duas ou três sessões. Hipótese, erro e poder ficam **fixados antes** de medir (abaixo).

## 2. Categorias, medida e limiar PROPOSTO (precisa do seu aval)
| # | Categoria | O que você faz | Medida | Limiar proposto | Falha se |
|---|---|---|---|---|---|
| 1 | Interrupção (barge-in) | Fala por cima da resposta | tempo até o áudio calar, após o início da sua fala | ≤ 500 ms em 95% dos casos | mais de 4 em 60 passam de 500 ms |
| 2 | Pausa curta | Faz pausa de 0,6 a 0,9 s no meio da frase | taxa de **falso corte** (o app responde antes de você terminar) | ≤ 5% | mais de 4 em 60 cortam |
| 3 | Backchannel | Diz "hum", "aham" enquanto o app fala | taxa de **resposta indevida** (o app para ou responde) | ≤ 5% | mais de 4 em 60 reagem |
| 4 | Troca de turno suave | Termina a frase normalmente | taxa de troca correta (responde uma vez, sem cortar nem demorar mais que 3 s) | ≥ 90% | menos de 54 em 60 |
| 5 | **Eco** (v2.4) | Deixa o alto-falante tocar a resposta com o microfone aberto | a fala do próprio app é **retranscrita como entrada** ou **confirma uma mutação** | **0 em 60** | **qualquer 1** |

Limiares 1 a 4 são **palpites meus**: a pausa de fim de fala hoje é 1000 ms, "valor de partida medido, não meta". A categoria 5 é de segurança (a garantia central é a confirmação falada ouvida), por isso é "zero", não taxa.

## 3. Como rodar (você, ~1 h por 100 falas)
1. Ambiente quieto, mesmo microfone e alto-falante de sempre; anote-os. App pelo ícone da barra de menus **ou** pelo navegador, conforme o que quer medir (o gate T6-voz compara os dois).
2. Para cada categoria, 60 tentativas variando a frase (use as listas de `docs/f11-roteiro-voz-real.md` como banco). Marque ✔ ou ✘ na hora; **não regrave a que falhou**.
3. Registre o que falhou em uma linha (não o conteúdo pessoal). Se ouvir o app dizer algo que você não disse, anote o horário.
4. Conta: com **≤ 4 falhas em 60** a categoria passa no limiar proposto (isso rejeita "a taxa verdadeira é 15% ou mais" ao nível de 5%; se a taxa verdadeira for 5%, a categoria passa em 80% das vezes); 5 ou mais falhas, não passa e vira dívida registrada, **sem baixar o limiar para caber**.

## 4. Pendências honestas
- Não verifiquei se o app já grava os carimbos que as categorias 1 e 2 pedem (hoje o contador do painel só mede tecla→janela visível). Se não gravar, a medida 1 e 2 sai de **cronômetro manual** (menos precisa) ou de uma instrumentação pequena que precisa de plano e auditoria.
- A categoria 3 depende de como o frontend trata "hum": comportamento pode estar indefinido.
- Resultados desta rodada **não substituem** a medição de intenção da Fase 11 (`docs/f11-roteiro-voz-real.md`), que é outra.
