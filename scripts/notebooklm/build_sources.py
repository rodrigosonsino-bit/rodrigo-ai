#!/usr/bin/env python3
"""Gera as fontes do notebook do Rodrigo AI. Fatos do handoff vêm de COMANDOS rodados aqui, não de memória.
Nunca inclui: docs/research/, .env, chaves, .runtime, dist, node_modules, data/."""
import os, re, subprocess, sys, datetime, pathlib

ROOT = pathlib.Path(os.environ["REPO"])
OUT = pathlib.Path(os.environ["OUT"])
MEM = pathlib.Path(os.path.expanduser("~/.claude/projects/-Users-rodrigosonsino-Documents-Codex-2026-09-11-referenced-chatgpt-conversation-this-is-an-outputs-rodrigo-ai/memory"))
OUT.mkdir(parents=True, exist_ok=True)
for f in OUT.glob("*"):
    f.unlink()

def sh(cmd, timeout=120):
    r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    return (r.stdout + (("\n" + r.stderr) if r.returncode and r.stderr else "")).strip()

def read(p):
    return (ROOT / p).read_text(encoding="utf-8")

BLOCKED = ("docs/research", ".env", ".runtime", "node_modules", "dist/", "data/")
def safe(p):
    s = str(p)
    return not any(b in s for b in BLOCKED) or s.endswith(".env.example")

LANG = {".ts": "ts", ".py": "python", ".mjs": "js", ".js": "js", ".html": "html", ".css": "css", ".json": "json", ".md": "md", ".sh": "bash"}

def bundle(name, title, intro, files):
    parts = [f"# {title}\n\n{intro}\n\nGerado em {datetime.date.today()} a partir do repositório (commit {sh('git rev-parse --short HEAD')}). Cada seção é um arquivo, com o caminho no título.\n"]
    n = 0
    for f in files:
        p = ROOT / f
        if not p.is_file() or not safe(f):
            continue
        txt = p.read_text(encoding="utf-8", errors="replace")
        parts.append(f"\n\n---\n\n## Arquivo: `{f}` ({len(txt.splitlines())} linhas)\n\n```{LANG.get(p.suffix, '')}\n{txt}\n```\n")
        n += 1
    (OUT / name).write_text("".join(parts), encoding="utf-8")
    return n

def docs_bundle(name, title, intro, files):
    parts = [f"# {title}\n\n{intro}\n"]
    n = 0
    for f in files:
        p = ROOT / f
        if p.is_file() and safe(f):
            parts.append(f"\n\n---\n\n# [{f}]\n\n{p.read_text(encoding='utf-8', errors='replace')}\n")
            n += 1
    (OUT / name).write_text("".join(parts), encoding="utf-8")
    return n

# ---------------------------------------------------------------- 00 handoff (fatos por comando)
tree_backend = sh("find src scripts -type f \\( -name '*.ts' -o -name '*.py' -o -name '*.mjs' -o -name '*.html' -o -name '*.css' \\) ! -path '*__tests__*' | sort")
tests_node = sh("ls src/backend/__tests__/*.test.ts | xargs -n1 basename | sort")
tests_py = sh("ls scripts/worker/test_*.py | xargs -n1 basename | sort")
git_log = sh("git log --oneline -25")
git_status = sh("git status --short") or "(limpo)"
git_branch = sh("git branch --show-current")
git_ahead = sh("git rev-list --count origin/main..HEAD")
git_remote = sh("git remote -v | head -1")
n_commits = sh("git log --oneline | wc -l")
env_names = sh("grep -E '^[A-Z_]+=' .env.example | sed -E 's/=.*//' | tr '\\n' ' '")
env_example = read(".env.example")
node_v = sh("node -v")
py_v = sh(".runtime/.venv/bin/python --version")
pkgs = sh(".runtime/.venv/bin/python -c \"import importlib.metadata as m; print(', '.join(p+' '+m.version(p) for p in ['google-genai','mlx','mlx-lm','mlx-whisper','numpy','httpx']))\"")
models = sh("python3 -c \"import json; d=json.load(open('.runtime/models-manifest.json')); print('LLM local:', d['llm']['repo'], '| STT:', d['stt']['repo'])\"")
loc = sh("echo \"backend TS: $(find src/backend -name '*.ts' ! -path '*__tests__*' | xargs cat | wc -l | tr -d ' ') linhas | worker.py: $(wc -l < scripts/worker/worker.py | tr -d ' ') linhas | testes Node: $(ls src/backend/__tests__/*.test.ts | wc -l | tr -d ' ') arquivos\"")
ports = sh("lsof -iTCP:3000 -sTCP:LISTEN -n -P | awk 'NR>1{print \"app na porta 3000, pid \" $2}'") or "(nada escutando na 3000 agora)"
ttsstat = sh("curl -s -m 4 http://127.0.0.1:3000/api/voice/tts-status") or "(app fora do ar)"
now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

