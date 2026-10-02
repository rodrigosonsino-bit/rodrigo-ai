# Fase 11 — Autorização e resultado confiáveis (plano v1)

**Objetivo (do roadmap):** o sistema distingue com segurança pedido, confirmação, execução e sucesso; nunca afirma ter feito o que não fez.

**Escopo decidido pelo usuário em 2026-10-02:** reabrir as dívidas aceitas de 5b/5c (H11-5b 75%, H-mutação 76,5%, H-confirmação 61,1%) dentro desta fase.

Fronteira de privacidade: inalterada. Nada novo sai da máquina. Amostras de teste são texto sintético gerado por modelos gratuitos; nenhum dado pessoal, `docs/research/` ou `.env` entra em prompt.

## 1. Estado real que o plano parte (verificado por comando em 2026-10-02)

- Confirmação hoje = 3 camadas: whitelist exata (`keywordConfirmation`), LLM Qwen3-4B (`detectConfirmation`), gate de marcador afirmativo (`hasAffirmativeMarker`) — `sessionManager.ts:402-419` antes desta fase. Medido: 61,1% de cobertura, zero falso SIM no hold-out de 2026-09-24.
- Intenção de mutação = filtro regex permissivo (`mightBeMutation`, `mutatingTools.ts:400`) + LLM (`detectMutation`, `worker.py:114`). Medido: 76,5%.
- Intenção de hora/data = `mightBeTemporal` (`systemTools.ts:66`) + LLM (`detectTool`). Medido: 75%.
- Autorização por reprodução: `markPlayed()` promove `armedMutation`→`pendingMutation` (`sessionManager.ts` ~727). Fix de barge-in já commitado (`23db5be`, `50a7b1a`, `3714aa5`).

## 2. Diagnóstico

1. O gargalo de confirmação não é "inteligência": é que a decisão de **autorizar** foi entregue a um LLM pequeno e depois contida por uma lista de palavras. Cobertura e segurança brigam entre si nesse desenho.
2. Segurança de mutação precisa de uma regra **fechada e auditável**, onde o que não é reconhecido nunca executa. O custo do não reconhecido deve ser uma pergunta repetida, não um "NAO" silencioso que descarta o pedido legítimo.
3. Intenção de mutação/tempo tem recall baixo por vocabulário ainda não coberto pelo filtro regex e por prompt com poucos exemplos; só se corrige com medição contra amostra ampla.

## 3. Desenho

### 3.1 Confirmação (mudança estrutural)
`src/backend/voice/confirmationClassifier.ts`, determinístico, mundo fechado:
- **NAO**: qualquer token/frase de negação ou cancelamento, em qualquer posição (vence tudo).
- **SIM**: a fala **inteira** é vocabulário afirmativo ou preenchimento conhecido, com ≥1 token forte, sem `?`, ≤8 tokens.
- **AMBIGUO**: todo o resto. Primeira vez: repete a pergunta ("Não entendi. Posso confirmar? Diga só sim ou não."), **re-armando** `armedMutation` (só `markPlayed()` volta a aceitar resposta — mesma garantia da pergunta original). Segunda vez: cancela ("Tudo bem, não fiz nada.").
- O LLM sai do caminho de autorização (e a latência de ~1 chamada some). `detectConfirmation`, `keywordConfirmation`, `hasAffirmativeMarker` e a lista de marcadores são removidos (código morto).
- Limite estrutural **documentado, não resolvido**: se o STT engolir a palavra de negação e o resíduo for uma afirmação inteira ("não, pode fazer" → "pode fazer"), a informação não existe mais no texto. Cobertura desse caso só pela medição com voz real do usuário.

### 3.2 Intenção (mutação e hora/data)
Medir primeiro, mudar depois: harness `scripts/f11-measure-intent.mjs` roda `detectMutation`/`detectTool` reais (worker MLX) contra a amostra de desenvolvimento, por categoria. Alavancas, na ordem de custo: (a) ampliar `MUTATION_GATE`/`TIME_GATE` onde o recall cai por filtro; (b) mais exemplos contrastivos no prompt do worker; (c) regra determinística de alta confiança antes do LLM para padrões inequívocos. Cada alavanca é aceita só se melhora o desenvolvimento **sem** piorar precisão. A amostra reservada só é rodada no fim, uma vez por candidato final.

