# Fase 11 — Relatório de implementação e medição

**Estado: NÃO fechada.** Segurança de execução e resultado verdadeiro estão implementados e provados por teste de mutação. Os alvos de cobertura (H11.1, H11.2a) e o critério de voz real (H11.2c) **não** foram atingidos/medidos. Nada abaixo foi relaxado: os números são os medidos.

Plano: `docs/phase-11-v1.md`. Auditorias: `docs/audits/f11/` (plano: Codex r1; código: Kimi K3 r1–r3).

## 1. O que foi construído
- `confirmationClassifier.ts`: classificador **determinístico de mundo fechado** substitui LLM + gate na autorização. NAO por qualquer negação; SIM só se a fala inteira está em vocabulário afirmativo (forte, ou reconhecimento fraco curto, sem interjeição/agradecimento); todo o resto AMBIGUO. Verbo de ação checado contra a ação pendente.
- Reprompt: 1ª ambiguidade repete a pergunta re-armando via `markPlayed()`; a 2ª cancela. Prazo total do pedido de 120 s não é renovado.
- `/played` só vale para a frase **exata** que o servidor emitiu, uma vez; promoção exige a mesma pergunta.
- Resultado verdadeiro: lembrete gravado mas não agendado diz a verdade; geração livre que afirma ter anotado/salvo/agendado é trocada por negativa honesta.
- Detecção de intenção: exemplos novos nos prompts e filtro `mightBeMutation` ampliado.

## 2. Resultados por critério

| H | Alvo | Medido | Situação |
|---|---|---|---|
| H11.1a mutação — precisão | ≥95% | 96,5% (reservada limpa v3, n=108 positivas) | ✔ |
| H11.1a mutação — recall (qualquer mutação) | ≥95% | **76,9%** todos os pedidos; **91,2%** só pedidos explícitos* | ✘ |
| H11.1a mutação — ação exata | ≥95% | 66,7% (confusão LEMBRETE×NOTA×MEMÓRIA; a pergunta falada nomeia a ação) | ✘ |
| H11.1b hora/data — recall | ≥95% | 94,0% (n=50) | ✘ por 1 ponto |
| H11.1b hora/data — precisão | ≥95% | 92,2% | ✘ |
| H11.2a afirmativas aceitas na 1ª resposta | ≥95% | desenvolvimento 75,9–86,2%; reservada v6 83,9% (n=56; só itens inéditos 66,7%, n=15) | ✘ |
| H11.2a após 1 repetição | ≥95% | por construção (o usuário diz "sim"); **depende de voz real** | pendente |
| H11.2b zero execução em negações/ambíguas/ruído | 0 | 0 falsos SIM em 168 (reservada v6) e em 171+177+302 (dev) — ver nota de rótulos | ✔ (texto) |
| H11.2c voz real, STT | ≥95%, 0 | **não medido** — roteiro em `docs/f11-roteiro-voz-real.md` | pendente (usuário) |
| H11.3 reprodução/cancelamento | 100 cenários | 113 testes (agy), 113/113 | ✔ |
| H11.4 resultado verdadeiro | 100 cenários | incluído nos 113 + claim-guard | ✔ |

\* "Explícito" é um recorte meu, aplicado depois, por regex de indícios de comando; exclui 17 correções implícitas ("na real eu tenho 32, não 35"). Reporto os dois números; o alvo é avaliado sobre **todos**.

Suíte completa: 308/308 (`npm test`). Typecheck limpo.

### Teste de mutação (garantias centrais)
Classificador sempre-SIM → 38 de 113 testes falham. `/played` sem checar texto emitido/pergunta → 8 falham. Reprompt que nunca cancela → 10 falham. Restaurado: 113/113.

### Notas de integridade da medição
- Cada amostra reservada foi congelada com sha256 antes do uso. Seis amostras reservadas foram **queimadas** (inspecionadas) e viraram desenvolvimento; ver `heldout-v1-burned.txt`. A reservada de intenção v3 e a de confirmação v6 nunca foram inspecionadas.
- Geradores: Kimi K3 (dev) e Nemotron (reservadas). DeepSeek, Gemini e Hermes estavam indisponíveis para geração. Nemotron repete frases comuns: **133 de 224** itens da reservada v6 já existiam no desenvolvimento (por isso o recorte "inéditos").
- Rótulos errados do gerador: a categoria RUIDO de duas amostras tinha afirmativas claras ("sim", "ah sim claro") rotuladas como ruído — esses "falsos SIM" são erro de rótulo, não do classificador. Um bug meu no gerador (enquadramento de confirmação aplicado a frases de intenção) invalidou uma amostra de intenção; foi detectado por validação do harness e descartado.
- Cobertura de confirmação foi **tunada em amostras de desenvolvimento**, então os 81–93% de dev são otimistas; o número reservado é o mais honesto.

## 3. Auditorias e decisões
- **Codex (plano, 1 rodada)**: reprovou o plano v1. Aplicados: classificador (parada, tokens fortes, símbolos Unicode), `/played` preso à frase emitida, prazo absoluto, claim-guard, falha parcial verdadeira. **Recusado**: achado 5 (cancelar revoga autorização já promovida) — o cliente só dispara `/cancel` durante a fala do assistente; revogar quebraria toda resposta legítima.
- **Kimi K3 (código, 3 rodadas)**: r1 reprovou a regra relaxada ("claro que podia" → SIM) → removida; r2 achou "pode ser"/"vamos ver"/"vish, manda" → corrigidos; r3 APROVADO COM RESSALVAS (`code-audit-kimi-r3.txt`): aplicado o corte de fillers de ação (`dar`, `tocar`, `confiar`); aceitos como custo do mundo fechado e da falta de prosódia: "ah, claro…" irônico, "pode continuar", "ok, então", "segue em frente" viram SIM — ironia não é detectável em texto, só na voz real (H11.2c). Recusados/aceitos como dívida: pergunta multi-sentença nunca ocorre (preview é uma frase); reprompt re-arma só se o turno segue ativo (janela fail-closed); `pendingKind` opcional na API (produção sempre o passa).
- Rotação de auditor: plano → Codex; código → Kimi (mesma família nas 3 rodadas; Hermes indisponível para prompts grandes). Registro honesto: o código **não** foi auditado por um segundo modelo de família diferente.

## 4. Dívidas abertas (registradas, não resolvidas)
1. **Cobertura de intenção < 95%** com Qwen3-4B local. Tentativa de 2ª passada binária (`second-pass-experiment.txt`) inviável: cada detecção já leva 3–7 s (máquina carregada por outro processo) e três passadas estouram o timeout de 10 s. Opções que exigem decisão sua: modelo local maior (download + 16 GB de RAM), ou aceitar o teto e confiar na pergunta falada como rede de segurança.
2. **Cobertura de confirmação na 1ª resposta < 95%** por desenho (mundo fechado troca cobertura por segurança). Mitigação: o reprompt pede "só sim ou não".
3. **STT que engole a negação** ("não, pode fazer" → "pode fazer") é indistinguível de um sim em texto. Só a medição com sua voz mostra a taxa real.
4. **Latência**: detectores levam 3–7 s por chamada nesta máquina; entra no orçamento da F13.
5. Correções implícitas de memória ("na real eu tenho 32") são tratadas como **não-pedidos** por decisão de segurança — decisão de produto a confirmar.

## 5. O que fecha a F11
- Você executar `docs/f11-roteiro-voz-real.md` (H11.2c).
- Decidir (1)–(2) e (5) acima: reabrir cobertura com modelo maior, ou aceitar os números como dívida explícita (mesma classe das Fases 5b/5c).