handoff = f"""# LEIA PRIMEIRO — Rodrigo AI: passagem de bastão para outro agente ({now})

Escrito para ser lido por inteiro antes da primeira ação. Todas as afirmações factuais abaixo foram geradas por comando no momento da escrita (o comando aparece junto) ou estão marcadas como **suposição herdada** ou **combinado com o usuário** (citado literalmente). O que o leitor não puder conferir por comando está na terceira classe.

Este notebook contém o contexto do projeto. **Não contém**: `docs/research/` (perfil teológico e material de Virtologia pessoais do usuário — nunca foi versionado nem enviado a terceiros), o arquivo `.env` e qualquer chave de API, nem as instruções globais privadas do usuário. Se precisar desse material, peça ao usuário.

## 1. O que é o app

Rodrigo AI é um **orquestrador de voz pessoal**, local-first, construído por fases (cada fase entrega algo funcional e testável antes da próxima; não construir adiante do plano aprovado). Servidor Node (sem framework) + worker Python persistente (MLX) falando NDJSON por stdio + frontend TypeScript/Vite sem framework. Fala-se com ele no navegador em `http://127.0.0.1:3000`.

Fluxo de um turno: microfone no navegador → VAD → WAV enviado ao backend → STT local (mlx-whisper) → classificação de intenção (Gemini `gemini-3.5-flash-lite`, com detector local de reserva) → ferramentas determinísticas (hora/data; lembretes/notas/memórias com confirmação falada) **ou** geração de resposta (Gemini `gemini-flash-latest`, plano B `gemini-3.5-flash-lite`) por um dos agentes (Geral/Teologia/Virtologia) → frases enviadas ao TTS (**Gemini TTS desde a Fase 13a**, voz do sistema `say` de reserva) → áudio tocado no navegador → o cliente confirma a reprodução (`/played`) → só então a frase entra no histórico.

Restrições duras (valem para qualquer mudança): servidor só em loopback (`127.0.0.1`/`localhost`) com Host/Origin validados nas três camadas; áudio do usuário **nunca** sai da máquina; toda saída de dado para a nuvem tem controle explícito por canal em `src/backend/privacy.ts` e nenhuma tela/documento pode prometer localidade total ou ausência de custo/chave (teste `privacyConsistency.test.ts`); nada de mutação (criar/apagar lembrete/nota/memória) sem a pergunta ter sido **realmente reproduzida** (`markPlayed()`) e a resposta passar pelo classificador determinístico (zero falso "sim" é propriedade protegida); mudança de dependência externa exige plano, aprovação do usuário e auditoria adversarial.

## 2. Estado do repositório — verificado agora

```
git branch --show-current  -> {git_branch}
git remote -v | head -1    -> {git_remote}
git rev-list --count origin/main..HEAD -> {git_ahead}   (0 = nada comitado deixou de ser empurrado)
git log --oneline | wc -l  -> {n_commits}
git status --short         -> {git_status.replace(chr(10), chr(10) + ' ' * 27)}
node -v                    -> {node_v}
worker Python              -> {py_v}
pacotes do worker          -> {pkgs}
modelos locais             -> {models}
tamanho                    -> {loc}
```

Os 4 arquivos não rastreados acima (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`) são modelos genéricos de outra ferramenta de agente (OpenClaw), criados na raiz por algo que não é este projeto; foram comitados por engano e retirados do controle de versão (commit `984a797`); **ignorar**, não são código do app.

Últimos 25 commits (`git log --oneline -25`):
```
{git_log}
```

Estado do que está rodando (comandos agora): {ports}
`GET /api/voice/tts-status` -> `{ttsstat}`

**Testes: ESTADO QUEBRADO, verificado agora (`npx tsc -p tsconfig.server.json --noEmit`, 2026-10-09).** `npm test` não roda — falha já no `tsc` do `tsconfig.server.json`, antes de chegar em `node --test`: **177 erros, todos em `src/backend/voice/sessionManager.ts`**, primeiro erro na linha 591 (`'catch' or 'finally' expected`). É sintaxe quebrada (chave de bloco try/chave-abre/chave-fecha desencontrada em algum ponto do arquivo, não um erro de tipo), consistente com uma edição não commitada em andamento (ver `git status` no §2 — este arquivo está entre os 9 modificados). **Nenhuma contagem de teste anterior a isto deve ser usada**; a última vez que a suíte rodou de verdade e passou foi em 2026-10-08 após o commit `a1f12ab` (646 de 646), mas o estado do arquivo mudou desde então. `npm run typecheck` também falha pelo mesmo motivo. Testes Python do worker (`.runtime/.venv/bin/python scripts/worker/test_*.py`) não foram reverificados nesta rodada.

Arquivos de teste Node:
```
{tests_node}
```
Testes Python:
```
{tests_py}
```

## 3. Mapa do código (verificado: `find src scripts ...`)

```
{tree_backend}
```

Responsabilidades principais:
- `src/backend/server.ts` — servidor HTTP próprio: valida Host, roteia API, serve estáticos com guarda contra path traversal. `index.ts` sobe tudo e faz o desligamento gracioso.
- `src/backend/privacy.ts` — **fonte única** da configuração de saída de dados (`RODRIGO_*`); valores inválidos abortam o startup. `ttsCloudEffective()` e `ttsDictatedViaCloud()` decidem a voz em nuvem.
- `src/backend/voice/sessionManager.ts` — o coração: uma sessão ativa por vez (preempção síncrona), turnos canceláveis, orquestração (classificação → ferramentas/geração), emissão **em ordem** das frases ao cliente, coalescência de frases, `markPlayed()`.
- `src/backend/voice/mlxWorkerEngine.ts` — cliente do worker Python (NDJSON); `fakeEngine.ts` — motor falso dos testes.
- `scripts/worker/worker.py` — worker persistente: STT, LLM local (Qwen3-4B 4-bit), geração e intenção via Gemini, **TTS Gemini** (`synthesize`, pool próprio de threads), `redact()`/`safe_exc()` em toda saída de diagnóstico, único ponto de criação de cliente Gemini (`build_gemini_client`, redirecionamento desligado).
- `src/backend/voice/ttsProviders.ts`, `geminiVoiceProvider.ts`, `ttsBudget.ts` — escolha da voz, provedor Gemini com reserva `say`, orçamento de cota.
- `src/backend/voice/confirmationClassifier.ts` — classificador determinístico de confirmação (mundo fechado).
- `src/backend/tools/screenQuery.ts` — Fase V: reconhece pergunta sobre a tela (`mightBeScreenQuery`) e a gramática que autoriza mandar a imagem ao Gemini (`screenCloudAuthorized`).
- `src/backend/agents/` — agentes Geral/Teologia/Virtologia (prompts fixos, sem dependência externa). `src/backend/tools/` — hora/data e ferramentas que mudam estado (lembretes, notas, memórias) + agendador de lembretes. `src/backend/knowledge/` — recuperação BM25 de `docs/research/` (só carrega se `RODRIGO_SEND_KNOWLEDGE=1`). `src/backend/storage/` — armazenamento JSON em `data/`.
- `src/frontend/` — `main.ts` (cartão de privacidade, estado da voz), `voice.ts` (captura, VAD, fila de reprodução, barge-in).
- `src/shared/` — tipos e protocolo compartilhados; `extensions/` — pontos de extensão (`IVoiceProvider`, `IAgent`, `ITool`).
- `scripts/dev.mjs` — coordenador de processos do `npm run dev` (não deixa órfãos); `setup-voice.mjs` — cria `.runtime/.venv` e baixa os modelos; `bench-voice.mjs` — benchmark.

## 4. Ambiente local — como rodar, testar, depurar

Comandos (todos na raiz do projeto, `/Users/rodrigosonsino/Documents/Codex/2026-09-11/referenced-chatgpt-conversation-this-is-an/outputs/rodrigo-ai`):
```bash
npm ci                 # instala dependências a partir do lockfile
npm run setup:voice    # cria .runtime/.venv e baixa os modelos locais (uma vez)
npm run build          # tsc (servidor) + vite (cliente) -> dist/
npm start              # sobe o app em http://127.0.0.1:3000 (usa dist/)
npm run dev            # modo desenvolvimento (backend + Vite, proxy /api)
npm test               # tsc + node --test em dist/server/backend/__tests__/*.test.js (646 testes)
npm run typecheck
.runtime/.venv/bin/python scripts/worker/test_tts_synthesis.py   # testes Python são scripts individuais
```
Para rodar um único teste Node: `npm run build:server` e depois `node --test dist/server/backend/__tests__/<nome>.test.js`.

Variáveis de ambiente (nomes e padrões em `.env.example`, cujo conteúdo segue; **o `.env` real tem a chave `GEMINI_API_KEY` e nunca deve ser lido nem copiado**): {env_names}

```
{env_example}
```

Estado local relevante (verificado): o `.env` do usuário usa `TTS_ENGINE=gemini`; `.runtime/` (venv, modelos, orçamento do TTS) e `data/` (lembretes, notas, memórias) **não são versionados**; `docs/research/` existe só na máquina do usuário.

**Armadilhas do ambiente (todas já custaram tempo real):**
- O sandbox do Bash bloqueia MLX/Metal, bind de socket local, `ps`/`pgrep`, escrita em `~/.cache` (uv, Hugging Face) e `~/hermes-workspace`: rodar com a opção de desligar o sandbox. Um teste que "trava sem erro" com 0% de CPU é quase sempre isso.
- `pgrep -f "VAR=valor cmd"` nunca casa (variável de ambiente não está no argv). Para matar o app: usar o PID capturado no spawn, nunca padrão de nome. Resultado vazio de `pgrep` não prova que o processo morreu.
- `http.Server.close()` do Node pendura com SSE/keep-alive: usar `closeAllConnections()` + `closeIdleConnections()`. Teste que cria servidor precisa do teardown completo (o timer de 10 min da sessão segura o processo).
- No zsh, glob sem match aborta a linha inteira. Não misturar caminho literal e glob na mesma linha.
- `say` dentro do sandbox grava arquivo **vazio** sem erro (aconteceu: a primeira audição ficou com o Felipe mudo). Rodar fora do sandbox e conferir o tamanho do arquivo.
- Validar o harness antes de acreditar na evidência: um bug no script de medição já foi tratado como bug do sistema (a "repetição do LLM local" da Fase 4 era um cursor de polling que não avançava).
- Um teste que um atalho resolve não mede a capacidade que se quer medir (ex.: procurar uma agulha em 6000 linhas com `grep`).
- Catálogo de modelos autenticado não é direito de uso: exercitar com uma chamada barata antes de planejar em cima.
- Medidas cronometradas em testes que misturam HTTP e timers são frágeis nesta máquina (uma requisição local levou 170 ms): preferir chamada direta e folgas grandes.

## 5. Fases — estado (fontes: `CLAUDE.md`, `docs/implementation-phase-*.md`)

| Fase | O que entrega | Estado |
|---|---|---|
| 1 | Fundação: servidor loopback, health, extensões | feito |
| 2 | Voz local: STT, TTS `say`, sessão, barge-in, preempção | feito, validado com voz humana |
| 3 | Orquestrador: classificação de intenção + transparência de roteamento | feito |
| 4 | Agentes reais Geral/Teologia/Virtologia | feito |
| 5a | Recuperação de conhecimento (BM25 sobre `docs/research/`) | feito |
| 5b | Ferramentas hora/data | feito; **dívida aberta**: H11 mediu 75% (alvo 80%) |
| 5c | Lembretes e notas por voz (primeira capacidade que muda estado) | feito; **dívida aberta**: H-mutação 76,5%, H-confirmação 61,1% (zero falso "sim" mantido) |
| 6–9 | Lembretes agendados, memória entre sessões, edição, recorrência | feito (planos em `docs/phase-6-v2.md`…`phase-9-v2.md`) |
| 10a | Geração de texto via Gemini (única nuvem de início) | feito |
| 11 | Endurecimento da confirmação + intenção em nuvem | **fechada como dívida registrada, não como aprovada** (recall de intenção 63,0%/86,7% < alvo 95%; o alvo NÃO foi baixado); falta a medição com voz real (`docs/f11-roteiro-voz-real.md`, só o usuário faz) |
| 12 | Privacidade condizente com a promessa (controle por canal, cartão, egresso medido) + plano B da geração | feito e comitado |
| 13a | **Voz natural: TTS do Gemini com `say` de reserva** | implementado (`e617497`); **código auditado em 2026-10-08** (Kimi K3, 9 achados: 6 corrigidos em `fe7736e`, 1 falso positivo, 2 sem ação; `docs/audits/f13a-code-audit-kimi-k3-2026-10-08.md`); **H13a.10 (o usuário ouvir) ainda PENDENTE** — ver §6 |
| 13b | Conversa natural (latência/escuta) | começada: log `[timing]` por etapa (`af05e1e`); fim de fala aos **1,0 s** de silêncio (era 0,7 s; `e9ef641`, decisão do usuário). Plano de juntar fragmentos no servidor (`docs/phase-13b-v1.md`) **reprovado** pelo Codex (REFAZER) e substituído por essa decisão. Latência ainda não atacada |
| V | **Visão da tela** (inserida pelo usuário) | plano v3 aprovado com ajustes (`docs/phase-vision-v3.md`); **fatias 1, 2 e 3 feitas e auditadas** (fatia 3: `ce48a79`+`99e6fbc`, Kimi K3, 5 achados, todos procedentes); **fatias 4 e 5 pendentes** — ver §6b e §6c |
| 14 | Ciclo completo de notas, lembretes e memórias por voz | plano auditado: **aprovado com ajustes** (`docs/audits/phase-14-plan-audit-r1.md`); v2 em `docs/phase-14-v2.md`; **implementação em andamento, NÃO COMMITADA — e o build está QUEBRADO agora** (ver §2 e §6c) |
| 15 | Orquestrador autônomo, coordenador de todos os subagentes (inclui a ponte com o OpenClaw) | plano v1 **REFAZER** (`docs/audits/phase-15-plan-audit-r1.md`: busca web como leitura autônoma não classificada = vazamento de dado pra nuvem); v2 (`docs/phase-15-v2.md`) **autodeclara** "Aprovado para implementação" — **não encontrei auditoria da rodada 2 confirmando isso de forma independente**, tratar como pendente de confirmação; arquivos novos não commitados da interface `ISubAgent` (`subAgent.ts`, `adapters.ts`, `openClawSubAgent.ts`) e teste esqueleto — ver §6c |
| 16 | Conhecimento pessoal (Teologia/Virtologia/novas bases, ex. Neurociência) | mesma situação da F15: v1 **REFAZER** (`docs/audits/phase-16-plan-audit-r1.md`), v2 (`docs/phase-16-v2.md`) autodeclarado aprovado, sem auditoria r2 encontrada; teste esqueleto bem mais fino (24 linhas) que o da F15 — ver §6c |
| 17 | Qualificação 1.0 | não iniciada |

## 6. Fase 13a em detalhe (a mais recente — leia `docs/phase-13a-v3.md` e `docs/implementation-phase-13a.md`)

Objetivo (pedido literal do usuário): **"preciso que essa voz seja a voz do app"** — a voz do Gemini TTS que ele escolheu numa audição às cegas, porque a voz anterior (`say` Felipe) soava "robotizada, sem expressão humana".

Decisões do usuário nesta fase (citadas literalmente): "Gemini TTS, voz Charon"; "Ativa a cobrança e escreve o plano" (ele mesmo ativou o faturamento; o projeto Google "Rodrigo-AI" está no Nível 1); "pode pegar a mais barata das 4" (modelo `gemini-3.8-flash-lite-tts`); "nivel 1" (fica no Nível 1: 10 pedidos/min e 100/dia por modelo, em vez de pagar US$ 100 pelo Nível 2); "kimi" (auditor da rodada 2 do plano); "sem atalho" (plano completo, não protótipo); "pode reiniciar"; "commita e dá push". Decisão que **NÃO** foi dele: a D-b (confirmações que repetem conteúdo ditado vão à voz do Gemini por padrão) ficou na opção 1 por padrão, reversível por `RODRIGO_TTS_DICTATED=0`.

O que foi feito: ver o relatório. Resumo das peças: `synthesize` no worker em pool próprio de 2 threads daemon (a fila de tamanho 1 do `work_loop` descartaria o pedido e a geração ocupa o laço); orçamento 8/min e 90/dia com reserva real por turno e dia em America/Los_Angeles; provedor com disjuntor e fallback `say` na hora; emissão das frases **em ordem estrita** (o cliente toca o que chega); coalescência (1ª frase sozinha, depois grupos de até 3 frases/300 caracteres/1,5 s); só o texto da frase vai ao Google (os modelos 3.8 leem uma instrução de estilo em voz alta e rejeitam `system_instruction`); normalização de volume para −17 dBFS; canal `RODRIGO_CLOUD_TTS` efetivo só com `RODRIGO_SEND_HISTORY=1`; linha de estado na tela (`GET /api/voice/tts-status`).

**Defeito antigo descoberto e corrigido** no teste de ponta a ponta: o `gemini-flash-latest` passou a "pensar" e o raciocínio conta no teto de saída; com teto 160, ~150 tokens iam ao raciocínio e a fala saía cortada no meio da palavra. `thinking_budget=0` sozinho **não** resolveu com o prompt real do app (medido); o teto da geração em nuvem subiu para 512. Detalhes e a tabela de medições em `docs/implementation-phase-13a.md` §3.

**Pendências da 13a (por ordem):**
1. **O usuário ouvir** e dizer se deixou de soar robotizada (H13a.10, só ele mede) e se alguma resposta ainda sai cortada.
2. ~~Auditoria do código~~ **feita em 2026-10-08** pelo Kimi K3 (o Hermes falhou: cota anônima da Nous esgotada, "allowance for chatting without signing in"). Correções com prova de mutação em `fe7736e`; o achado 4 (WAV órfão) foi corrigido **sem teste dedicado**.
3. Critérios não executados: bateria de 100 turnos simulados (H13a.1), 30 turnos reais com orçamento injetado (H13a.6), transcrição com Whisper de 20 frases (H13a.4), medição de perda de histórico no barge-in (H13a.11), captura do 429 diário (H13a.12, esgota a cota do dia), matriz de privacidade completa (H13a.14).
4. **Latência**: do fim da fala ao primeiro áudio medi ~7,4 s no app completo (STT ~0,9 s, classificação ~1 s, primeiro texto do Gemini ~3 s por causa do raciocínio, TTS 1,3–2 s). Não foi atacada. Medição de 2026-10-08 (5 perguntas, máquina ociosa): tempo até o primeiro texto do `gemini-flash-latest` mediana **1,73 s** vs **0,70 s** do `gemini-3.5-flash-lite`; o Jev estimou 0,61 de chance de o usuário notar a perda de inteligência com o lite, então **não** se trocou. Os tempos reais por etapa aparecem agora no log como `[timing] turno=… stt=… intencao_nuvem=… classificacao=… primeira_frase=… primeiro_audio=…` (pedido ao usuário colá-los).
5. Suposições a verificar: horário de virada da cota diária do Google (assumido meia-noite de Los Angeles); se o Google cobra os tokens gerados até um cancelamento; que o preço do `gemini-3.8-flash-lite-tts` sobe de US$ 6 para US$ 12 por milhão de tokens em 2027-01-01 (lido na página oficial de preços em 2026-10-07).

## 6b. Sessão de 2026-10-08 (tarde/noite) — o que foi feito, em ordem

Todos os commits abaixo estão em `main` e **ainda não foram empurrados** ao GitHub (contagem à frente de `origin/main` no §2). Não fazer push sem o usuário pedir. A pasta `.openclaw-cli-images/` (prints que o usuário mandou pelo OpenClaw) não é código: ignorar.
- `af05e1e` log `[timing]` por etapa (trivial, sem mudança de comportamento).
- `fe7736e` correções da auditoria de código da 13a (cancelamento de síntese enfileirada, cota só depois da vaga, virada do dia, WAV órfão, 2 testes vácuos).
- `e9ef641` fim de fala aos 1,0 s. Motivo: no teste de voz real do usuário uma pergunta ("para quem Pedro escreveu suas duas cartas…") virou 3 turnos nas pausas e o fragmento curto saiu como lixo do Whisper ("Initially Nas Parad filling"). Medido: `whisper-large-v3-turbo` 0,44 s vs `whisper-small` 0,17 s por fala, qualidade igual em áudio limpo — não trocado.
- `3ef5d64`, `f2170e0`, `07fee73` planos da **Fase V (visão da tela)** v1 (Codex: REFAZER, 17 achados, 1 crítico), v2, v3 (agy: APROVAR COM AJUSTES; 6 ajustes incorporados no §10). Codex sem cota na rodada 2; Kimi degenerou; DeepSeek deu erro de servidor.
- `589322d` **fatia 1**: o cancelamento de turno alcança comandos AINDA NA FILA do worker (`_cancelled_turns`); corrige defeito pré-existente em que geração/intenção de turno cancelado ainda chamava o Gemini.
- `a82922a` painel corrigido: o cartão dizia "Ferramentas e Ações — Indisponível", "sem especialistas ainda" e que a voz era sintetizada no computador (falso desde a 13a). Nova frase proibida no teste de privacidade.
- `2404d61` + `a1f12ab` **fatia 2**: turno de tela reconhecido (só quando a fala cita a tela), proveniência decidida antes do histórico, rótulo `TELA`, frase fixa (ainda sem visão), mensagens `origin: 'screen'` nunca saem ao Gemini (`windowHistory`). Auditoria de código Kimi K3: 4 achados, todos corrigidos (inclui defeito pré-existente: com histórico desligado e `/played` atrasado, ia a resposta antiga no lugar da pergunta).

**Decisões do usuário nesta sessão (literais, AskUserQuestion):** pausa → "1,0 s (Recomendado)"; visão → "Os dois, com escolha por voz" (padrão local; Gemini só com frase explícita); voz das respostas de tela → "Voz do Gemini mesmo" (o TEXTO da resposta vai ao TTS do Google; a imagem não); gatilho → "Só quando eu disser (Recomendado)"; prioridade → "1. visão de tela 2. consulta de notas por voz 3. falar com openclaw".

**Medições da visão local** (spike fora do app): `Qwen3-VL-4B-Instruct-4bit` 3,3 s aquecido, pico 4,0 GB, leu certo um print real de erro do npm, não diagnosticou a causa; `Qwen2.5-VL-3B` 3,7 s e não respeitou o limite de frases. Gemini com imagem **não medido** (exigiria mandar captura).

**Próximo passo (fatia 3):** botão "Compartilhar tela" (`getDisplayMedia`), `screen_request`/`captureId` de uso único, rota `POST .../screen` que autentica e consome ANTES de gravar, JPEG ≤ 3 MiB validado, limpeza em todas as saídas. Depois: fatia 4 (visão local no worker, `mlx-vlm` com revisão fixada no setup, carga/descarga, prazo de 90 s), fatia 5 (Gemini por autorização + `RODRIGO_CLOUD_VISION` + cartão). Critérios HV.1–HV.14 em `docs/phase-vision-v3.md` §7 e §10.

## 6c. Sessão de 2026-10-09 — o que foi feito, em ordem (e o que está quebrado agora)

Commits novos em `main` desde o §6b (`git rev-list --count origin/main..HEAD` no §2 mostra quantos ainda não foram empurrados):
- `ac09d4f`, `6e19437` NotebookLM do projeto atualizado (24 fontes do commit `6e19437`; README da pasta documenta a armadilha do `/tmp` symlink).
- `ce48a79` **Fase V, fatia 3**: botão "Compartilhar tela" (`getDisplayMedia`) + protocolo de captura de uso único (HV.3, HV.4).
- `99e6fbc` **fatia 3 — correções da auditoria de código** (Kimi K3, 5 achados, todos procedentes).
- `4351778` **`docs/roadmap-2026-10-09.md` criado** — substitui o §7 do `docs/prompt-proxima-sessao-2026-10-02.md` como referência de objetivo e ordem das fases (o protocolo de trabalho em si, §6 daquele documento, continua valendo, inclusive o circuit breaker de 3+2 ciclos de auditoria). Ordem confirmada: V → F13 (resto, paralelo) → F14 → F15 → F16 → F17.
- `307f695` roteiro passa a registrar a cadência de teste do usuário (tudo no final da fase, não fase a fase).

**Planejamento de F14/F15/F16 (ver `docs/audits/phase-14-plan-audit-r1.md`, `phase-15-plan-audit-r1.md`, `phase-16-plan-audit-r1.md` e a fonte 15 deste notebook):**
- **F14**: plano v1 → auditoria r1 → **APROVADO COM AJUSTES** → v2 (`docs/phase-14-v2.md`) incorpora os ajustes. Implementação já começou: `git status` (§2) mostra `mutatingTools.ts`, `privacy.ts`, `specialistAgents.ts`, `corpus.ts`, `worker.py`, `mlxWorkerEngine.ts`, `sessionManager.ts`, `types.ts`, `voiceProtocol.ts` modificados, mais o teste `src/backend/tools/__tests__/phase14.test.ts`. **Nada disso está commitado, e o `tsc` do servidor NÃO COMPILA agora** (§4: 177 erros, todos em `sessionManager.ts`, a partir da linha 591 — sintaxe quebrada, não lógica). Antes de continuar ou de confiar em qualquer medição desta fase, esse arquivo precisa ser consertado.
- **F15**: plano v1 → auditoria r1 → **REFAZER** (achado principal: a camada de "leitura autônoma" incluía busca na web sem classificar como saída de dado pra nuvem — viola a política de privacidade; precisa separar Leitura Local Autônoma de Leitura Externa sob Aprovação). v2 (`docs/phase-15-v2.md`, 111 linhas) foi escrito e **se autodeclara** "Estado: Aprovado para implementação" — quem gerou esta fonte não achou o arquivo de auditoria da rodada 2 que confirme isso de forma independente; tratar como pendente até achar esse relatório ou rodar a auditoria. Arquivos novos não commitados: `src/backend/agents/subAgent.ts` (interface `ISubAgent`), `adapters.ts`, `openClawSubAgent.ts` (a ponte com o OpenClaw), teste `src/backend/__tests__/phase15.test.ts` (77 linhas).
- **F16**: mesmo padrão da F15 — v1 REFAZER (`docs/audits/phase-16-plan-audit-r1.md`), v2 (`docs/phase-16-v2.md`) autodeclarado aprovado, sem auditoria r2 encontrada. Teste `src/backend/__tests__/phase16.test.ts` existe mas é só um esqueleto (24 linhas, contra 77 do da F15) — a F16 está visivelmente menos adiantada que a F15.

**Decisões do usuário nesta sessão (literais, AskUserQuestion, 2026-10-09):**
- Visão de "secretário completo": Drive, agenda, pesquisa web ampla, novas bases de conhecimento, acesso a sites, compras com aprovação final do usuário — "eu quero que ele realmente seja um secretário, um agente que automatize tudo".
- Ordem: "Mantém a ordem de ontem primeiro (Recomendado)" — a prioridade de 2026-10-08 NÃO foi substituída; Drive/Agenda/pesquisa ampla/compras entram DEPOIS, como fases candidatas **F18** (integrações Google) e **F19** (assistente de compras), sem furar a fila V→F14→F15→F16→F17.
- Compras: "Mantém a regra, mas com carrinho pronto (Recomendado)" — o app pode pesquisar, comparar e montar carrinho/link; quem aperta o botão final de pagamento é sempre o usuário, nunca o app. A regra dura de "nenhuma ação financeira fora de escopo" (`docs/prompt-proxima-sessao-2026-10-02.md` §1.4) não foi reaberta, só esclarecida.
- Esclarecimento: "Ele precisa ser também o agente coordenador inteligente de todos os outros sub agentes" — **não é item novo**, é a própria F15 (coordenador único com interface `ISubAgent`: os 3 especialistas internos, as ferramentas mutantes, agentes externos via OpenClaw e, mais adiante, Drive/Agenda/pesquisa/compras — todos atrás da mesma interface, com orçamento e cancelamento cooperativo próprios).

**Duas pendências de processo, não só de código:**
1. O protocolo do projeto (§7) exige auditoria adversarial do plano antes de implementar. F14 tem essa auditoria documentada (r1, aprovado com ajustes). F15 e F16 só têm a auditoria do v1 (REFAZER); o v2 de ambas se autodeclara aprovado sem um relatório de rodada 2 que este gerador tenha encontrado. Confirmar com o usuário onde (ou se) essa auditoria aconteceu antes de tratar `subAgent.ts`/`adapters.ts`/`openClawSubAgent.ts` como implementação autorizada.
2. O build do servidor não compila agora (ver §4 e a linha de F14 acima). Isso bloqueia `npm test`, `npm run build` e `npm start` até ser corrigido.

## 7. Como se trabalha neste projeto (regras do usuário)

Fluxo obrigatório para mudança não trivial: escrever `docs/phase-N-vX.md` → **auditoria adversarial do plano** (outro modelo, sempre só-leitura; ver skill `auditoria-plano-codex`) → implementar só sem achados altos pendentes → verificar contra a realidade (testes + app real) → **auditoria do código** → registrar relatório de implementação → só então "pronto". Aprovação para implementar não é "pronto". Registrar CLI **e modelo** de cada auditor; a rotação é por modelo (a partir da 3ª rodada troca-se de auditor); um auditor que viu tudo não fecha o plano.

Delegação para economizar a assinatura Claude (pedido do usuário): trabalho bruto vai primeiro ao Hermes (`docker exec hermes hermes -z "<tarefa>"`, gratuito, 1M de contexto, ferramentas de arquivo, mas **só enxerga `~/hermes-workspace` e pode afirmar ter escrito arquivo que não escreveu**), depois a modelos gratuitos via `opencode run -m <provedor>/<modelo>` (nvidia kimi-k3/deepseek, google-aistudio gemini-flash). **Nunca aceitar a autodeclaração de subagente: abrir o artefato e conferir.** Saída de subagente é rascunho, não produto.

Auditor Kimi K3 (`deepseek -m moonshotai/kimi-k3`): sem acesso a arquivos; entrada acima de ~20 KB já deu timeout/degenerou; 2ª tentativa enxuta funcionou. Codex é o mais caro ("full text no codex vai gastar muito"): não mandar arquivos inteiros. `agy` precisa de `--mode plan` (somente leitura) e `--print-timeout 40m`; trata o estouro do timeout como sucesso com exit 0, então conferir o conteúdo.

Honestidade de relatório (regra do usuário): se um teste falha, dizer; se um passo foi pulado, dizer; **nunca baixar um alvo de aceite para passar** (a F11 foi fechada como dívida registrada exatamente por isso). Documento de passagem de bastão deve ter estado de entrega preenchido por comando (branch, não comitado, à frente de origin).

Material pessoal: `docs/research/` e o `.env` nunca vão a terceiros nem a auditores; ao mandar código para um auditor, copiar só o código.

## 8. O que ainda precisa de decisão do usuário

- D-b (§6): manter a voz do Gemini nas confirmações que repetem o que ele ditou, ou deixá-las na voz do sistema.
- Ouvir a voz nova (H13a.10) e colar as linhas `[timing]`.
- **Build quebrado**: `sessionManager.ts` não compila (ver §4, §6c) — provavelmente precisa de conserto antes de qualquer outra coisa.
- **F15/F16**: confirmar se a auditoria da rodada 2 dos planos v2 (ambos autodeclarados "Aprovado para implementação") de fato aconteceu, ou se falta rodá-la antes de confiar na implementação já começada (`subAgent.ts` etc.) — ver §6c.
- **Trabalho não commitado** (9 arquivos modificados + ~16 novos, entre F14/F15/F16): decidir quando commitar, mesmo em passos intermediários, para não arriscar perder.
- Se vale pagar o Nível 2 do Google (US$ 100 + 3 dias) para sair do limite de 100 pedidos/dia; ele disse "nivel 1" e achou o custo mensal "caro" (estimativa: ~US$ 5 a 11/mês a 20 min de fala por dia com o modelo escolhido).
- Os 4 arquivos de agente na raiz: apagar ou ignorar no git.
- Dívidas 5b/5c e F11 (alvos de cobertura abertos) e a medição com voz real da F11.

## 9. Mapa das fontes deste notebook

1. Este documento.
2. `CLAUDE.md` e `README.md` do projeto (o `CLAUDE.md` é a descrição densa de arquitetura e restrições, atualizada até a Fase 13a).
3. Memória do agente (decisões do usuário e regras de auditoria).
4. `rodrigo-ai-architecture-digest-2026-09-28` — resumo extenso da arquitetura até a Fase 10 (**anterior à Fase 12/13a; use o `CLAUDE.md` para o estado atual**).
5. Handoffs e prompt de continuação (2026-09-15 a 2026-10-06) — história; o do 2026-10-06 descreve a F11 e o roteiro F12–F17 (**superado pela fonte 7 abaixo para ordem/objetivo de fase a partir de 2026-10-09**).
6. Planos e relatórios de implementação por fase; planos finais; auditorias da 13a; **Fase V (visão da tela) e 13b com auditorias** (fonte 14).
7. **`docs/roadmap-2026-10-09.md` (roteiro oficial vigente) e os planos/auditorias de F14, F15 e F16** (fonte 15) — use esta fonte, não a 5 ou a 6, para a ordem e o objetivo de cada fase a partir daqui.
8. Código: backend de voz, núcleo do backend, worker Python, frontend e shared, scripts e configuração, testes da Fase 13a, testes da Fase V (fonte 28), testes das Fases 14–16 em andamento (fonte 29), lista de todos os testes.

Para o estado de cada decisão, o `CLAUDE.md` e `docs/implementation-phase-13a.md` valem mais que um plano antigo; planos `vN` antigos de uma fase são história (as rodadas de auditoria que os derrubaram estão nos relatórios).
"""
(OUT / "00-LEIA-PRIMEIRO-handoff.md").write_text(handoff, encoding="utf-8")