### 3.3 Resultado verdadeiro
Auditar `tool.execute()` de `mutatingTools.ts`: nenhuma frase de sucesso sem efeito comprovado (item gravado e relido; agendamento confirmado). Falha → `MUTATION_FAILURE_TEXT`. Cenários de falha injetáveis (disco cheio, JSON corrompido, item inexistente, ferramenta indisponível, timer que falha).

### 3.4 Reprodução e cancelamento
Matriz de cenários sobre `FakeVoiceEngine`: barge-in antes/durante/depois da pergunta, `/played` atrasado/duplicado/fora de ordem, pergunta de reprompt interrompida, TTL expirado, sessão superada. Invariante: execução só após `markPlayed()` da pergunta mais recente + SIM.

## 4. Critérios (propostos; calibrar contra a medição, não relaxar sem registro)

| H | Critério | Amostra | Quem mede |
|---|---|---|---|
| H11.1a | Intenção de mutação: precisão e recall ≥95% (separados por ação) | reservada, ≥108 positivas + ≥90 negativas (45 difíceis) | agente (worker MLX real, texto) |
| H11.1b | Intenção hora/data: precisão e recall ≥95% | reservada, ≥50 positivas + negativas compartilhadas | agente |
| H11.2a | Confirmação: ≥95% das afirmativas naturais viram SIM **na 1ª resposta** (e relatado: % após reprompt) | reservada, ≥100 | agente (determinístico, exaustivo) |
| H11.2b | Zero ação em ≥300 negações/ambiguidades/ruídos | reservada, ≥300 (clara, indireta, ambígua, ruído) | agente |
| H11.2c | Mesma bateria H11.2 com fala real (STT) e degradações de STT | ≥60 falas gravadas | **usuário** |
| H11.3 | Reprodução/cancelamento: 100 cenários, nenhuma frase interrompida no histórico e nenhuma pergunta incompleta habilitando execução | gerada por script | agente (testes) |
| H11.4 | Resultado verdadeiro: 100 cenários de falha, zero "salvei/apaguei/agendei" falso | gerada | agente (testes) |

Regras de medição: (1) amostra reservada gerada por modelo de **família diferente** da de desenvolvimento, congelada com sha256 **antes** de qualquer ajuste; (2) rótulos da amostra reservada auditados por segundo modelo — divergências decididas por mim, registradas; (3) o harness é validado contra casos conhecidos escritos à mão antes de se acreditar no número (lição da "repetição fantasma"); (4) amostra de desenvolvimento ≠ reservada, nunca misturadas.

## 5. Dívidas explícitas desta fase (podem não fechar — registrar com número)
- Perda de negação pelo STT (limite estrutural §3.1) → só H11.2c fecha, e só com voz do usuário.
- Se H11.1 ficar <95% após as 3 alavancas: registrar o número real, não baixar o alvo sem aprovação do usuário.

## 6. Orquestração (custo × benefício)

| Papel | Ferramenta | Por quê |
|---|---|---|
| Geração das amostras (braçal) | `opencode` gratuito: Kimi K3 (dev), Nemotron (reservada) | texto puro, zero crédito; famílias diferentes. DeepSeek e Gemini estavam fora do ar |
| Cruzamento de rótulos | modelo gratuito (Kimi) | barato; só divergências chegam a mim |
| Classificador, wiring, decisão de segurança | eu | julgamento, risco alto |
| Matriz H11.3/H11.4 (testes repetitivos) | agy `accept-edits` | braçal, código; verificado por mim (typecheck/test + prova de mutação) |
| Auditoria de plano | Codex read-only, 1 rodada | plano com decisão de segurança |
| Auditoria de código | Hermes (prompt enxuto) + Kimi | rotação de auditor |
| Voz real | usuário | critério que não se autocertifica |

Circuit breaker: 3 ciclos corrigir→reauditar sem convergir ⇒ trocar de auditor; mais 2 ⇒ parar e escalar.

## 7. Ordem de execução
1. Amostras (dev, reservada) → congelar hash da reservada.
2. Classificador + wiring + migração dos testes antigos + testes unitários do classificador.
3. Medir H11.2 (determinístico); ajustar vocabulário **só com a de desenvolvimento**.
4. Harness de intenção → medir baseline → alavancas → medir reservada uma vez.
5. Matrizes H11.3/H11.4 (agy) + auditoria de `execute()`.
6. Auditoria de código (Hermes + Kimi), verificar cada achado antes de aplicar.
7. Entregar ao usuário: roteiro de fala real (H11.2c) e relatório com números.
