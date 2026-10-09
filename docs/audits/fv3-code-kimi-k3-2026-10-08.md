# Auditoria de código da Fase V fatia 3 (commit ce48a79) — Kimi K3 (opencode, diff enxuto só do backend — sessionManager/routes/image/audioStore, sem docs/research)

Tentativa com Hermes: cota anônima esgotada ("allowance for chatting without signing in"). Tentativa 1 do Kimi com o diff completo (72KB, inclui frontend+testes): degenerou (saída sem sentido). Tentativa 2, só o diff do backend core (19KB): funcionou.

Verificação (Claude): os 5 achados procedem. 1, 3 e 5 corrigidos com teste dedicado e prova de mutação. 2 corrigido (hoje inalcançável, documentado como tal — mover o apagar para antes do early-return não muda comportamento observável hoje, só remove uma dependência implícita de ordem de microtask). 4 é limitação conhecida e aceita (o parser só valida envelope, nunca decodifica — mesmo espírito do parser de WAV já existente); documentada no código para a fatia 4 não presumir mais do que isso.

# Auditoria adversarial — Fase V, fatia 3 (fv3-core.diff)

Escopo: apenas `fv3-core.diff`. Método: leitura linha a linha dos caminhos de captura, escrita
e limpeza, buscando corrida captureId×turno, arquivo órfão, reuso de captureId, escrita antes
de validar, parser JPEG permissivo e path traversal. Todos os trechos citados são literais do diff.

---

## ACHADO 1 — Exceção entre `writeFile` e `receiveScreenCapture` deixa arquivo órfão e turno pendurado

**EVIDÊNCIA (routes.ts):**

```ts
const filePath = deps.audioStore.newScreenCapturePath(sessionId);
await fs.promises.writeFile(filePath, bodyBuffer);

// Revalida DEPOIS de gravar (§4): ...
const accepted = deps.sessionManager.receiveScreenCapture(sessionId, token, captureId, filePath, bodyBuffer.byteLength);
if (!accepted) {
  await fs.promises.rm(filePath, { force: true }).catch(() => {});
```

Não há `try/finally` em torno do trecho gravar→consumir. Se `writeFile` lançar após criar
o arquivo parcialmente (ENOSPC, EIO, EPERM), ou se `receiveScreenCapture` lançar por qualquer
motivo (mudança futura dentro de `getAuthorized`, bug), a exceção sobe para `handleVoiceRoute`
e **o arquivo fica em disco para sempre** — o `rm` só existe no ramo `!accepted`, nunca em
caminho de exceção. Efeito colateral adicional: o pedido de captura nunca é resolvido nesse
caminho — `requestScreenCapture` só resolve via `finish()`, então o turno espera os
`SCREEN_CAPTURE_TIMEOUT_MS` completos e responde "compartilhe a tela" mesmo com a imagem
já (parcialmente) gravada.

**GRAVIDADE:** média — o gatilho é exceção de I/O, não input do cliente, mas o custo é
exatamente a classe de falha que a fatia promete eliminar (imagem sensível persistindo).
**CONFIANÇA:** alta quanto à ausência de try/finally e ao comportamento; média quanto à
frequência do gatilho.
**AÇÃO:** envolver gravar+consumir em `try { ... } catch (e) { await fs.promises.rm(filePath, {force:true}).catch(()=>{}); deps.sessionManager.rejectScreenCapture(sessionId, token, captureId); throw e; }`.

---

## ACHADO 2 — Retorno antecipado pós-captura pula a remoção do arquivo

**EVIDÊNCIA (sessionManager.ts, ramo `turn.provenance === 'screen'`):**

```ts
const capture = await this.requestScreenCapture(session, turn);
if (session.activeTurn !== turn) return; // cancelado durante a espera pela captura
...
if (capture.ok) {
  console.log(`[screen] ... captura recebida bytes=${capture.bytes} ...`);
  await fs.promises.rm(capture.filePath, { force: true }).catch(() => {});
```