# ---------------------------------------------------------------- 01..03 documentos centrais
(OUT / "01-CLAUDE-md-do-projeto.md").write_text("# CLAUDE.md do projeto Rodrigo AI (instruções e arquitetura densas; texto até a Fase 13a — o que veio depois está no handoff 00, §6b e §6c, e no roteiro oficial na fonte 15)\n\n" + read("CLAUDE.md"), encoding="utf-8")
(OUT / "02-README-do-projeto.md").write_text("# README do projeto Rodrigo AI\n\n" + read("README.md"), encoding="utf-8")

mem_parts = ["# Memória do agente (notas persistentes de sessões anteriores)\n\nDecisões e regras que o usuário deu ao longo do trabalho. São a memória de projeto mantida pelo agente anterior.\n"]
for f in sorted(MEM.glob("*.md")):
    mem_parts.append(f"\n\n---\n\n## {f.name}\n\n{f.read_text(encoding='utf-8')}")
(OUT / "03-memoria-do-agente.md").write_text("".join(mem_parts), encoding="utf-8")

# ---------------------------------------------------------------- documentos de fase
shutil_copy = lambda src, dst: (OUT / dst).write_text(read(src), encoding="utf-8")
shutil_copy("docs/rodrigo-ai-architecture-digest-2026-09-28.md", "04-resumo-de-arquitetura-2026-09-28.md")
docs_bundle("05-handoffs-e-continuacao.md", "Handoffs e prompt de continuação (história do projeto)",
    "Do mais recente ao mais antigo. O de 2026-10-06 descreve a Fase 11 e o roteiro F12–F17; os anteriores são o histórico das Fases 2 a 5c.",
    ["docs/handoff-2026-10-06.md", "docs/prompt-proxima-sessao-2026-10-02.md", "docs/handoff-2026-09-23b.md", "docs/handoff-2026-09-23.md", "docs/handoff-2026-09-22.md", "docs/handoff-2026-09-15.md", "docs/phase-4-kickoff-prompt.md"])
