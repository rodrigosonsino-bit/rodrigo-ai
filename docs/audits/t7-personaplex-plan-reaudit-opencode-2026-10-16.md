# Reauditoria de Plano T7 — OpenCode

- **Data:** 2026-10-16
- **Ferramenta:** `opencode run`
- **Modelo efetivo:** `google/gemini-2.5-flash`
- **Entrada principal:** `docs/plans/t7-personaplex-spike-e-integracao.md` (versao revisada apos a 1a auditoria)
- **Status:** concluida com resposta

## Prompt usado

```text
Reaudite adversarialmente, em modo read-only, o plano anexado apos revisao. Contexto minimo: pipeline atual = audio -> STT local -> classificacao/roteamento/ferramentas -> geracao textual -> TTS; hoje o audio do usuario nao sai da maquina; o app e loopback-only; o plano propoe PersonaPlex remoto opcional e chat-only. Verifique se os achados criticos anteriores foram tratados o suficiente para liberar implementacao de fases futuras, e procure novos achados de alta/critica gravidade. Responda em portugues com: VEREDITO, achados numerados por gravidade com evidencia e recomendacao, e diga explicitamente se ainda existe bloqueio alto para implementar.
```

## Resultado bruto

### VEREDITO

**Aprovado com ressalvas estruturais e restricoes de escopo.** O plano T7 esta conceitualmente solido, respeita as fronteiras arquiteturais do projeto (mantendo o modo default-off, exigindo allowlist estrita de egress e impedindo contaminacao do pipeline classico de mutacoes e ferramentas). No entanto, **ainda existem bloqueios operacionais e tecnicos de alta gravidade** (especialmente relacionados a natureza do streaming binario de audio e a inspecao de conteudo pelo `outboundGuard`) que devem ser resolvidos antes de iniciar qualquer codificacao ou testes de integracao (Fase 2 em diante).

### Achados de Auditoria Adversarial

#### Achado 1 (Alta Gravidade): Incompatibilidade conceitual entre o `outboundGuard` (focado em texto/JSON) e o fluxo binario full-duplex de audio do PersonaPlex.

- **Evidencia:** O plano afirma na Secao 5.1 que "a implementacao deve ligar essa allowlist ao subsistema de saida ja existente (`outboundGuard` / politica de egress)". Contudo, o `outboundGuard` e as defesas de privacidade do projeto operam inspecionando e redigindo conteudo textual (payloads JSON/texto enviado a LLMs). No PersonaPlex, o trafego e **audio bruto continuo** (stream binario via WebSocket upstream).
- **Risco:** Falsa sensacao de seguranca. O `outboundGuard` nao consegue "redigir" ou inspecionar semantica de audio bruto em tempo real. Se o usuario falar algo sensivel, o audio sai integralmente para o host remoto.
- **Recomendacao:** Ajustar o plano para explicitar que, para o modo PersonaPlex, o `outboundGuard` atua estritamente no **controle de destino (allowlist estrita de host/porta e bloqueio de handshake se a flag estiver desativada)**, e **nunca** como inspetor de conteudo de audio, documentando isso de forma cristalina na UI e em `GET /api/privacy`.

#### Achado 2 (Media Gravidade): Gargalos de Event Loop e Gestao de Sockets no Node.js para streaming full-duplex em tempo real.

- **Evidencia:** A Secao 4.4 propoe que o Node atue como intermediario retransmitindo frames binarios de WebSocket entre o cliente (navegador) e o servidor remoto (PersonaPlex).
- **Risco:** Node.js puro lidando com buffers binarios de audio full-duplex de alta frequencia pode sofrer com pressao de GC, latencia de buffer e travamento de event loop se o backpressure nao for tratado com streams rigorosos (`pipeline` / `duplex`).
- **Recomendacao:** Adicionar no plano (Fase 2/4) um requisito de teste de carga de streaming binario no Node para validar o consumo de memoria e o comportamento de backpressure antes de considerar o MVP estavel.

#### Achado 3 (Baixa Gravidade / UX): Ambiguidade visual do estado experimental.

- **Evidencia:** O plano propoe exibicao visual e aviso de que ferramentas/memoria estao desativadas.
- **Risco:** O usuario pode confundir a sessao PersonaPlex com o assistente local principal e presumir que a garantia de privacidade local ("o audio nunca sai da maquina") continua ativa.
- **Recomendacao:** Exigir na UI um **banner persistente inconfundivel e obrigatorio** (ex: cor de destaque diferenciada, ex. ambar/vermelho, com os dizeres *"MODO EXPERIMENTAL REMOTO — AUDIO SAINDO PARA HOST EXTERNO"*) enquanto o modo PersonaPlex estiver ativo.

### Bloqueio para Implementacao

**Sim, ainda existem bloqueios altos (Gate 0 e Gate 1 do plano) que impedem a execucao de codigo:**

1. **Gate 0 (Infraestrutura):** A ausencia de um host fisico com GPU NVIDIA acessivel para rodar o servidor PersonaPlex (`port 8998`) impede qualquer validacao pratica do MVP.
2. **Gate 1 (Alinhamento de Privacidade):** A formalizacao de que, neste modo especifico, a promessa de localidade do audio e quebrada deve ser explicitamente validada e documentada.

**Conclusao:** O plano esta aprovado como especificacao arquitetural, mas **nenhuma linha de codigo** deve ser escrita (Fase 2 em diante) ate que o Gate 0 (host NVIDIA disponivel) seja superado e o Achado 1 seja incorporado ao texto da especificacao de privacidade.
