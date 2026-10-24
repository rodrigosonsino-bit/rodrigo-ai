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

## Atualização e Reavaliação (2026-10-15)
- **Consulta direta ao repositório no Hugging Face (`nvidia/personaplex-7b-v1`):** A NVIDIA e a comunidade confirmaram que o modelo não possui suporte a pt-BR devido à inexistência de datasets abertos de diálogo em canais separados (*split-channel conversational audio*) em português. Usuários relatam respostas em inglês ou fonemas truncados ao tentar falar em português.
- **Plano de Integração e Auditoria:** Foi elaborado o plano [`docs/plans/t7-personaplex-spike-e-integracao.md`](file:///Users/rodrigosonsino/orca/workspaces/rodrigo-ai/halibut/docs/plans/t7-personaplex-spike-e-integracao.md) e submetido à auditoria adversarial via Claude Code em [`docs/audits/t7-personaplex-adversarial-audit.md`](file:///Users/rodrigosonsino/orca/workspaces/rodrigo-ai/halibut/docs/audits/t7-personaplex-adversarial-audit.md), recebendo o veredito formal **BLOQUEADO** (violação do critério G1, risco de concorrência de GPU/Metal no M5 de 16 GB e quebra do isolamento de rede do app).
- **Decisão do Rodrigo (2026-10-15):** Diante da ausência de suporte ao português, o Rodrigo decidiu: *"vamos aguardar então"*.
- **Estado ratificado:** A trilha T7 permanece **estritamente em monitoramento periódico**. Próxima checagem mensal agendada para **2026-11-13**.

## Fontes consultadas (2026-10-13 e 2026-10-15)
- Repositório oficial: https://github.com/NVIDIA/personaplex
- Discussões de suporte multilíngue no Hugging Face: https://huggingface.co/nvidia/personaplex-7b-v1/discussions
- Resumo do porte para Apple Silicon (Swift/MLX): https://feedbagel.com/post/nvidia-personaplex-7b-enables-real-time-speech-to-speech-on-apple-silicon-via-sw
- Biblioteca `speech-swift`: https://github.com/soniqo/speech-swift
- Guia de arquitetura (secundária): https://www.oflight.co.jp/en/columns/nvidia-personaplex-7b-full-duplex-voice-ai-guide-2026