docs_bundle("06-fase-13a-plano-v3-e-implementacao.md", "Fase 13a — plano v3 e relatório de implementação",
    "O plano v3 (corrigido pelas rodadas de auditoria agy e Kimi K3) e o relatório do que foi implementado, com desvios, medições e o que NÃO foi verificado.",
    ["docs/phase-13a-v3.md", "docs/implementation-phase-13a.md"])
docs_bundle("07-fase-13a-auditorias-e-versoes-anteriores.md", "Fase 13a — auditorias das rodadas 1 e 2 e versões anteriores do plano",
    "Relatórios dos auditores (agy rodada 1: 21 achados; Kimi K3 rodada 2: 13 achados) e as v1/v2 do plano. Útil para entender por que a v3 é como é.",
    ["docs/audits/f13a/plan-r1-agy.md", "docs/audits/f13a/plan-r2-kimi-k3.md", "docs/phase-13a-v1.md", "docs/phase-13a-v2.md"])
docs_bundle("08-fase-12-privacidade.md", "Fase 12 — Privacidade condizente com a promessa", "Plano v2.2 (três rodadas de auditoria).", ["docs/phase-12-v2.md"])
docs_bundle("09-fase-11-e-10a-nuvem.md", "Fases 10a e 11 — geração e intenção em nuvem",
    "Plano da Fase 10a (v3), adendo da intenção em nuvem, relatório da Fase 11 e o roteiro de voz real que só o usuário executa.",
    ["docs/phase-10-v3.md", "docs/phase-11-addendum-cloud-intent.md", "docs/implementation-phase-11.md", "docs/f11-roteiro-voz-real.md", "docs/phase-10-option-typesafe-jev.md"])
