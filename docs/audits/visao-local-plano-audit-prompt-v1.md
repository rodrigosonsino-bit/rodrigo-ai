# Pedido de auditoria — plano da instalação da visão local (Fase V, Fatia 4)

> Para: **agy (Antigravity/Gemini) e/ou Codex**, na ordem acordada; sem cota, outra família que não seja Claude (decisão do Rodrigo, item 6 do pacote de 2026-10-12).
> De: ORQUESTRADOR_GROK, que aciona o auditor no Mac. Texto preparado por Claude Sonnet, **autor do plano**. Por isso o autor não é o auditor.
> Objeto: `docs/plan/visao-local-instalacao-v1.md` (PR #12), em `origin/main` `ccf03ca`. **Só leitura. Não altere arquivos, não faça commit.**

## 1. Contexto mínimo
Rodrigo AI é um orquestrador de voz pessoal (Node/TypeScript + worker Python/MLX no Mac). A Fase V (`docs/phase-vision-v3.md`) dá ao app a capacidade de "enxergar a tela". A Fatia 4 (visão local no worker) existe no código mas não instala nem foi validada. O plano a auditar propõe como instalá-la e validá-la. Regras do projeto: `CLAUDE.md` (nenhuma dependência externa nova sem plano, aval e auditoria; `docs/research/` nunca vai a terceiros; nenhum teste é afrouxado).

## 2. O que ler
1. `docs/plan/visao-local-instalacao-v1.md` (o plano).
2. `docs/phase-vision-v3.md` §5.1, §6, §7 (HV.8–HV.12) e §10.4–10.6 (plano-mãe).
3. `scripts/worker/worker.py`: `handle_describe_screen` (a partir de ~linha 1109) e `VISION_MODEL_ID` (~linha 45).
4. `scripts/worker/requirements.in`, `scripts/worker/setup_models.py`, `scripts/setup-voice.mjs`.
5. `src/backend/voice/voiceRuntime.ts` (uso do manifesto, ~linhas 56–75) e `src/backend/voice/mlxWorkerEngine.ts` (`describeScreen`, prazo de 90 s).

## 3. Afirmações do plano que você deve tentar derrubar (verifique de forma independente)
- **A1.** `mlx-vlm` não está em `requirements.in`, e `setup_models.py` não baixa nem registra o modelo de visão; `voiceRuntime.ts` só checa se o manifesto existe.
- **A2.** O worker chama `mlx_vlm.generate(model, processor, image_path, formatted_prompt, max_tokens=200, verbose=False)`, e na versão atual do PyPI (0.7.6) a assinatura é `generate(model, processor, prompt, image=None, ...)` com retorno `GenerationResult`. **Verifique baixando o pacote** (`pip download mlx-vlm==0.7.6 --no-deps` e leitura do código; não exige macOS para ler).
- **A3.** A ordem `(image, prompt)` é a da 0.0.15 e as versões com `qwen2_5_vl`/`qwen3_vl` (0.1.27, 0.4.4, 0.7.6) usam `(prompt, image)`; portanto nenhuma fixação de versão corrige a chamada atual. Confira outras versões que o autor **não** olhou (0.2.x, 0.3.x, 0.5.x, 0.6.x).
- **A4.** `mlx-vlm` 0.7.6 exige `transformers>=5.14.0` e `mlx>=0.32.2`, e `mlx-lm` 0.32.0 exige `transformers>=5.7.0`; as faixas são compatíveis, mas instalar o `mlx-vlm` pode mudar o `transformers`/`mlx` usados hoje. Considere também `mlx-whisper` (que exige `torch`, `numba`, `scipy`).
- **A5.** Nada descarrega o modelo de visão por ociosidade (HV.10).
- **A6.** O `requirements.in` não fixa versões e, portanto, a instalação não é reproduzível.

## 4. Perguntas de auditoria
1. Há **alguma afirmação factual errada** em §2 do plano? Aponte a linha e a evidência.
2. A ordem S1→S7 é segura? Em particular: o **portão de regressão (S6)** detecta de fato uma regressão do LLM/STT ou só mede latência? O que faltaria medir (qualidade de transcrição, saída do classificador)?
3. **Supply chain:** o plano trata o risco das dependências pesadas do `mlx-vlm` (`opencv-python`, `fastapi`, `uvicorn`, `websockets`, `mlx-audio`, `miniaudio`, `cryptography`, `llguidance`) de forma proporcional? Fixar versão e hashes basta? Vale um ambiente isolado desde o início (V3), em vez de só como plano B?
4. **Privacidade:** S7 prova "zero conexões de saída em operação" de forma convincente? A biblioteca ou os modelos fazem alguma chamada de rede em tempo de execução (telemetria, verificação de versão, download de arquivos do Hub apesar de `HF_HUB_OFFLINE=1`)?
5. As **decisões V1–V4** estão bem formuladas? A recomendação do `Qwen3-VL-4B` em vez do `3B` se sustenta nas evidências do repositório (§1 do plano-mãe)?
6. O plano esconde uma dependência com a Fatia 5 (PR #11) ou com o PR #9 (`RODRIGO_CLOUD_VISION` desligado)?
7. Algum critério de aceite **não falha objetivamente** (HV.8–HV.12 no plano)?
8. O que o autor **deixou de verificar** e deveria ter verificado antes de propor? (Ele não tem acesso ao Hugging Face, ao Mac nem ao áudio.)

## 5. Formato da resposta
```
VEREDITO: APROVAR | APROVAR COM AJUSTES | REFAZER
ACHADOS (do mais grave ao menos grave):
 - [ALTO|MÉDIO|BAIXO] <título>. Evidência: <arquivo:linha ou comando e saída>. Correção sugerida: <curta>.
AFIRMAÇÕES CONFIRMADAS: A1…A6, uma linha cada (confirmada / refutada / não verificável, e por quê).
NÃO CONSEGUI VERIFICAR: <lista>.
```
Seja adversarial: o objetivo é achar o que está errado, não aprovar. Não repita elogios.
