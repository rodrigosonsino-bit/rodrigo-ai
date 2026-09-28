# Rodrigo AI — Fase 2 (v0.1.0)

Assistente de voz pessoal local, em TypeScript/Node.js (backend/frontend) + Python/MLX (voz).
A Fase 1 estabeleceu a fundação técnica (comunicação frontend/backend em loopback estrito). A Fase 2
adiciona conversa por voz em PT-BR: captura de microfone, detecção de fala (VAD),
transcrição (Whisper local), classificação de intenção e síntese de voz locais.
A partir da Fase 10a, a geração de resposta discursiva usa o Gemini (Google GenAI API via nuvem), mantendo STT, classificação e TTS locais em loopback.

---

## 1. Requisitos do Sistema

- **Node.js**: `>= 20.0.0` (validado e testado no Node v26.5.1).
- **npm**: `>= 10.0.0` (validado e testado no npm 11.17.0).
- **Sistema Operacional**: **macOS testado e validado**. Ambientes Linux e Windows **não foram validados** nesta fase.
- **Rede**: Acesso à internet necessário durante a instalação inicial de dependências (`npm ci`), o download dos modelos de voz (`npm run setup:voice`) e, a partir da Fase 10a, para a geração de respostas discursivas via API do Gemini (`GEMINI_API_KEY`). Captura de áudio, STT, classificação de intenções, ferramentas, memória e TTS continuam operando localmente em loopback.
- **Voz (Fase 2)**: `uv` instalado (https://docs.astral.sh/uv/) e `ffmpeg` no PATH. Hardware validado: MacBook Air Apple M5, 16 GB de RAM unificada — outras configurações Apple Silicon devem funcionar, mas não foram medidas.

---

## 2. Instalação e Lockfile

A instalação é determinística e reproduzível utilizando o lockfile (`package-lock.json`):

```bash
npm ci
```

### Voz local (Fase 2) — setup único

```bash
npm run setup:voice
```

Cria um venv Python isolado em `.runtime/.venv` (nunca usa o Python de sistema), baixa os modelos
`mlx-community/Qwen3-4B-Instruct-2507-4bit` (LLM) e `mlx-community/whisper-small-mlx` (STT) do
Hugging Face para `.runtime/hf-cache` (teto de 8 GiB verificado **antes** de baixar qualquer byte —
aborta sem baixar nada se o tamanho projetado exceder o limite), e grava um manifesto em
`.runtime/models-manifest.json` com as revisões e tamanhos resolvidos. Depois desse passo único, STT e classificação rodam inteiramente offline (`HF_HUB_OFFLINE=1` é forçado em operação normal), enquanto a geração de respostas utiliza a API do Gemini via nuvem (Fase 10a).

Se `npm run setup:voice` não tiver rodado (ou `.runtime` for removido), as rotas `/api/voice/*`
respondem `503` com uma mensagem PT-BR explicando o que falta — o resto da aplicação (Fase 1)
continua funcionando normalmente, sem depender de Python.

---

## 3. Configuração de Ambiente

A aplicação valida rigorosamente os parâmetros de ambiente antes de vincular portas ou criar processos.

É possível configurar via arquivo `.env` na raiz do projeto ou por variáveis exportadas no terminal (`export PORT=...`). O arquivo `.env.example` traz o modelo de referência:

```bash
# Copiar o arquivo de exemplo
cp .env.example .env
```

### Variáveis Disponíveis:

| Variável | Padrão | Descrição e Validação |
|---|---|---|
| `PORT` | `3000` | Porta do servidor backend HTTP. Deve ser um número inteiro positivo entre 1 e 65535. Textos (ex.: `3000abc`), números decimais (ex.: `3.5`) e `0` são rejeitados com erro imediato. |
| `CLIENT_PORT` | `5173` | Porta do servidor de desenvolvimento do frontend (Vite). Deve ser um número inteiro positivo entre 1 e 65535 e **obrigatoriamente diferente** de `PORT`. |
| `HOST` | `127.0.0.1` | Endereço de loopback. Aceita estritamente `127.0.0.1` ou `localhost`. Endereços externos (`0.0.0.0`, redes locais ou domínios de internet) são rejeitados na inicialização. |
| `TTS_ENGINE` | `say` | Motor de síntese de voz (Fase 2). `say` = `/usr/bin/say` (macOS, ~0,5s de latência — voz definida por `SAY_VOICE`). `kokoro` = Kokoro-82M via `~/.venvs/tts-say` (~1,2s) — se indisponível, cai para `say` automaticamente com aviso. |
| `SAY_VOICE` | `Felipe (Enhanced)` | Voz usada quando `TTS_ENGINE=say`. Qualquer voz instalada em Ajustes do Sistema > Acessibilidade > Conteúdo Falado (liste com `say -v '?'`). Vozes "(Enhanced)"/"(Aprimorada)" soam bem melhor que a compacta com a mesma latência — escolhida pelo usuário em 2026-09-14 comparando com a voz compacta e com Kokoro. |

### Proteção Estrita de Host (Loopback Only):
Tanto no backend quanto no servidor de desenvolvimento Vite, qualquer requisição contendo cabeçalho `Host` não autorizado (como `localhost.evil`, `evil.localhost`, `192.0.2.1` ou portas divergentes) é imediatamente rejeitada com o código HTTP `403 Forbidden`. As rotas `/api/voice/*` também validam `Origin` same-origin e exigem um token por sessão (headers `X-Rodrigo-Session`/`X-Rodrigo-Token`, nunca logados).

---

## 4. Comandos de Operação

### Desenvolvimento Local (`npm run dev`)
Inicia o ecossistema integrado de desenvolvimento:
- Compila o código TypeScript do backend.
- Inicia a API local (`http://127.0.0.1:3000`).
- Inicia o servidor Vite com proxy para a API (`http://127.0.0.1:5173`).
- **Encerramento Limpo**: Intercepta `SIGINT` (Ctrl+C) e `SIGTERM`, garantindo que ambos os processos (backend e Vite) sejam finalizados sem deixar processos órfãos ocupando portas.

```bash
npm run dev
```

### Verificação de Tipagem (`npm run typecheck`)
Valida as tipagens estáticas tanto do frontend quanto do backend:

```bash
npm run typecheck
```

### Testes Automatizados (`npm test`)
Executa a suíte de testes de integração e unidade via `node:test` — **nunca depende de Python/MLX
estarem instalados** (usa um motor de voz fake determinístico):
- Validação estrita de configuração e portas.
- Rejeição de cabeçalhos de Host maliciosos (`localhost.evil`, `evil.localhost`, etc.).
- Verificação de saúde em `GET /api/health` com campos mínimos e sem exposição de segredos.
- Rotas 404 de API retornando exclusivamente JSON (nunca HTML).
- Liberação limpa de portas em encerramentos via `SIGTERM`.
- Pontos de extensão modulares com registros vazios para a Fase 1.
- **Fase 2**: sessão de voz e preempção síncrona (sem bloqueio de 10min), cancelamento cooperativo
  de turno, `turnId`/histórico confirmado por reprodução, limites de payload (áudio 2MB/20s, WAV
  malformado), Origin/Host/token.

```bash
npm test
```

### Benchmark de Latência de Voz (`npm run bench:voice`)
Mede a latência ponta-a-ponta real (fim da fala → primeiro áudio) com 10 perguntas PT-BR sintetizadas
via `say` como entrada de teste — **requer o servidor rodando** (`npm start` ou `npm run dev`) com a
voz já configurada (`npm run setup:voice`). Metas do plano: mediana ≤4s, p95 ≤8s.

```bash
npm run bench:voice
```

### Compilação de Produção (`npm run build`)
Compila o backend (`dist/server/`) via `tsc` e gera o pacote otimizado do frontend (`dist/client/`) via `vite build`:

```bash
npm run build
```

### Execução em Produção (`npm start`)
Inicia o servidor Node.js único servindo o frontend estático e as rotas de API **na mesma origem**:

```bash
npm start
```
Acesse a aplicação no navegador em: `http://127.0.0.1:3000`.

---

## 5. Arquitetura do Código

O projeto está organizado com fronteiras modulares bem definidas:

```
rodrigo-ai/
├── src/
│   ├── backend/
│   │   ├── config.ts             # Validação estrita de portas e variáveis
│   │   ├── hostValidator.ts      # Validador de cabeçalho Host
│   │   ├── routes/health.ts      # Rota GET /api/health
│   │   ├── server.ts             # Roteamento (health, voz, estáticos)
│   │   ├── index.ts              # Ponto de entrada — inicializa voz e coordena shutdown
│   │   └── voice/                # Fase 2: sessão, worker MLX, TTS, protocolo HTTP/SSE
│   │       ├── engine.ts             # Interface VoiceEngine (LLM+STT)
│   │       ├── mlxWorkerEngine.ts    # Implementação real: worker Python via NDJSON
│   │       ├── fakeEngine.ts         # Implementação determinística p/ testes
│   │       ├── ttsProviders.ts       # SayVoiceProvider / KokoroVoiceProvider
│   │       ├── sessionManager.ts     # Sessão única, preempção, cancelamento, histórico
│   │       ├── audioStore.ts         # Arquivos temporários de áudio por sessão
│   │       ├── wav.ts                # Parser/validador de cabeçalho WAV
│   │       ├── routes.ts             # REST + SSE de /api/voice/*
│   │       └── voiceRuntime.ts       # Monta o runtime de voz, ou diagnostica sua ausência
│   ├── frontend/
│   │   ├── index.html            # Marcação semântica e acessível
│   │   ├── main.ts                # Conexão com a API + wiring da UI de voz
│   │   ├── voice.ts                # Captura de mic, VAD, playback, cliente SSE
│   │   ├── vad-processor.js        # AudioWorklet: mede energia RMS do áudio
│   │   └── style.css               # Estilos sem CDNs, contraste legível, foco visível
│   └── shared/
│       ├── types.ts               # Contratos de dados estritos (Fase 1)
│       ├── voiceProtocol.ts        # Contratos do protocolo de voz (Fase 2)
│       └── extensions/             # Interfaces para voz, agentes e ferramentas
├── scripts/
│   ├── dev.mjs                    # Coordenador de desenvolvimento sem órfãos
│   ├── setup-voice.mjs             # Cria venv + baixa modelos (teto de 8 GiB)
│   ├── bench-voice.mjs             # Benchmark de latência ponta-a-ponta
│   └── worker/
│       ├── worker.py                # Worker persistente MLX LM + MLX Whisper
│       ├── kokoro_synth.py          # Síntese Kokoro dedicada (nunca toca áudio)
│       ├── setup_models.py          # Download de modelos com teto de tamanho
│       └── requirements.in          # Dependências Python (mlx-lm, mlx-whisper)
├── docs/                          # Planos de fase, auditorias, relatórios de aceite
├── .runtime/                      # Gerado por setup:voice — venv, cache HF, temp (git-ignored)
├── dist/                          # Saídas compiladas (geradas no build)
├── package.json
├── package-lock.json
├── tsconfig.json                  # Configuração TypeScript do frontend
└── tsconfig.server.json           # Configuração TypeScript do backend
```

---

## 6. Transparência de Recursos e Custos

- **Custos de API e inferência**: STT (Whisper), classificação de intenção (Qwen3) e TTS rodam 100% localmente sem custo de API. A partir da Fase 10a, a geração de resposta discursiva consome a API do Gemini (Google GenAI), sujeita a cotas e custos por chamada do provedor conforme o uso.
- **Hardware e Energia**: a aplicação opera localmente para STT, classificação e áudio, demandando processamento e energia da máquina hospedeira. Voz validada em MacBook Air Apple M5 (16 GB); benchmark real em `docs/audits/voice-benchmark-latest.json` após `npm run bench:voice`.
- **Qualidade de voz e modelos**: o STT e o classificador utilizam modelos locais leves para garantir baixa latência e operação loopback, enquanto a geração textual foi migrada para o Gemini na Fase 10a após decisão explícita e auditoria adversarial (docs/phase-10-v3.md). A síntese de voz (`say` ou Kokoro) roda localmente.
- **Roteiro e Fases**:
  - **Fase 3**: Orquestrador (roteamento entre especialistas);
  - **Fase 4**: Primeiros especialistas;
  - **Fase 10a**: Provedor de geração em nuvem (Gemini) — implementado conforme plano auditado.