docs_bundle("10-relatorios-de-implementacao-fases-1-a-5c.md", "Relatórios de implementação — Fases 1 a 5c",
    "O que foi entregue em cada fase, com as medições reais e as dívidas declaradas.",
    ["docs/implementation-phase-1.md", "docs/implementation-phase-2.md", "docs/implementation-phase-3.md", "docs/implementation-phase-4.md", "docs/implementation-phase-5a.md", "docs/implementation-phase-5b.md", "docs/implementation-phase-5c.md"])
docs_bundle("11-planos-finais-fases-6-a-9.md", "Planos finais — Fases 6 a 9", "Lembretes agendados (6), memória entre sessões (7), edição (8), recorrência (9). Versões v2 (as aprovadas).",
    ["docs/phase-6-v2.md", "docs/phase-7-v2.md", "docs/phase-8-v2.md", "docs/phase-9-v2.md"])
docs_bundle("12-planos-finais-fases-1-a-5c.md", "Planos finais — Fases 1 a 5c", "Última versão de cada plano (as anteriores foram derrubadas pela auditoria; ver os relatórios de implementação).",
    ["docs/phase-1-v1.md", "docs/phase-2-v2.md", "docs/phase-2-v2-addendum.md", "docs/phase-3-v2.md", "docs/phase-4-v2.md", "docs/phase-5a-v5.md", "docs/phase-5b-v6.md", "docs/phase-5c-v9.md"])
