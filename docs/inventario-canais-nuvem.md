# Inventário de canais de nuvem do Rodrigo AI (T1, primeira entrega do plano §3.1)

Gerado a partir do código em `main` (`4369973`), com os pontos de aplicação conferidos por `rg` em 2026-10-13. **Declara configuração; não mede tráfego.** A medição real (captura de pacotes) é o item que falta da T1.

## O que SAI do computador

| Canal | O que sai | Controle (env) | Padrão | Guarda de saída (T1) | Destino |
|---|---|---|---|---|---|
| Geração de texto | o prompt inteiro: instrução do agente, **bloco de memórias** (se ligado), **histórico** (janela de N turnos) e a fala do turno; trecho de `docs/research/` só com o controle próprio | `RODRIGO_CLOUD` (mestre), `RODRIGO_SEND_HISTORY`, `RODRIGO_HISTORY_TURNS`, `RODRIGO_SEND_MEMORIES`, `RODRIGO_SEND_KNOWLEDGE` | ligado; conhecimento **desligado** | `guardMessages` sobre **todas** as mensagens: `sessionManager.ts:1429` e, em profundidade, `worker.py:1658` | Google (Gemini), pelo worker; um único ponto cria o cliente, sem seguir redirecionamentos |
| Intenção | o texto da fala atual (hora/data/lembrete/nota; e, com Claude Code efetivo, falas que passam em `mightBeClaudeCodeDelegation`) | `RODRIGO_CLOUD_INTENT` | ligado | `sessionManager.ts:1051` e `worker.py` (`detect_intent`) | Google (Gemini, modelo leve) |
| Voz (TTS) | o **texto de cada frase** que o assistente vai falar | `RODRIGO_CLOUD_TTS` (só efetivo com histórico ligado), `RODRIGO_TTS_DICTATED` (confirmações que repetem o que você ditou) | ligado | `geminiVoiceProvider.ts:152` e `worker.py:1546` | Google (Gemini TTS) |
| Visão | a **imagem da tela**, só com o canal ligado **e** autorização falada naquele pedido | `RODRIGO_CLOUD_VISION` | **desligado** | só a **pergunta** que acompanha a imagem (`worker.py:1207`); **a imagem não é varrida** | Google (Gemini) |
| Busca web | o texto da tarefa delegada | `RODRIGO_WEB_SEARCH` | **desligado** | (texto da tarefa; fora do guarda) | gateway do OpenClaw em `RODRIGO_OPENCLAW_GATEWAY_URL` (padrão `http://127.0.0.1:18789`, loopback) e, daí, o provedor que o OpenClaw usar |
| Claude Code (Fase 17) | a **ordem falada** (depois da confirmação por voz) e o **conteúdo dos arquivos que o Claude ler** dentro da raiz permitida (worktree limpo, sem `docs/research`, dentro de um perfil de isolamento do macOS que nega o resto do HOME) | `RODRIGO_CLAUDE_CODE` (só efetivo com `RODRIGO_CLOUD` ligado; exige também `config/claude-code-roots.json`, o binário `claude` e a prova de isolamento `scripts/claude-code-selftest.mjs`) | **desligado** | a **ordem** passa por `guardText` antes de sair (`claudeCode.ts`); o conteúdo lido pelo Claude **não é varrido** | Anthropic, pelo processo `claude -p` (nunca pelo Node do app); o resultado volta como dado não confiável, é falado só com a voz do sistema e fica fora do histórico enviado ao Gemini |
| Claude Code (Fase 17) | a **ordem falada** (após confirmação por voz) e o **conteúdo dos arquivos** que o `claude -p` ler no `cwd` | `RODRIGO_CLAUDE_CODE` (só efetivo com `RODRIGO_CLOUD=1`) | **desligado** | `guardText` no prompt e na saída: `claudeCodeSubAgent.ts:85` e `:191`; intenção de nuvem que classifica `DELEGAR_CODIGO` também passa pelo guarda (`sessionManager.ts:1051`) | Anthropic (CLI `claude -p` sob o plano da assinatura); áudio e stores do app **não** vão nesta chamada |
| Ogra (fase 1) | o **texto da fala** (depois do `guardText`) e o catálogo de capacidades (id/nome/tipo). O 2xx do webhook não traz resposta; ela volta no callback local (`taskId`, `sessionId`, `text`) | `RODRIGO_OGRA` (não depende do mestre Gemini); prazo `RODRIGO_OGRA_REPLY_TIMEOUT_MS` | **desligado** | `guardText` no texto que sai (`ograSubAgent.ts`) e de novo na resposta, depois de `neutralizeUntrusted` | webhook `GROK_WEBHOOK_URL` (Bearer `GROK_WEBHOOK_KEY`). Áudio não vai. Callback: `POST /api/ogra/reply` com `RODRIGO_OGRA_CALLBACK_TOKEN` |