O `return` de turno-cancelado ocorre **antes** do `rm`. Se `capture.ok === true` e o turno já
não é mais o ativo quando a continuação roda, o arquivo recebido **nunca é apagado**.
Análise de alcançabilidade: hoje, o único caminho que resolve com `ok:true` é
`receiveScreenCapture`, que acabou de verificar `session.activeTurn.turnId === req.turnId`,
e a continuação de um `await` roda em microtask — nenhum cancelamento (macrotask/evento)
consegue se interpor entre o resolve e a checagem. Ou seja: **inalcançável no código atual**
(o próprio diff admite raciocínio análogo na salvaguarda de `receiveScreenCapture`). Mas o
acoplamento é frágil e invisível: qualquer mudança que introduza um `await`/macrotask entre o
consume e a continuação transforma isso em órfão real, silencioso.

**GRAVIDADE:** média (privacidade: quadro de tela persistindo), condicional.
**CONFIANÇA:** baixa de exploração hoje; alta de que o padrão defensivo está no lugar errado
(o `rm` deveria vir antes/ser garantido, não depender da ordem relativa de duas checagens).
**AÇÃO:** apagar o arquivo ANTES do early-return (`if (capture.ok) await rm(...)` logo após o
`await`), ou centralizar a posse do arquivo num `try/finally` do processamento do turno de tela.

---

## ACHADO 3 — Toda a limpeza de arquivo é à prova de nada: `.catch(() => {})` engole falha de deleção

**EVIDÊNCIA — routes.ts (rejeição):**

```ts
await fs.promises.rm(filePath, { force: true }).catch(() => {});
```

**EVIDÊNCIA — sessionManager.ts (sucesso):**

```ts
await fs.promises.rm(capture.filePath, { force: true }).catch(() => {});
```

Em todos os caminhos de descarte, se o `rm` falhar (permissão, lock do SO, disco), o erro é
descartado **sem log**. O resultado é uma imagem de tela — o dado mais sensível que esta
fatia toca — persistindo em `audioStore` indefinidamente e invisivelmente, enquanto o commit
message declara "o arquivo e apagado logo depois". A promessa de limpeza é feita ao usuário,
mas nunca verificada.

**GRAVIDADE:** média — não vaza para fora da máquina, mas viola silenciosamente a invariante
" arquivo vive só durante o turno".
**CONFIANÇA:** alta (o código literalmente descarta o erro).
**AÇÃO:** trocar `.catch(() => {})` por `.catch((e) => console.warn('[screen] falha ao remover captura', filePath, e))` — manter o fluxo, mas nunca o silêncio.

---

## ACHADO 4 — `parseJpegHeader` aceita "JPEG" sem nenhum dado de imagem (SOF → return imediato)

**EVIDÊNCIA (image.ts):**

```ts
if (isSof) {
  if (segLen < 7) return null;
  const height = buffer.readUInt16BE(offset + 3);
  const width = buffer.readUInt16BE(offset + 5);
  if (height <= 0 || width <= 0) return null;
  return { width, height };
}
```

O parser retorna sucesso no primeiro SOF, sem nunca ter visto SOS, EOI ou um byte de varredura.
Um buffer de ~20 bytes (`FF D8 FF C0 00 0B 08 00 20 00 20 ...`) "passa" na validação de
conteúdo e **é gravado em disco como captura de tela válida**. Na fatia 3 o estrago é nulo
(o arquivo é descartado), mas a fatia 4 mandará esse buffer ao motor de visão acreditando na
validação. A defesa por limites (3 MiB / 1600px) continua valendo, então isto não é vetor de
decompress bomb — é validação que promete mais do que entrega.