docs_bundle("13-correcoes-e-consultas.md", "Correções de defeitos e consultas de decisão",
    "Correção do 'loop de repetição' do LLM local (que se mostrou em grande parte artefato do harness de teste), consulta ao Codex sobre o fim fixo e correções de revisão.",
    ["docs/fix-generation-repetition-loop-v2.md", "docs/fix-generation-repetition-loop-v1.md", "docs/codex-consulta-fim-fixo-2026-09-29.md", "docs/review-corrections-1.md"])

docs_bundle("14-fase-V-visao-e-13b.md", "Fase V (visão da tela) e Fase 13b — planos e auditorias de 2026-10-08",
    "Plano v3 da visão (vale; §10 prevalece), v2 e v1 com as auditorias que os derrubaram; plano 13b de juntar fragmentos (REPROVADO) e sua auditoria; auditorias de código da 13a e da fatia 2 da visão.",
    ["docs/phase-vision-v3.md", "docs/audits/vision-plan-agy-r2-2026-10-08.md", "docs/phase-vision-v2.md", "docs/audits/vision-plan-codex-r1-2026-10-08.md", "docs/phase-vision-v1.md",
     "docs/phase-13b-v1.md", "docs/audits/f13b-plan-codex-2026-10-08.md", "docs/audits/f13a-code-audit-kimi-k3-2026-10-08.md", "docs/audits/fv2-code-kimi-k3-2026-10-08.md",
     "docs/audits/fv3-code-kimi-k3-2026-10-08.md"])

