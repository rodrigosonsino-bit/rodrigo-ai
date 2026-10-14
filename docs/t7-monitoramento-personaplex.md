# T7: voz da NVIDIA (PersonaPlex): monitoramento (2026-10-13)

**Estado:** só monitoramento, como o plano v2.6 §3.7 manda. **Nenhum código no app.** Esta é a primeira checagem datada; o plano pede checagem **mensal** (próxima: 2026-11-13).

## Critérios de entrada (G1 a G5) e o que apurei hoje
| Critério | Estado hoje | Evidência e limite |
|---|---|---|
| **G1** português do Brasil | **Sem evidência.** | A página do repositório oficial não lista idiomas e não cita português; só menciona treino no corpus Fisher English. Fonte secundária (resumo em francês) repete "Fisher English, 1.217 h". Não li o cartão do modelo no Hugging Face (exige login). |
| **G2** caminho para o hardware do Rodrigo | **Mudou: existe porte para Apple Silicon, de terceiros.** | A página oficial só descreve PyTorch com GPU/CPU (nada de MPS/MLX). Mas há relatos de um porte em **Swift/MLX** (biblioteca `speech-swift`), quantizado (8 bits recomendado; 4 bits com perda de qualidade), rodando mais rápido que tempo real num MacBook. **Não testei**, são fontes secundárias, e o porte é de terceiros (supply chain: dependência nova, exige plano e auditoria). |
| **G3** manter as garantias (modo "papo" sem ferramentas) | Sem mudança. | A página oficial não menciona chamada de ferramentas. |
| **G4** licença dos pesos aceita por você | **Pendente, é sua.** | Código MIT; **pesos sob a "NVIDIA Open Model License"**, e o download exige logar no Hugging Face e **aceitar a licença**. Não aceitei nada por você. |
| **G5** áudio fica na máquina, consentimento por sessão | Não avaliável ainda. | Propriedade a **demonstrar** na implementação (captura de pacotes), nunca afirmada antes. |

## Conclusão
Entrada **bloqueada** por G1 (sem português) e G4 (sua decisão). A novidade é que G2 deixou de ser impeditivo em tese. Se um dia G1 for resolvido (modelo com português, ou prova por teste com áudio em português), vale reabrir com plano próprio e auditoria. **Teste que o monitoramento mensal deve repetir:** buscar "PersonaPlex Portuguese", conferir o cartão no Hugging Face (idiomas) e o estado do porte MLX.

## Fontes consultadas (2026-10-13)
- Repositório oficial: https://github.com/NVIDIA/personaplex
- Resumo do porte para Apple Silicon (Swift/MLX): https://feedbagel.com/post/nvidia-personaplex-7b-enables-real-time-speech-to-speech-on-apple-silicon-via-sw
- Biblioteca `speech-swift`: https://github.com/soniqo/speech-swift
- Guia de arquitetura (secundária): https://www.oflight.co.jp/en/columns/nvidia-personaplex-7b-full-duplex-voice-ai-guide-2026
