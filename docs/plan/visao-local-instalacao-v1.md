# Plano — Instalação e validação da visão local (Fase V, Fatia 4) (v1)

> Estado: **PROPOSTA. Sem código neste PR.** Nenhum código antes do aval do Rodrigo e da auditoria de um modelo de outra família (agy ou Codex, pedidos pelo Grok).
> Autor: Claude Sonnet (reserva do orquestrador), 2026-10-12. Base: `origin/main` em `ccf03ca`.
> Plano-mãe: `docs/phase-vision-v3.md` (§5.1, §6, §10.4–10.6, HV.8–HV.12). Este documento só cobre o que falta para a visão local **instalar, carregar e responder** de verdade. A Fatia 5 (Gemini) está no PR #11 e é independente.

## 1. Objetivo

Num Mac onde `npm run setup:voice` já rodou, deixar a visão local funcionando de ponta a ponta: o usuário cita a tela, compartilha um quadro, o worker lê a imagem **sem rede** e a resposta é falada. Hoje, num setup limpo, a visão local **não consegue sequer carregar**.

## 2. O que foi verificado (e como)

Em `origin/main`:
1. `requirements.in` tem só `mlx-lm`, `mlx-whisper` e `google-genai`. **Não há `mlx-vlm`.** `setup_models.py` só baixa o LLM e o STT e grava um manifesto sem entrada de visão. `voiceRuntime.ts` só checa se o manifesto **existe**.
2. `worker.py` carrega `mlx_vlm.load("mlx-community/Qwen2.5-VL-3B-Instruct-4bit")` na primeira pergunta de tela. Com a biblioteca ausente, o import falha e o usuário ouve a frase de "ainda estou aprendendo".
3. Nada descarrega o modelo (`self._vlm_model` nunca é zerado): HV.10 não é cumprido.
4. `requirements.in` **não fixa versões**. O "lock" gerado por `uv pip freeze` descreve o que foi instalado, mas a instalação em si não é reproduzível.

Contra a biblioteca real (baixei o pacote `mlx-vlm` 0.7.6 do PyPI, a versão atual hoje, e li o código-fonte; **não executei nada**, porque ele exige macOS):
5. **A chamada do worker não corresponde à API.** O worker faz `mlx_vlm.generate(model, processor, image_path, formatted_prompt, max_tokens=200, verbose=False)`. Na 0.7.6 a assinatura é `generate(model, processor, prompt, image=None, ..., verbose=False, **kwargs)`: o `prompt` vem **antes** da imagem. Com a ordem atual, o caminho da imagem seria tratado como prompt.
6. **O retorno também difere.** Na 0.7.6, `generate` devolve `GenerationResult`, e o worker faz `str(output_text).strip()`, o que produziria a representação do objeto em vez do texto da resposta.
7. **O worker aplica o template de conversa por `processor.apply_chat_template(messages)`**, enquanto a biblioteca expõe `mlx_vlm.apply_chat_template(processor, config, prompt, num_images=...)`. Pode funcionar para o processador do Qwen, mas está sem teste.
8. A 0.7.6 suporta as arquiteturas `qwen2_5_vl` e `qwen3_vl` (listadas no pacote). Os dois modelos candidatos são, portanto, compatíveis em princípio.
9. **Dependências:** `mlx-vlm` 0.7.6 exige `transformers>=5.14.0` e `mlx>=0.32.2`; `mlx-lm` 0.32.0 exige `transformers>=5.7.0` e `mlx>=0.32.2`. As faixas são compatíveis hoje, mas instalar o `mlx-vlm` **pode subir o `transformers` e o `mlx` que o LLM e o STT, já validados, usam**. Ele também traz um peso grande de dependências (`opencv-python`, `fastapi`, `uvicorn`, `websockets`, `mlx-audio`, `miniaudio`, `cryptography`, `llguidance`), que o app não usa.

**Não verificado (o Hugging Face está bloqueado neste container):** se os repositórios `mlx-community/Qwen2.5-VL-3B-Instruct-4bit` e `Qwen3-VL-4B-Instruct-4bit` existem com esses nomes, os tamanhos deles e se o modelo carrega offline. O plano-mãe diz que o `Qwen3-VL-4B-Instruct-4bit` foi medido em 2026-10-08 (3,3 s aquecido, pico de 4,0 GB); o `3B` que está no código nunca foi medido.

## 3. Decisões do Rodrigo

| # | Decisão | Recomendação |
|---|---|---|
| V1 | **Modelo padrão** da visão local | `Qwen3-VL-4B-Instruct-4bit`, o único com medição; trocar para o 3B só se, nas mesmas capturas, o 3B for mais rápido sem perder a leitura de texto de erro. O código hoje aponta para o 3B sem medição |
| V2 | **Instalação** | Comando **opt-in** separado (`npm run setup:vision`), não parte do `setup:voice` padrão: baixa vários GB e traz dependências pesadas. Quem não usa tela não paga o custo |
| V3 | **Isolamento das dependências** | Mesmo ambiente virtual, com versão do `mlx-vlm` **fixada**, e um portão de regressão (item S6). Ambiente separado só se o portão acusar conflito |
| V4 | **Descarga por ociosidade** (HV.10) | Descarregar após N minutos sem tela (sugestão: 10), para devolver ~3 GB de memória |

## 4. Mudanças propostas (cada uma com teste primeiro e prova de mutação)

**S1. Dependência fixada.** `mlx-vlm==<versão exata>` no `requirements.in` (ou num arquivo de requisitos de visão, se V2 = opt-in), com os hashes no lock. Registrar a versão e o diff completo do lock **antes e depois** (pacotes que subiram ou mudaram).

