# Prompt de reauditoria adversarial — Fase 2 v2 (Rodrigo AI)

Você já auditou a v1 deste plano (`docs/phase-2-v1.md`) e a REJEITOU por 3 achados de gravidade alta, 3 médios e 4 baixos (seu relatório está em `docs/audits/phase-2-audit-result-v1.log`, releia antes de prosseguir). O implementador escreveu uma v2 (`docs/phase-2-v2.md`) alegando ter corrigido todos os 10 achados. **Não confie nessa alegação — verifique cada correção against o texto real da v2, e continue procurando ativamente por problemas novos ou por correções que pareçam ter resolvido um achado mas na verdade só o deslocaram ou o esconderam.** É comum uma correção de uma rodada derrubar silenciosamente uma garantia de uma rodada anterior sem que nenhum achado novo tenha pedido para mexer ali — verifique isso também comparando v2 contra v1 texto a texto nas seções que não deveriam ter mudado.

## Objetivo declarado (inalterado)
Rodrigo AI v0.1.0 (Fase 2): sessão de voz PT-BR pelo navegador, 100% local, sem API paga, MacBook Air M5 16GB. Único assistente geral. "Pronto" = critérios B1–B8 com evidência real. Não aceitar aprovação condicional com achado alto pendente.

## Verifique especificamente, achado por achado da v1:

1. **Achado 1 (alto — reinício do worker em barge-in)**: a v2 (seção "Arquitetura", "Correção 1") proíbe reinício do worker em barge-in normal e exige cancelamento cooperativo via `cancel_event` checado a cada token em `stream_generate`. Isso é suficiente e implementável de verdade com a API do `mlx-lm` (`mlx_lm.generate.stream_generate`), ou a v2 está prometendo uma capacidade de cancelamento que a biblioteca não expõe dessa forma?

2. **Achado 2 (alto — sessão travando 10min após F5)**: a v2 (seção "Transporte e sessão", "Correção 2") introduz preempção síncrona de sessão. Isso resolve o problema original? Essa preempção síncrona (encerrar sessão antiga, invalidar token, liberar arquivos, SÓ ENTÃO criar a nova) introduz uma nova race condition se duas abas do mesmo usuário abrirem sessão quase simultaneamente, ou se a sessão antiga estiver no meio de escrever um arquivo de áudio no momento da preempção?

3. **Achado 3 (alto — injeção de argumento no `say`)**: a v2 exige o delimitador `--` antes do texto em todas as chamadas de subprocesso com texto dinâmico. Isso cobre 100% dos casos, incluindo a chamada ao `ffmpeg` (que também recebe caminhos de arquivo, ainda que gerados por `crypto.randomUUID()` e não pelo usuário)? Falta algum outro subprocesso mencionado no plano que também recebe texto/args dinâmicos e não foi coberto pela correção?

4. **Achado 4 (médio — protocolo ambíguo)**: a v2 define REST + SSE com endpoints nomeados. Esse desenho é internamente consistente com o resto do plano (turnId, cancelamento, streaming por frase)? Falta algum endpoint (ex.: como o cliente descobre que a sessão foi preemptada por outra aba, já que SSE da sessão antiga precisa ser encerrado pelo servidor)?

5. **Achado 5 (médio — cache Metal)**: `mx.metal.set_cache_limit()` na inicialização e `clear_cache()` por turno é a chamada certa da API atual do MLX, ou a API mudou de nome/módulo em versões recentes? Um limite fixo de 1 GiB é razoável junto com os ~4GB de pesos+KV cache já estimados na sua auditoria anterior, ou vai causar recomputação excessiva?

6. **Achado 6 (médio — streaming por frase obrigatório)**: a v2 torna isso mandatório. A lógica de particionar no primeiro `.`/`?`/`!` é ingênua o suficiente para quebrar em casos comuns de PT-BR (abreviações como "Sr.", números decimais "3.5", reticências "...")? Isso dispararia síntese de frases fragmentadas incorretamente?

7. **Achado 7 (baixo — TTS via IVoiceProvider)**: a v2 propõe `SayVoiceProvider` e `KokoroVoiceProvider` implementando a interface existente em `src/shared/extensions/voice.ts`. Releia essa interface real no código — ela tem os métodos necessários (algo como `synthesize(text): Promise<AudioBuffer|Buffer>`) ou só declara `id`/`name`/`isAvailable()` e precisa ser estendida, o que não está explícito na v2?

8. **Achado 8 (baixo — piso de energia do VAD)**: 400ms de piso resolve o problema de ruído curto sem introduzir um novo problema (ex.: cortar o início de palavras curtas legítimas em PT-BR como "Oi", "Sim", "Não")?

9. **Achado 9 (baixo — histerese contra autointerrupção)**: 250ms de fala sustentada com limiar elevado durante "falando" é consistente com a meta de parar áudio em até 300ms após detecção — ou essas duas metas (histerese de 250ms + parada em 300ms) juntas implicam uma janela total de reação inaceitável (usuário fala, precisa sustentar 250ms de fala pra ser reconhecido, só then o sistema para em até 300ms — até ~550ms de "fala ignorada" no pior caso)? Isso é aceitável ou deveria ser revisado?

10. **Achado 10 (baixo — shutdown integrado)**: a v2 estende os handlers de sinal em `src/backend/index.ts` para matar o worker Python e limpar temp files. Releia o código real de `src/backend/index.ts` — a correção descrita é compatível com a estrutura atual do arquivo (que hoje só fecha o servidor HTTP) sem quebrar o comportamento já testado e aprovado na Fase 1 (testes em `src/backend/__tests__/` que verificam shutdown limpo sem processos órfãos)?

## Verifique também
- Algo na v2 introduziu uma regressão nova não relacionada a nenhum dos 10 achados originais?
- O escopo continua fiel à Fase 2 (nenhuma antecipação de Fase 3+)?
- A v2 continua honesta (não promete resultado antes de medir)?

## Saída exigida
Mesma estrutura da rodada anterior — achado, evidência (arquivo:linha), gravidade, confiança, ação recomendada — e ao final: **APROVADO SEM RESSALVAS**, **APROVADO COM AJUSTES MENORES**, ou **REJEITADO**.

## Arquivos
- `docs/phase-2-v2.md` — plano revisado sendo auditado agora.
- `docs/phase-2-v1.md` — versão anterior rejeitada, para comparação.
- `docs/audits/phase-2-audit-result-v1.log` — seu próprio relatório da rodada anterior.
- `src/shared/extensions/voice.ts`, `src/backend/index.ts`, `src/backend/`, `src/frontend/` — código real da Fase 1.