docs_bundle("15-roteiro-oficial-e-planos-f14-f16.md", "Roteiro oficial vigente (2026-10-09) e planos/auditorias de F14, F15 e F16",
    "`docs/roadmap-2026-10-09.md` substitui o §7 do prompt de continuação como referência de objetivo e ordem das fases; vale até o usuário mudar. F14: v1->v2, auditoria r1 (aprovado com ajustes), implementacao ja comecada (ver handoff §6c). F15 e F16: v1 (REFAZER) e v2 (autodeclarado aprovado — ver handoff §6c sobre a falta de uma auditoria r2 confirmada).",
    ["docs/roadmap-2026-10-09.md",
     "docs/phase-14-v1.md", "docs/phase-14-v2.md", "docs/audits/phase-14-plan-audit-r1.md",
     "docs/phase-15-v1.md", "docs/phase-15-v2.md", "docs/audits/phase-15-plan-audit-r1.md",
     "docs/phase-16-v1.md", "docs/phase-16-v2.md", "docs/audits/phase-16-plan-audit-r1.md"])

# ---------------------------------------------------------------- código
def listing(patterns):
    out = []
    for pat in patterns:
        out += [str(p.relative_to(ROOT)) for p in sorted(ROOT.glob(pat)) if p.is_file()]
    return out

