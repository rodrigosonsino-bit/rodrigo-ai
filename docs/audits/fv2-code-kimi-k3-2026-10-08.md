# Auditoria de código da Fase V fatia 2 (commit 2404d61) — Kimi K3 (opencode, viu SÓ o diff do commit; sem docs/research)

Verificação (Claude): os 4 achados procedem e foram corrigidos no commit seguinte. Achado 3 é também defeito PRÉ-EXISTENTE no ramo de histórico desligado (mandava a resposta atrasada no lugar da pergunta).

# Auditoria adversarial — fv2.diff (turno de tela)

Escopo: os 4 vetores pedidos. Só entram achados com evidência literal do diff.

---

## ACHADO 1 — Falso negativo: plural das palavras-tela não casa a regex

**EVIDÊNCIA** (`screenQuery.ts`):

```
const SCREEN_WORDS =
  /(?:^|[^\p{L}])(tela|monitor|desktop|[aá]area de trabalho|janela)(?=$|[^\p{L}])|o que (?:est[aá]|aparece) aqui na frente/u;
```

O lookahead `(?=$|[^\p{L}])` exige fim de string ou não-letra logo após a palavra. Falas naturais como "olha as **telas**", "tem dois **monitores** ligados", "fecha essa **janelas**" (STT às vezes pluraliza) não casam: `tela` seguida de `s` (letra) falha o lookahead. A fala cai como turno normal e a pergunta sobre a tela vai ao histórico/geração.

**GRAVIDADE:** média (o turno de tela deixa de ser reconhecido; o dado vai ao Gemini como conversa normal — direção oposta à do isolamento prometido).
**CONFIANÇA:** alta (comportamento da regex é determinístico).
**AÇÃO:** admitir plural/flexão: `(telas?|monitores?|desktops?|[aá]reas? de trabalho|janelas?)` e adicionar testes positivos com plural.

---

## ACHADO 2 — Teste negativo vacuoso que mascara o Achado 1

**EVIDÊNCIA** (`fvScreen.test.ts`):

```
for (const t of ['o que é isso?', 'esse erro aqui', 'olha só', 'qual a capital da França?', 'telhado', 'estelar', 'janelas de oportunidade são raras'.replace('janelas', 'chances')]) {
    it(`não é tela: "${t}"`, () => assert.equal(mightBeScreenQuery(t), false));
```

O caso `'janelas de oportunidade são raras'.replace('janelas', 'chances')` vira `'chances de oportunidade são raras'` — string **sem nenhuma palavra-tela**. O teste que existiria para fixar o comportamento de "janelas" (plural, metafórico) é substituído por um caso que não exerce a regex em nada. E note: a string original `'janelas de oportunidade são raras'` **já** daria `false` (Achado 1), então o replace nem sequer era necessário — ele só remove a palavra do conjunto de teste.

**GRAVIDADE:** média (teste que deveria documentar comportamento limítrofo virou decorativo).
**CONFIANÇÃO:** alta.
**AÇÃO:** remover o `.replace(...)` e deixar a string original no teste; adicionar caso positivo com plural ("olha as telas") após corrigir o Achado 1.

---

## ACHADO 3 — Corrida `played` × próxima fala: com histórico desligado, a pergunta atual some do envio

**EVIDÊNCIA** (`sessionManager.ts`):

```
  if (!privacy.sendHistory) {
-    return history.length > 0 ? [history[history.length - 1]] : [];
+    const last = history.length > 0 ? history[history.length - 1] : undefined;
+    return last && last.origin !== 'screen' ? [strip(last)] : [];
  }
```

e a gravação da resposta de tela no histórico na confirmação de reprodução:

```
-    session.history.push({ role: 'assistant', content: text });
+    // Fase V: a origem vem do ITEM emitido (não do turno ativo, que pode já ser null quando a reprodução é confirmada).
+    session.history.push(entry.origin ? { role: 'assistant', content: text, origin: entry.origin } : { role: 'assistant', content: text });
```

A resposta assistente só entra no histórico quando o cliente confirma a reprodução (`played`), que é uma requisição HTTP **separada e assíncrona**. Cenário: usuário faz pergunta de tela → resposta fixa toca → usuário fala a próxima pergunta **antes** do `played` chegar (voz é naturalmente sobreposta). Ordem no histórico: `user(pergunta atual)`, depois `assistant(..., origin:'screen')` — a resposta de tela vira a **última** mensagem. Com `sendHistory: false`, `windowHistory` devolve `[]`: a pergunta atual do usuário **não é enviada ao motor**. O turno seguinte é gerado sem prompt. O próprio teste unitário cobre o caso feliz (`H` termina em `'pergunta atual'` normal), nunca a ordem invertida.

**GRAVIDADE:** alta (perda silenciosa do turno do usuário exatamente na configuração mais privada; e a UX é "o app ignora o que eu disse").
**CONFIANÇÃO:** média (depende da corrida `played` atrasar além do próximo push de `user`; plausível em barge-in/sobreposição).
**AÇÃO:** no ramo `sendHistory: false`, buscar a **última mensagem de role `user` sem origin screen** em vez da última absoluta; adicionar teste de sessão com `played` da resposta de tela chegando após a fala seguinte.

---

## ACHADO 4 — Teste de precedência da mutação não prova a precedência (asserção por ausência)

**EVIDÊNCIA** (`fvScreen.test.ts`):

```
  it('pedido de mutação que cita a tela segue como mutação, não como tela (§10.2)', async () => {
    ...
    assert.ok(!s.sse.events.some((e) => e.type === 'routing' && e.label === 'TELA'));
```

O teste só afirma que o rótulo TELA **não** aparece. Se o caminho de tela estivesse quebrado e nunca emitisse `routing: TELA` (regressão no ramo de proveniência), o teste passaria igual. Não há nenhuma asserção do lado positivo — ex.: `h.engine.detectMutationCalls.length > 0` ou que a fala entrou no fluxo de mutação.

**GRAVIDADE:** média (barreira de regressão inexistente para o requisito §10.2).
**CONFIANÇÃO:** alta.
**AÇÃO:** adicionar asserção positiva no caminho de mutação (ex.: `assert.ok(h.engine.detectMutationCalls.length >= 1)` no mesmo teste).

---

## Observações verificadas e NÃO reportadas como defeito

- **Vazamento via `windowHistory` no envio ao motor:** os dois ramos filtram `origin !== 'screen'` e o `strip` remove o campo antes de sair (`const strip = (m) => ({ role: m.role, content: m.content })`). Coberto por teste com marcadores e asserção `!sent.includes('"origin"')`. Sem evidência de outro ponto de envio de histórico no diff.
- **Confirmação desviada para tela:** a guarda `!session.pendingMutation && !session.armedMutation` precede `mightBeScreenQuery`, e mutação armada é coberta pelo teste com `mutationToReturn`. A precedência vale inclusive para pendência expirada (desvio declarado, conservador).
- **`screenCloudAuthorized`:** negação (`não|sem|nunca|nem|evita|evite`) em qualquer posição bloqueia; meta-pergunta ancorada em `^` bloqueia; aspas bloqueiam; marca fora de posição de comando não autoriza ("o gemini apareceu na minha tela" → falso, testado). Falha em direção fechada, coerente com o design declarado ("na dúvida, NÃO autoriza").
