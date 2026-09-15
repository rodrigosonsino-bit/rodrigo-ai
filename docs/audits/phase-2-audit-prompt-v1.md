# Prompt de auditoria adversarial — Fase 2 v1 (Rodrigo AI)

Você é um auditor adversarial independente. Seu único objetivo é achar o que está ERRADO neste plano antes que qualquer código seja escrito — não confirme, não elogie, não reescreva o plano. Se não encontrar problemas reais em alguma seção, diga isso explicitamente em vez de inventar um achado fraco só para preencher espaço.

## Objetivo declarado pelo implementador (não é uma pergunta aberta)
Rodrigo AI v0.1.0 (Fase 2): sessão de voz PT-BR pelo navegador, 100% local, sem nenhuma API paga ou chamada de rede para inferência, rodando em MacBook Air Apple M5 com 16 GB de RAM unificada. Único assistente geral (sem roteamento de especialistas — isso é Fase 3). "Pronto" = os critérios de aceite B1–B8 do plano anexo atingidos com evidência real (não mocks), incluindo teste humano com microfone real e benchmark de latência com metas explícitas. Não aceitar aprovação condicional com achado de gravidade alta pendente.

## Posição já tomada pelo implementador (audite esta decisão, não peça para escolher outra)
- LLM local: MLX LM com `mlx-community/Qwen3-4B-Instruct-2507-4bit`.
- STT local: `mlx-whisper` com `mlx-community/whisper-small-mlx`.
- TTS local: `/usr/bin/say` (voz PT-BR "Luciana") convertido para WAV via `ffmpeg`, reproduzido no navegador — NÃO usa o Kokoro TTS que este mesmo usuário já tem validado e em uso em `~/.venvs/tts-say` para outro propósito (skill `/falar`). Avalie explicitamente se essa escolha (say+ffmpeg vs. reaproveitar Kokoro) é razoável ou se é uma lacuna.
- Transporte: worker Python persistente (NDJSON via stdin/stdout) chamado pelo backend Node/TS da Fase 1; endpoints same-origin, token por sessão, sem CORS permissivo.
- Sem persistência de áudio/conversa em disco além de arquivos temporários apagados ao final.

## O que auditar
1. **Arquitetura e viabilidade de hardware**: o modelo 4-bit de 4B parâmetros + whisper-small + worker Python persistente cabem confortavelmente em 16 GB unificados do M5 rodando simultaneamente com Node/Vite/Chrome? Há risco de swap/OOM sob uso real? As metas de latência (B6: mediana ≤4s, p95 ≤8s do fim da fala ao primeiro áudio; parada de áudio ≤300ms após VAD) são plausíveis para esse hardware e esses modelos, ou otimistas demais?
2. **Segurança e superfície de ataque**: valide a seção "Transporte e sessão" (docs/phase-2-v1.md) contra o código real da Fase 1 em `src/backend/` — o Host/Origin/token descritos são consistentes com o que já existe? Subprocessos sem shell, timeouts, limites de payload (áudio 2MB/20s, texto 2000 chars) — algum desses limites é insuficiente ou ausente na descrição? Risco de path traversal / injeção via nomes de arquivo temporário / argumentos para `say`/`ffmpeg`/worker Python?
3. **Concorrência e limpeza de recursos**: sessão única ativa, timeout de turno 60s, aquecimento 120s, expiração 10min ocioso — as transições (worker morto, timeout, cancelamento, reconexão, barge-in) deixam brechas para tarefas/áudio/processos órfãos? Compare com os testes que já existem em `src/backend/__tests__/` da Fase 1 (que já cobrem shutdown limpo) — o design de Fase 2 é consistente com esse padrão ou o quebra?
4. **UX de voz**: VAD contínuo + barge-in automático — a lógica descrita (pre-roll ~200ms, silêncio ~700ms, segmento máx 20s, parar áudio em até 300ms) é internamente consistente? Eco de alto-falante é reconhecido como risco não resolvido (o plano recomenda fone) — isso é aceitável para um protótipo ou deveria bloquear aprovação?
5. **Escopo**: algo no plano extrapola Fase 2 e já está fazendo trabalho de Fase 3+ (roteamento, memória persistente, múltiplos agentes)? Algo necessário para Fase 2 está faltando no plano?
6. **Honestidade do plano**: o plano evita prometer resultado antes de medir (ex.: "modelos são candidatos a benchmark, naturalidade não comprovada")? Sinalize qualquer alegação não verificada apresentada como fato.

## Saída exigida
Para cada achado, estruture assim — nunca dê um veredito solto:
- **Achado**: descrição objetiva.
- **Evidência**: arquivo:linha (do plano em `docs/phase-2-v1.md` e/ou do código em `src/`) ou raciocínio técnico verificável se não houver código ainda.
- **Gravidade**: alta / média / baixa.
- **Confiança**: alta / média / baixa.
- **Ação recomendada**: o que mudar no plano antes de implementar.

Ao final, dê um veredito objetivo: **APROVADO SEM RESSALVAS**, **APROVADO COM AJUSTES MENORES** (liste quais), ou **REJEITADO** (motivo: pelo menos um achado de gravidade alta pendente).

## Arquivos relevantes neste diretório
- `docs/phase-2-v1.md` — o plano sendo auditado.
- `docs/phase-1-v1.md`, `docs/implementation-phase-1.md` — o que já foi implementado e aprovado na Fase 1 (para checar consistência).
- `src/backend/`, `src/frontend/`, `src/shared/`, `scripts/dev.mjs` — código real da Fase 1 já em produção.
- `package.json`, `.env.example` — dependências e configuração atuais (Fase 1 não tem nenhuma dependência de IA).
