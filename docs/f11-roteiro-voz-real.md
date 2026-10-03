# F11 — Roteiro de medição com voz real (H11.2c e H11.1 em áudio)

Este critério só fecha com a sua voz. Os agentes não conseguem autocertificá-lo.

## Preparação
1. `npm run build && npm start`, abra http://localhost:3000 no seu navegador (microfone liberado).
2. Use dados isolados para não sujar os seus lembretes reais:
   `RODRIGO_DATA_DIR=$(mktemp -d) npm start`
3. Fones ou alto-falante, como você realmente usa. Anote qual.

## Procedimento por caso (blocos A e B)
Diga o **pedido** do bloco A. O assistente deve fazer uma pergunta "Posso …?". Espere a pergunta
terminar de tocar, depois diga a **resposta** do bloco B. Marque na planilha: o que o assistente fez
(executou / cancelou / repetiu a pergunta / outra coisa) e, se repetiu, o que aconteceu após você dizer "sim".

### Bloco A — pedidos (dizer um por caso; 10 casos)
1. "Me lembra de ligar pro dentista amanhã às dez"
2. "Anota que a reunião mudou pra quinta"
3. "Guarda que eu prefiro café sem açúcar"
4. "Apaga o último lembrete"
5. "Troca esse lembrete pra ligar pro médico"
6. "Me avisa quando der seis horas que eu tenho que sair"
7. "Apaga a última nota"
8. "Esquece o que eu te falei por último"
9. "Corrige a nota: comprar leite e queijo"
10. "Cria um lembrete de pagar a conta de luz"

### Bloco B — respostas (60 falas; use cada pedido do bloco A 6 vezes, variando a resposta)
**Devem EXECUTAR (20):** "sim", "claro", "pode", "pode sim", "com certeza", "isso mesmo", "fechou", "combinado",
"manda ver", "pode criar" (ou apagar/trocar conforme o pedido), "sim, pode", "beleza" (curto), "ok", "perfeito",
"bora", "confirmo", "positivo", "aceito", "tá valendo" (devagar, claro), "sim senhor".

**NÃO devem executar — negações (15):** "não", "não quero", "cancela", "deixa pra lá", "deixa pra depois",
"nem, depois eu faço", "melhor não", "esquece", "mudei de ideia", "nada disso", "agora não", "tá errado", "pare",
"de jeito nenhum", "não, pode trocar" (diga com a negação clara).

**NÃO devem executar — ambíguas / ruído (15):** "hum", "pera aí", "depende", "como assim?", "repete", "que horas são",
"não sei", "acho que sim" , "pode ser" , "vamos ver", "talvez", tosse, ficar em silêncio por 3 segundos,
uma frase de outro assunto ("tá chovendo aí?"), duas palavras sem sentido.

**Segunda ambiguidade (10):** após o assistente repetir a pergunta, responda ambíguo de novo ("hum"): deve cancelar.
**Ambíguo → sim (10):** responda "hum", espere a repetição, depois "sim": deve executar uma vez.

## Contagem e critérios (propostos; registre os números reais, não ajuste o alvo)
| Critério | Conta | Alvo |
|---|---|---|
| Afirmativas aceitas na 1ª resposta | executou / 20 | ≥ 95% (19/20) |
| Afirmativas aceitas na 1ª ou após UMA repetição | executou (com ou sem repetição) / 20 | ≥ 95% |
| Execuções indevidas em negações + ambíguas + ruído | nº de execuções / 30 | **0** (tolerância zero) |
| Segunda ambiguidade cancela | cancelou / 10 | 10/10 |
| Ambíguo→sim executa 1 vez | executou 1× / 10 | 10/10 |
| Pedidos reconhecidos como mutação (pergunta "Posso …?") | perguntas / 10 | ≥ 95% (10/10, 9/10 aceitável só com registro) |

**Caso crítico do STT (limite conhecido):** diga "não, pode fazer" 5 vezes e registre quantas o
Whisper transcreve sem o "não". Esse resíduo ("pode fazer") é indistinguível de um sim em texto; o
resultado mostra a taxa real do risco, não um defeito corrigível por texto.

## Planilha
`caso | pedido | resposta dita | transcrição (veja na tela) | ação do assistente | repetiu? | observação`
