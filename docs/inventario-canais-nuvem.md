# Inventário de canais de nuvem do Rodrigo AI (T1, primeira entrega do plano §3.1)

Gerado a partir do código em `main` (`4369973`), com os pontos de aplicação conferidos por `rg` em 2026-10-13. **Declara configuração; não mede tráfego.** A medição real (captura de pacotes) é o item que falta da T1.

## O que SAI do computador

| Canal | O que sai | Controle (env) | Padrão | Guarda de saída (T1) | Destino |
|---|---|---|---|---|---|
| Geração de texto | o prompt inteiro: instrução do agente, **bloco de memórias** (se ligado), **histórico** (janela de N turnos) e a fala do turno; trecho de `docs/research/` só com o controle próprio | `RODRIGO_CLOUD` (mestre), `RODRIGO_SEND_HISTORY`, `RODRIGO_HISTORY_TURNS`, `RODRIGO_SEND_MEMORIES`, `RODRIGO_SEND_KNOWLEDGE` | ligado; conhecimento **desligado** | `guardMessages` sobre **todas** as mensagens: `sessionManager.ts:1429` e, em profundidade, `worker.py:1658` | Google (Gemini), pelo worker; um único ponto cria o cliente, sem seguir redirecionamentos |
| Intenção | o texto da fala atual (só falas que parecem hora/data/lembrete/nota) | `RODRIGO_CLOUD_INTENT` | ligado | `sessionManager.ts:922` e `worker.py:1399` | Google (Gemini, modelo leve) |
| Voz (TTS) | o **texto de cada frase** que o assistente vai falar | `RODRIGO_CLOUD_TTS` (só efetivo com histórico ligado), `RODRIGO_TTS_DICTATED` (confirmações que repetem o que você ditou) | ligado | `geminiVoiceProvider.ts:152` e `worker.py:1546` | Google (Gemini TTS) |
| Visão | a **imagem da tela**, só com o canal ligado **e** autorização falada naquele pedido | `RODRIGO_CLOUD_VISION` | **desligado** | só a **pergunta** que acompanha a imagem (`worker.py:1207`); **a imagem não é varrida** | Google (Gemini) |
| Busca web | o texto da tarefa delegada | `RODRIGO_WEB_SEARCH` | **desligado** | (texto da tarefa; fora do guarda) | gateway do OpenClaw em `RODRIGO_OPENCLAW_GATEWAY_URL` (padrão `http://127.0.0.1:18789`, loopback) e, daí, o provedor que o OpenClaw usar |

## O que NUNCA sai

- **Áudio do usuário.** Entra no STT local (`mlx-whisper`) e não vai a nenhum serviço.
- **Notas, lembretes e memórias armazenadas**, exceto o bloco de memórias do prompt de geração (linha 1 da tabela) quando `RODRIGO_SEND_MEMORIES=1`.
- **Imagem da tela**, se `RODRIGO_CLOUD_VISION` estiver desligado (o padrão). Sem ele a descrição cai no modelo de visão local.
- **Conteúdo do registro de auditoria da T4** (só códigos, sem fala nem texto).

## Como o estado é mostrado

`GET /api/privacy` e o cartão da tela inicial mostram a **configuração em vigor** (declarada, não medida); `npm run doctor` avisa as combinações de risco. O teste `privacyConsistency.test.ts` reprova texto que prometa "tudo local" enquanto a geração em nuvem estiver ligada.

## Fora do runtime do app (ferramentas de desenvolvimento)

Não fazem parte do que o app envia, mas **recebem código ou documentos do projeto** quando um agente de desenvolvimento os usa para auditar ou delegar: Codex, agy, DeepSeek/Kimi (NVIDIA NIM), MiMo, Jev (TypeSafe), Hermes (nuvem da Nous). Regra do projeto: nunca enviar `docs/research/`, `.env`, `memory/` nem material pessoal; exportar só código quando for auditar.

## Lacunas conhecidas (honestidade)

1. **A imagem da tela não passa por nenhum guarda** (senha ou dado pessoal visível na tela vai junto, se o canal estiver ligado e você autorizar). Mitigação atual: desligado por padrão e autorização por pedido.
2. **Nada aqui prova o que de fato trafega.** O teste `f12Egress` mede contra um Gemini falso em loopback; falta a captura de pacotes (tcpdump/nettop) com lista de permitidos aprovada. Isso exige o Mac e privilégio.
3. **O guarda procura padrões** (chaves de API, senhas ditadas, CPF, CNPJ, cartão). Dado pessoal sem padrão (um nome, um endereço) **não é detectado**.
4. **No nível gratuito do Google** o conteúdo enviado pode ser usado para melhorar produtos; o app não sabe o nível da chave (o `doctor` avisa).
5. O canal de busca web depende da política de ferramentas do agente no OpenClaw, que vive **fora do repositório** (PR #10, decisões D1–D6 pendentes).