bundle("20-codigo-backend-voz.md", "Código — backend de voz (src/backend/voice)", "Sessão, orquestração, TTS, orçamento, motor do worker, rotas de voz.",
       [f for f in listing(["src/backend/voice/*.ts"])])
bundle("21-codigo-backend-nucleo.md", "Código — núcleo do backend (servidor, privacidade, agentes, ferramentas, conhecimento)", "Tudo de src/backend exceto voz e testes.",
       [f for f in listing(["src/backend/*.ts", "src/backend/routes/*.ts", "src/backend/agents/*.ts", "src/backend/tools/*.ts", "src/backend/knowledge/*.ts", "src/backend/storage/*.ts"]) if "__tests__" not in f])
bundle("22-codigo-worker-python.md", "Código — worker Python (worker.py)", "STT, LLM local, geração/intenção/TTS via Gemini, redação de segredos. 1500+ linhas.",
       ["scripts/worker/worker.py"])
bundle("23-codigo-scripts-worker-e-utilitarios.md", "Código — scripts auxiliares e testes Python do worker", "Síntese Kokoro, setup de voz, benchmark, coordenador de dev e os testes Python.",
       [f for f in listing(["scripts/*.mjs", "scripts/worker/*.py"]) if not f.endswith("worker/worker.py")])
bundle("24-codigo-frontend-e-shared.md", "Código — frontend e tipos compartilhados", "Cliente do navegador (captura, VAD, reprodução, cartão de privacidade) e contratos compartilhados.",
       listing(["src/frontend/*", "src/shared/*.ts", "src/shared/extensions/*.ts"]))
bundle("25-configuracao-do-projeto.md", "Configuração do projeto", "package.json, tsconfigs, Vite, .gitignore e o modelo .env.example (sem segredos).",
       ["package.json", "tsconfig.json", "tsconfig.server.json", "vite.config.ts", ".gitignore", ".env.example"])
bundle("26-testes-da-fase-13a.md", "Testes da Fase 13a (TTS)", "Orçamento, provedor Gemini, sessão (ordem/coalescência), egresso contra o worker real e Gemini falso, privacidade.",
       ["src/backend/__tests__/ttsBudget.test.ts", "src/backend/__tests__/geminiVoiceProvider.test.ts", "src/backend/__tests__/f13Session.test.ts", "src/backend/__tests__/f13EgressTts.test.ts", "src/backend/__tests__/privacy.test.ts", "src/backend/__tests__/helpers/egress.ts", "src/backend/__tests__/f12Fallback.test.ts"])

bundle("28-testes-da-fase-V.md", "Testes da Fase V (visão da tela), fatias 1 e 2", "Cancelamento de comandos na fila do worker (Python) e turno de tela isolado do Gemini (Node).",
       ["src/backend/__tests__/fvScreen.test.ts", "scripts/worker/test_cancel_queue.py"])

bundle("29-testes-das-fases-14-a-16.md", "Testes das Fases 14, 15 e 16 — em andamento, não commitados",
       "F14 tem o teste mais desenvolvido; F15 tem um esqueleto maior (77 linhas) que o da F16 (24 linhas). Nenhuma das tres fases tem implementacao madura ainda, e o build do servidor nao compila agora (ver handoff §4 e §6c) — tratar como rascunho, nao como cobertura validada.",
       ["src/backend/tools/__tests__/phase14.test.ts", "src/backend/__tests__/phase15.test.ts", "src/backend/__tests__/phase16.test.ts"])

# lista de todos os títulos de teste (para o agente saber o que já está coberto)
titles = ["# Lista de todos os testes Node (títulos)\n\nGerada por `grep` nos arquivos `*.test.ts`. Serve para saber o que já está coberto antes de escrever um teste novo.\n"]
for f in sorted((ROOT / "src/backend/__tests__").glob("*.test.ts")):
    t = f.read_text(encoding="utf-8")
    its = re.findall(r"^\s*(?:describe|it)\(\s*[`'\"](.+?)[`'\"]", t, re.M)
    titles.append(f"\n\n## {f.name}\n" + "\n".join(f"- {x}" for x in its))
(OUT / "27-lista-de-testes.md").write_text("".join(titles), encoding="utf-8")

# ---------------------------------------------------------------- verificação de segurança do pacote
bad = []
key = ""
envp = ROOT / ".env"
if envp.exists():
    for l in envp.read_text().splitlines():
        if l.startswith("GEMINI_API_KEY="):
            key = l.split("=", 1)[1].strip().strip("\"'")
tot = 0
for f in sorted(OUT.glob("*")):
    t = f.read_text(encoding="utf-8")
    tot += len(t)
    if key and key in t:
        bad.append((f.name, "chave real"))
    if re.search(r"nvapi-[A-Za-z0-9_\-]{20,}|gsk_[A-Za-z0-9]{20,}", t):
        bad.append((f.name, "chave nvapi/gsk"))
    if "docs/research/teologia-profile-source" in t and "Arquivo: `docs/research" in t:
        bad.append((f.name, "conteudo de docs/research"))
    print(f"{f.name:58s} {len(t)//1024:6d} KB  {len(t.split()):8d} palavras")
print("TOTAL", tot // 1024, "KB;", "ARQUIVOS", len(list(OUT.glob('*'))))
print("ACHADOS DE SEGURANCA:", bad if bad else "nenhum")
sys.exit(1 if bad else 0)