**S2. Manifesto e download com teto.** `setup_models.py` ganha o modelo de visão: tamanho consultado antes de baixar, o **teto de 8 GiB passa a valer para a soma de LLM + STT + visão**, `snapshot_download` para o `hf-cache`, entrada `vision` no manifesto (repo, revisão, tamanho). Teste: orçamento estourado ⇒ aborta sem baixar nada.

**S3. Disponibilidade honesta.** O Node lê o manifesto e só considera a visão local disponível se houver a entrada `vision`. Sem ela, o turno de tela responde na hora com uma explicação específica ("a visão local não está instalada; rode `npm run setup:vision`"), sem esperar a carga nem o prazo de 90 s. Teste com manifesto com e sem a chave.

**S4. Chamada correta à biblioteca.** Corrigir no worker: ordem dos argumentos (`prompt` antes de `image`), extração do texto de `GenerationResult.text`, e o template de conversa pela API da biblioteca. **Teste de compatibilidade da assinatura**: um teste (que roda no Mac, onde a biblioteca existe) inspeciona `inspect.signature(mlx_vlm.generate)` e **falha** se a ordem ou o retorno mudarem, de modo que uma atualização futura não quebre em silêncio. Mais testes unitários com um módulo `mlx_vlm` falso, no padrão do `test_cloud_master.py`, cobrindo: resposta normal, retorno em branco, exceção, cancelamento antes e depois da inferência.

**S5. Descarga por ociosidade e memória (HV.10, HV.9).** Descarregar o modelo após o tempo de V4 e liberar o cache do MLX. Teste de unidade com relógio falso; medição real no Mac.

**S6. Portão de regressão da instalação (HV.12).** Depois de instalar: (a) diff do lock aceito; (b) `npm test` e todos os `test_*.py` do worker verdes; (c) `npm run bench:voice` com a mediana e o p95 **iguais ou melhores** que a linha de base registrada antes de instalar (3,2 s e 3,8 s segundo o `CLAUDE.md`); (d) STT e classificação sem mudança de resultado numa amostra fixa. Se algo regredir, o plano passa a V3 = ambiente separado.

**S7. Operação sem rede.** Com `HF_HUB_OFFLINE=1`, a visão carrega do cache. Teste de egresso do worker (no padrão `f12Offline`): durante a visão local, **zero tentativas de conexão** de saída.

## 5. Medições que só o Mac faz (critérios HV)

| Id | O que medir | Meta (plano-mãe) |
|---|---|---|
| HV.9 | fim da fala → primeiro áudio, visão aquecida, 20 perguntas reais; carga do disco; memória de pico do worker com os 3 modelos | mediana ≤ 9 s; carga ≤ 30 s; pico ≤ 9,5 GB |
| HV.8 | barge-in durante a visão: worker livre para o próximo STT | ≤ 2,5 s p95 em 20 tentativas |
| HV.10 | memória cai após a descarga, sem novo comando | observado |
| HV.12 | setup limpo + operação offline carrega a visão | passa |
| HV.14 | 10 perguntas do Rodrigo sobre a própria tela | ele diz se ajudou |

## 6. Riscos

| # | Risco | Mitigação |
|---|---|---|
| R1 | Subir `transformers`/`mlx` quebra ou muda o LLM e o STT já validados | S1 (diff do lock) + S6 (regressão contra a linha de base); fallback para ambiente separado |
| R2 | Dependências pesadas do `mlx-vlm` (rede, servidor web, câmera/vídeo) ampliam a superfície de supply chain | Versão e hashes fixados; instalar só no setup (como hoje); opt-in (V2); S7 prova que não há tráfego em operação |
| R3 | A biblioteca muda a API de novo | S4 (teste de assinatura) |
| R4 | Memória: LLM + STT + visão no mesmo processo pressionam os 16 GB | HV.9 com asserção, descarga (S5) |
| R5 | Sem acesso ao Hugging Face daqui, nomes e tamanhos dos modelos não foram confirmados | A primeira etapa no Mac é só consultar os dois repositórios (S2 já faz isso antes de baixar) |
| R6 | O modelo errado (3B sem medição) vira padrão por inércia | V1 |

## 7. Quem executa, aval e estimativa (minhas, não medidas)

| Etapa | Quem | Aval do Rodrigo | Estimativa |
|---|---|---|---|
| Decidir V1–V4 | Rodrigo | É o próprio aval | — |
| Auditoria deste plano (agy/Codex, pedida pelo Grok) | Grok | — | 1 rodada |
| S1–S5 em PR de rascunho (testes que rodam sem o Mac, mais S4/S7 que precisam do Mac) | Claude escreve | Sim, cada PR | 6–8 h |
| Instalar, S6 e medições HV no Mac | Grok no Mac, com o Rodrigo para HV.14 | Sim | 3–4 h mais o tempo de download |

## 8. Ordem

1. V1–V4 decididos e plano auditado. 2. No Mac, **antes de mudar qualquer coisa:** registrar a linha de base (`bench:voice`, lock atual, suíte). 3. S1 → S2 → S3 → S4 → S5 (cada um com o teste primeiro). 4. S6 e S7. 5. Medições HV.8–HV.10 e HV.12. 6. Só então HV.14 com o Rodrigo. A Fatia 5 (PR #11) pode andar em paralelo, mas `RODRIGO_CLOUD_VISION=1` só em uso real depois do HV.14.
