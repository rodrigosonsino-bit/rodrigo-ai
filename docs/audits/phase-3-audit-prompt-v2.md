# Prompt de reauditoria adversarial — Fase 3 v2 (Rodrigo AI)

Você já auditou a v1 deste plano (`docs/phase-3-v1.md`) e a REJEITOU por 3 achados de gravidade alta, 6 médios, 1 baixo (seu relatório está em `docs/audits/phase-3-audit-result-v1.log`, releia antes de prosseguir). O implementador escreveu uma v2 (`docs/phase-3-v2.md`) alegando ter corrigido os 10. **Não confie nessa alegação — verifique cada correção contra o texto real da v2 e contra o código real já em produção (Fase 1+2), e continue procurando ativamente por problemas novos ou correções que só deslocaram o problema.**

## Objetivo declarado (inalterado)
Camada de decisão (classificação de intenção em 4 rótulos + transparência via evento) sobre a IA de voz da Fase 2 — sem especialistas reais ainda (Fase 4), toda categoria continua respondida pelo LLM geral. "Pronto" exige a matriz de 9 casos de classificação corretos com MLX real, latência medida par-a-par (não estimada), cancelamento provado com teste de barreira determinístico, e transparência de UI que nunca finge atendimento especializado.

## Verifique especificamente, achado por achado da v1

1. **Achado 1+2 (altos — cancelamento órfão / fila descarta sem resposta)**: a v2 redesenha `cancel()` pra resolver/rejeitar localmente no Node QUALQUER `pending` daquele `turnId`, sem esperar confirmação do worker, e só então envia o comando de cancelamento ao worker como best-effort. Isso realmente fecha o buraco? Pense em: e se `cancel(turnId)` for chamado quando NÃO há nenhum `pending` daquele turnId ainda (ex.: a chamada a `classify()`/`generate()` ainda nem escreveu no `pending` map por uma condição de corrida entre o `writeCommand` e o registro em `this.pending.set(...)`)? Releia a ordem exata das operações em `classify()`/`generate()` propostas (registra em `pending` ANTES ou DEPOIS de `writeCommand`?) e confirme se há uma janela onde `cancel()` roda no meio e não encontra nada pra cancelar, deixando o `writeCommand` seguinte prosseguir sem ser cancelado.
2. **`spawnGeneration`**: a v2 usa um contador incrementado em `spawnWorker()` pra evitar que um timeout antigo mate um worker novo. Verifique: `spawnWorker()` já é chamado no construtor E recursivamente no handler de `exit` do processo filho (isso já existe no código real de `mlxWorkerEngine.ts` — confirme lendo o arquivo). O incremento de `spawnGeneration` está no lugar certo pra cobrir AMBOS os casos (spawn inicial e respawn após crash)?
3. **Achado 3 (alto — `handled` sempre true)**: a correção é `handled: label === 'GERAL'`. Isso é suficiente e correto? Existe algum caminho (ex.: erro de classificação tratado como `AMBIGUO` por engano, ou alguma outra ramificação) que ainda poderia fazer `handled` mentir?
4. **Achado 4 (médio — ordem de estados)**: a v2 fixa `processando → transcript → classify → routing → falando`. Isso é consistente com o código real de `sessionManager.ts` (releia o arquivo) — o estado `falando` realmente só era emitido depois do ponto onde a v2 diz que vai inserir a classificação, ou a v2 está descrevendo uma reordenação que quebra alguma outra suposição do frontend (`voice.ts`) sobre quando esperar cada estado?
5. **Achado 5 (médio — fake não prova cancelamento)**: avalie o novo `FakeVoiceEngine.classify()` com barreira controlada (`classifyGate`). Ele realmente permite escrever um teste que prova cancelamento síncrono real, ou o design da barreira (com `classifySettleDelayMs` e resolução automática quando é 0) ainda deixa uma forma de o teste passar sem provar nada, como o achado original apontou?
6. **Achado 6 (médio — normalização)**: a v2 exige igualdade exata (não mais substring/`in`) e trata qualquer desvio como erro técnico, nunca `AMBIGUO` silencioso. Confirme que isso realmente elimina a não-determinismo do `next()` sobre `Set` do plano original — a nova lógica tem algum novo ponto de não-determinismo?
7. **Achado 7 (médio — matriz de teste)**: avalie a matriz de 9 casos na v2. Ela cobre positivos, negativo adjacente e ambíguo como pedido? Os casos 5 e 6 (Virtologia sem citar o nome / "aceitação" cotidiana) são bons testes de verdade pra um classificador LLM, ou ainda são triviais demais? Sugira 1-2 casos adicionais se achar a matriz fraca em algum eixo.
8. **Achado 8 (médio — latência)**: a v2 exige medição par-a-par real em vez de aceitar a hipótese. O desenho de C3 (mesmo corpus, ≥10 turnos, mediana E p95) é suficiente pra ser conclusivo, ou falta alguma coisa (ex.: variância entre execuções, aquecimento consistente)?
9. **Achado 9 (médio — UI/turnId)**: a correção preserva `turnId` no callback e reseta o indicador em novo turno/erro/fim de sessão. Releia `voice.ts`/`main.ts` reais — a integração proposta é compatível com a estrutura de callbacks que já existe (`onStateChange`, `onTranscript`, etc.) ou exige uma mudança de assinatura que a v2 não menciona?
10. **Achado 10 (baixo — campos prematuros)**: confirmado removidos do contrato na v2. Trivial de verificar — apenas confirme.

## Verifique também
- Alguma correção de um achado reabriu ou piorou outro (ex.: a correção do cancelamento mexeu em algo que o Achado 4 ou 9 dependia)?
- O escopo continua fiel (nada de Fase 4/5/6 real sendo implementado)?
- A v2 continua honesta sobre o que ainda não está provado (a latência continua como hipótese até C3 medir de verdade, certo?).

## Saída exigida
Mesma estrutura: achado, evidência (arquivo:linha), gravidade, confiança, ação recomendada. Ao final: **APROVADO SEM RESSALVAS**, **APROVADO COM AJUSTES MENORES**, ou **REJEITADO**.

## Arquivos
- `docs/phase-3-v2.md` — plano revisado sendo auditado agora.
- `docs/phase-3-v1.md`, `docs/audits/phase-3-audit-result-v1.log` — versão anterior e seu próprio relatório.
- `src/backend/voice/mlxWorkerEngine.ts`, `sessionManager.ts`, `fakeEngine.ts`, `engine.ts` — código real da Fase 2 que a v2 propõe estender.
- `scripts/worker/worker.py` — worker real.
- `src/frontend/voice.ts`, `main.ts` — frontend real.