**GRAVIDADE:** baixa hoje; sobe quando a fatia 4 consumir o arquivo.
**CONFIANÇA:** alta (comportamento direto do código; o docstring inclusive admite: "Nunca ...
decodifica a imagem").
**AÇÃO:** antes da fatia 4, ou exigir ao menos um SOS após o SOF no parser, ou deixar explícito
na frase fixa/testes que a validação é apenas de envelope. Não tratar `parseJpegHeader != null`
como "imagem decodificável".

---

## ACHADO 5 — Ramo JSON aceita `captureId` do corpo mesmo divergente da query

**EVIDÊNCIA (routes.ts):**

```ts
if (contentType.includes('application/json')) {
  ...
  const cid = String(body.captureId || captureId || '');
  const ok = deps.sessionManager.rejectScreenCapture(sessionId, token, cid);
```

O `captureId` efetivo vem do corpo JSON com fallback à query — as duas fontes nunca são
conferidas uma contra a outra. Um POST com `?captureId=A` na URL e `{"captureId": B}` no corpo
rejeita o pedido B. Hoje o impacto é baixo (autenticado por sessão+token, e só consome pedido
realmente pendente), mas é uma ambiguidade de protocolo sem motivo: o formato binário usa a
query, o formato JSON usa "qualquer uma". Se algum dia duas capturas puderem coexistir, isto
vira consumo do pedido errado.

**GRAVIDADE:** baixa.
**CONFIANÇA:** alta quanto ao comportamento; baixa quanto a impacto prático atual.
**AÇÃO:** exigir `captureId` num único lugar por formato (query no binário, corpo no JSON) e
rejeitar com 400 se ambos presentes e divergentes.

---

## Vetores verificados SEM achado (evidência negativa registrada)

- **Reuso / double-consume de captureId:** `receiveScreenCapture` e `rejectScreenCapture` são
  síncronos entre checar `session.captureRequest` e `req.resolve(...)`; `finish()` tem guarda
  `if (settled) return;` e limpa o campo. Dois POSTs concorrentes com o mesmo captureId não se
  intercalam em Node — sem achado.
- **Órfão em cancelamento/timeout/preempção durante upload em voo:** nesses casos
  `session.captureRequest` já é null quando a rota chega em `receiveScreenCapture`, que retorna
  falso e a rota executa `rm` (`if (!accepted) { await fs.promises.rm(...) }`). Coberto
  (ressalva: sujeito ao Achado 1 e Achado 3).
- **Escrita antes de validar sessão:** a rota chama `screenCaptureExpected(...)` ANTES de
  `readBinaryBody`/`newScreenCapturePath` — ordem correta.
- **Parser JPEG — bounds/loop:** todas as leituras (`readUInt16BE`) são precedidas de checagem
  de tamanho (`segLen < 7`, `offset + segLen > buffer.length`), o loop de fill bytes
  (`while (marker === 0xff)`) sempre avança; sem leitura fora do buffer e sem loop infinito
  identificáveis.
- **Path traversal em `newScreenCapturePath`:** `path.join(this.dirFor(sessionId), 'screen-' + crypto.randomUUID() + '.jpg')`
  — o nome do arquivo é UUID gerado no servidor; o `sessionId` só chega a esse ponto depois de
  `getAuthorized(sessionId, token)` casar com uma sessão existente (chave criada server-side).
  Sem evidência de traversal explorável **no diff** — a implementação de `dirFor` não consta
  na fatia; recomendado confirmar fora do diff que ela não reflete input do cliente.

## Resumo

| # | Achado | Gravidade | Confiança |
|---|--------|-----------|-----------|
| 1 | Sem try/finally gravar→consumir: exceção = órfão + turno pendurado | média | alta |
| 2 | Early-return pós-captura antes do `rm` (hoje inalcançável, frágil) | média | baixa |
| 3 | `.catch(() => {})` silencia falha de deleção em toda limpeza | média | alta |
| 4 | Parser valida envelope JPEG, não imagem ("JPEG" de 20 bytes passa) | baixa | alta |
| 5 | captureId do corpo vs. da query nunca conferidos (ramo JSON) | baixa | alta |