## O que NUNCA sai

- **Áudio do usuário.** Entra no STT local (`mlx-whisper`) e não vai a nenhum serviço.
- **Notas, lembretes e memórias armazenadas**, exceto o bloco de memórias do prompt de geração (linha 1 da tabela) quando `RODRIGO_SEND_MEMORIES=1`.
- **Imagem da tela**, se `RODRIGO_CLOUD_VISION` estiver desligado (o padrão). Sem ele a descrição cai no modelo de visão local.
- **Conteúdo do registro de auditoria da T4** (só códigos, sem fala nem texto).

## Como o estado é mostrado

`GET /api/privacy` e o cartão da tela inicial mostram a **configuração em vigor** (declarada, não medida); `npm run doctor` avisa as combinações de risco. O teste `privacyConsistency.test.ts` reprova texto que prometa "tudo local" enquanto a geração em nuvem estiver ligada.

## Fora do runtime do app (ferramentas de desenvolvimento)

Não fazem parte do que o app envia, mas **recebem código ou documentos do projeto** quando um agente de desenvolvimento os usa para auditar ou delegar: Codex, agy, DeepSeek/Kimi (NVIDIA NIM), MiMo, Jev (TypeSafe), Hermes (nuvem da Nous). Regra do projeto: nunca enviar `docs/research/`, `.env`, `memory/` nem material pessoal; exportar só código quando for auditar.

## Controles locais sem canal novo

- **Viva-voz (2026-10-15):** toggle opt-in no painel/browser; limiares VAD mais altos, duck 0,85 e `echoCancellation`/`noiseSuppression` pedidos ao sistema; AGC desligado no modo. **Não cria canal de nuvem** — áudio do usuário continua só no STT local. Eco residual e calibração acústica ficam na dívida T8. Voz pessoal (enrolamento) **fora** desta fatia.

## Lacunas conhecidas (honestidade)

1. **A imagem da tela não passa por nenhum guarda** (senha ou dado pessoal visível na tela vai junto, se o canal estiver ligado e você autorizar). Mitigação atual: desligado por padrão e autorização por pedido.
2. **Nada aqui prova o que de fato trafega.** O teste `f12Egress` mede contra um Gemini falso em loopback; falta a captura de pacotes (tcpdump/nettop) com lista de permitidos aprovada. Isso exige o Mac e privilégio.
3. **O guarda procura padrões** (chaves de API, senhas ditadas, CPF, CNPJ, cartão). Dado pessoal sem padrão (um nome, um endereço) **não é detectado**.
4. **No nível gratuito do Google** o conteúdo enviado pode ser usado para melhorar produtos; o app não sabe o nível da chave (o `doctor` avisa).
5. O canal de busca web depende da política de ferramentas do agente no OpenClaw, que vive **fora do repositório** (PR #10, decisões D1–D6 pendentes).
6. **Claude Code (Fase 17):** canal novo, padrão desligado. Toda chamada exige confirmação falada (`markPlayed` + classificador determinístico). O plano `docs/phase-17-v1.md` ainda lista decisões D1–D6 do Rodrigo; o WIP atual concede escrita (`bypass-permissions` + tools Bash/Write) — divergência a ratificar. Suíte H17.1–H17.8 e auditoria adversária do plano ficam fora deste inventário.
