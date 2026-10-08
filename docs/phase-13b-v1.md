# Fase 13b.1 — Escuta contínua: juntar fragmentos de uma mesma fala (plano v1)

Data: 2026-10-08. Autor: Claude Opus 5.5 (orquestrador). Estado: **REPROVADO na auditoria (Codex, REFAZER) e substituído pela decisão do usuário de subir o limiar de silêncio para 1,0 s** — ver docs/audits/f13b-plan-codex-2026-10-08.md. Nada deste plano foi implementado.

## 1. Problema (evidência real, não hipótese)

Teste de voz real do usuário em 2026-10-08, com a voz nova da F13a (print enviado na conversa). Uma única pergunta falada com
pausas virou TRÊS turnos:

```
Você: Deve escrever a sua carta, suas duas cartas.
Você: na Bíblia no Novo Testamento?
Você: Para quem Initially Nas Parad filling ?
```

A pergunta pretendida era algo como "Para quem Pedro escreveu as suas duas cartas no Novo Testamento?". O Gemini acertou o assunto
só porque as três falas entraram no histórico; o rótulo (classificação local) e a transcrição do último fragmento foram feitos sobre
lixo.

## 2. Causas (verificadas no código)

1. **Fim de fala aos 700 ms de silêncio** — `src/frontend/voice.ts:10` (`SILENCE_THRESHOLD_MS = 700`). Uma pausa natural no meio
   da frase encerra o segmento e o envia como turno.
2. **Cada segmento novo preempta o turno anterior** — `sessionManager.ts` `submitAudio()`: `engine.cancel(...)`,
   `abortController.abort()`, `activeTurn = null`. O turno anterior morre, mas a fala dele (se já transcrita) fica em
   `session.history` como mensagem de usuário separada (`runTurn`, `session.history.push({ role: 'user', ... })`).
3. **Whisper em fragmento curto alucina.** Medição em 2026-10-08 (áudio sintetizado pelo `say`, limpo, 6 frases): o
   `whisper-small` acerta frases inteiras; o problema aparece em fragmento curto de áudio real de microfone ("Initially Nas Parad
   filling"). Transcrever a fala INTEIRA de uma vez é o remédio, não trocar de modelo.

Medição complementar (não é escopo desta fatia): `whisper-large-v3-turbo` 0,44 s vs `whisper-small` 0,17 s por fala (mediana, 6
frases, máquina ociosa); qualidade em áudio limpo praticamente igual. A troca de modelo só se justifica se a junção não bastar —
decidir com áudio real depois desta fatia.

## 3. Por que não simplesmente subir o limiar de silêncio

Subir 700 → 1.200 ms soma 0,5 s a TODO turno (inclusive "sim"/"não" e perguntas curtas) e ainda corta quem pausa 1,3 s. A latência
já é a maior queixa (≈7,4 s medidos na F13a). A junção no servidor não custa latência no caso comum (fala sem pausa) e conserta o
caso da pausa.

## 4. Desenho

### 4.1 Quando um turno é "juntável"

Ao chegar um segmento novo (`submitAudio`) com `session.activeTurn` ainda vivo, o turno anterior `P` é **juntável** se e só se
TODAS as condições valem:

- (a) `P` não emitiu nenhum `sentence_audio_ready` (nenhum áudio chegou ao cliente — o usuário não ouviu resposta nenhuma);
- (b) no início de `P` **não** havia `session.pendingMutation` nem `session.armedMutation` (confirmações continuam sendo de UMA fala
  só; a regra de mundo fechado do `classifyConfirmation` não pode receber texto colado);
- (c) `P` não entrou em nenhum caminho de mutação/ferramenta (não emitiu `routing` com `handled: true` de mutação/ferramenta);
- (d) o novo segmento chegou até `MERGE_WINDOW_MS = 8000` depois do envio do áudio de `P`;
- (e) soma das durações ≤ `MERGE_MAX_SECONDS = 40` e o formato (taxa, canais, bits) dos WAVs é idêntico.

Se qualquer condição falhar: comportamento atual, inalterado (preempção simples).

Fail-closed: na dúvida (ex.: não dá para ler o cabeçalho de um WAV), NÃO junta.

### 4.2 O que a junção faz

- O novo turno recebe `mergedFrom: string[]` = caminhos de áudio dos fragmentos anteriores juntáveis (encadeia: se `P` já era uma
  junção, herda a lista dele) + o seu próprio.
- `runTurn` concatena o PCM dos WAVs em ordem num arquivo novo do `audioStore` (cabeçalho recalculado) e transcreve ESSE arquivo
  (uma chamada ao Whisper com a fala inteira).
- A mensagem de usuário que `P` eventualmente já tinha posto em `session.history` é **removida** (por identidade do objeto, não por
  posição), para o histórico ter UMA mensagem com a fala inteira.
- Log: `[merge] turno=<id> juntou N fragmentos (X,Y s)` — só contagens, nunca texto.
- Os arquivos de entrada continuam sob a limpeza existente da sessão (`audioStore.cleanupSession`).

### 4.3 O que NÃO muda

- `markPlayed()`, `armedMutation`→`pendingMutation`, `classifyConfirmation` — intocados.
- Barge-in DURANTE a fala do app (estado `falando`, já houve áudio): condição (a) falha → preempção atual.
- Privacidade: nada novo sai da máquina (o áudio continua local; o Gemini recebe o texto da fala inteira, como já receberia em
  três pedaços).

## 5. Critérios de aceite

| Id | Critério | Como mede |
|---|---|---|
| H13b.1 | Segmento novo com `P` juntável → transcrição única do áudio concatenado; histórico com UMA mensagem de usuário | teste com motor falso que registra os caminhos transcritos e o conteúdo do WAV |
| H13b.2 | `P` que já emitiu áudio → sem junção | teste |
| H13b.3 | `pendingMutation` ou `armedMutation` presentes no início de `P` OU do novo turno → sem junção; nenhuma mutação executada a partir de texto colado | teste (incluir "sim" + pausa + "e também…") |
| H13b.4 | `P` em caminho de mutação/ferramenta → sem junção | teste |
| H13b.5 | Janela de 8 s expirada, formatos diferentes, soma > 40 s, cabeçalho ilegível → sem junção (fail-closed) | testes |
| H13b.6 | Concatenação: cabeçalho correto, `dataBytes` = soma, duração = soma | teste unitário de `wav.ts` |
| H13b.7 | Encadeamento de 3 fragmentos → 1 transcrição com os 3 áudios na ordem | teste |
| H13b.8 | Suíte inteira verde, typecheck limpo, prova de mutação dos testes novos (reverter a junção → H13b.1 falha) | comando |
| H13b.9 | **Voz real (só o usuário mede):** repetir a pergunta do print com as mesmas pausas → uma fala transcrita inteira e uma resposta | usuário |

## 6. Riscos

- **Latência no caso de pausa:** a fala inteira é retranscrita (Whisper 0,2–0,5 s a mais). Aceitável: hoje o caso de pausa
  produz lixo.
- **Junção indevida de duas perguntas diferentes** ditas em < 8 s sem o app responder: o resultado é UMA pergunta com as duas
  partes, o que o Gemini responde bem; pior que hoje não fica (hoje a primeira é descartada).
- **Interação com confirmação** é o risco de segurança; coberto por (b) e H13b.3.

## 7. Arquivos previstos

`src/backend/voice/sessionManager.ts` (`ActiveTurn`, `submitAudio`, `runTurn`), `src/backend/voice/wav.ts` (concatenação),
testes novos em `src/backend/__tests__/`. Frontend inalterado.
