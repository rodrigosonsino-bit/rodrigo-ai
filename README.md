# Rodrigo AI — Fase 2 (v0.1.0)

Assistente de voz pessoal local, em TypeScript/Node.js (backend/frontend) + Python/MLX (voz).
A Fase 1 estabeleceu a fundação técnica (comunicação frontend/backend em loopback estrito). A Fase 2
adiciona conversa por voz em PT-BR: captura de microfone, detecção de fala (VAD),
transcrição (Whisper local) e síntese de voz locais.
A partir da Fase 10a, a geração de resposta discursiva usa o Gemini (Google GenAI API via nuvem); a partir da Fase 11, o texto de falas sobre hora, data, lembretes e notas também vai ao Gemini para classificar a intenção. A partir da Fase 13a, a voz das respostas também vem do TTS do Gemini: o **texto de cada frase falada** vai ao Google para virar áudio (o seu áudio nunca vai). O áudio do microfone, a transcrição (STT), as notas, os lembretes e as memórias ficam neste computador. A seção 7 descreve exatamente o que sai e como controlar.

---

## 1. Requisitos do Sistema

- **Node.js**: `>= 20.0.0` (validado e testado no Node v26.5.1).
- **npm**: `>= 10.0.0` (validado e testado no npm 11.17.0).
- **Sistema Operacional**: **macOS testado e validado**. Ambientes Linux e Windows **não foram validados** nesta fase.
- **Rede**: Acesso à internet necessário durante a instalação inicial de dependências (`npm ci`), o download dos modelos de voz (`npm run setup:voice`) e, a partir da Fase 10a, para a geração de respostas discursivas via API do Gemini (`GEMINI_API_KEY`). Captura de áudio, STT, ferramentas e armazenamento de memória operam neste computador; a voz das respostas usa o TTS do Gemini (com a voz do sistema como reserva). O que vai ao Gemini está na seção 7.
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
`.runtime/models-manifest.json` com as revisões e tamanhos resolvidos. Depois desse passo único, o STT e o classificador local não baixam nada da internet (`HF_HUB_OFFLINE=1` é forçado em operação normal); a geração de respostas e a classificação de intenção de pedidos de ferramenta usam a API do Gemini via nuvem (Fases 10a e 11).

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
| `TTS_ENGINE` | `gemini` | Voz das respostas (Fase 13a + TTS-OSS). `gemini` = TTS do Gemini (modelo `RODRIGO_TTS_MODEL`, voz `RODRIGO_TTS_VOICE`) com a voz do sistema como reserva: usada na hora quando o Gemini falha, a cota acaba ou o canal está desligado. `say` = só `/usr/bin/say` (macOS, ~0,5s). `kokoro` = Kokoro-82M via `~/.venvs/tts-say` (~1,2s). `voxcpm` = VoxCPM2 local via servidor MLX em `RODRIGO_VOXCPM_URL` (padrão `http://127.0.0.1:5077`; só loopback) — se o servidor falhar, cai para `say`. O Gemini só é usado com chave, com `RODRIGO_CLOUD_TTS=1` e com `RODRIGO_SEND_HISTORY=1`; senão o app avisa e usa o `say`. |
| `RODRIGO_VOXCPM_URL` / `_CONTROL` / `_STEPS` | `http://127.0.0.1:5077` / prompt PT-BR / `7` | TTS-OSS. URL do `tts-server-voxcpm` (obrigatoriamente loopback), prompt de voice-design e passos de inferência. Ver `docs/phase-tts-oss-v1.md`. |
| `SAY_VOICE` | `Felipe (Enhanced)` | Voz usada quando `TTS_ENGINE=say`. Qualquer voz instalada em Ajustes do Sistema > Acessibilidade > Conteúdo Falado (liste com `say -v '?'`). Vozes "(Enhanced)"/"(Aprimorada)" soam bem melhor que a compacta com a mesma latência — escolhida pelo usuário em 2026-09-14 comparando com a voz compacta e com Kokoro. |
| `KOKORO_VOICE` | `pf_dora` | Voz usada quando `TTS_ENGINE=kokoro`: `pf_dora` (feminina), `pm_alex` ou `pm_santa` (masculinas), as 3 vozes pt-BR do Kokoro-82M. Outro valor volta para `pf_dora` com aviso. O Gemini continua disponível: `TTS_ENGINE=gemini` e reiniciar o app. |
| `RODRIGO_CLOUD_TTS` | `1` | Fase 13a. `0` desliga só a voz em nuvem (a geração segue no Gemini). Só vale com `RODRIGO_CLOUD=1` e, por regra conservadora, fica **desligado** com `RODRIGO_SEND_HISTORY=0`. |
| `RODRIGO_TTS_DICTATED` | `1` | Fase 13a (decisão D-b). `0` mantém na voz do sistema as confirmações que repetem o que você ditou (prévia de nota, lembrete, memória). Também ficam na voz do sistema com `RODRIGO_SEND_MEMORIES=0`. |
| `RODRIGO_TTS_MODEL` / `RODRIGO_TTS_VOICE` | `gemini-3.8-flash-lite-tts` / `Charon` | Modelo e voz do TTS em nuvem. Só letras, números, ponto, hífen e sublinhado. |
| `RODRIGO_TTS_RPM` / `RODRIGO_TTS_RPD` | `8` / `90` | Teto de pedidos por minuto e por dia. A cota do Google no Nível 1 é 10 por minuto e 100 por dia **por modelo**; o app usa uma margem. Esgotado, a voz do sistema assume na hora, sem esperar. Valor inválido impede a inicialização. |
| `RODRIGO_DESKTOP_CONTROL` | `1` | Controle nativo de volume, apps allowlist, pastas e mídia. `0` desliga. Valor inválido impede a inicialização. Requer Acessibilidade/Automação no macOS. |
| `RODRIGO_AUTO_DESKTOP` | `0` | Automação desktop (computer-use): com `1` e `RODRIGO_DESKTOP_CONTROL=1`, objetivos multi-passo na GUI executam sem SIM por passo. Kill switch por voz: "parar automação". Campos de senha e ações críticas (`empty_trash`, bloquear, repouso) ficam fora do loop livre. Texto/AX não saem salvo pelos canais de geração/visão já ligados. Valor inválido impede a inicialização. |

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
│   │       ├── ttsProviders.ts       # SayVoiceProvider / KokoroVoiceProvider / createVoiceProvider (escolha da voz)
│   │       ├── geminiVoiceProvider.ts # Fase 13a: TTS do Gemini com a voz do sistema de reserva
│   │       ├── ttsBudget.ts          # Fase 13a: orçamento de pedidos (minuto/dia, dia em Los Angeles)
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

- **Custos de API e inferência**: o STT (Whisper) roda neste computador, sem custo de API. A partir da Fase 13a, a voz das respostas usa o TTS do Gemini, cobrado por token de áudio gerado (preço oficial lido em 2026-10-07: US$ 6 por milhão de tokens até 31/12/2026 e US$ 12 a partir de 01/01/2027 para o `gemini-3.8-flash-lite-tts`; medido 25 tokens de áudio por segundo de fala, ou seja, ~US$ 0,009 por minuto de fala até o fim do ano e ~US$ 0,018 depois). A partir da Fase 10a, a geração de resposta discursiva (e, desde a Fase 11, a classificação de intenção de pedidos de ferramenta) consome a API do Gemini (Google GenAI), sujeita a cotas e custos por chamada do provedor conforme o uso.
- **Hardware e Energia**: a aplicação processa neste computador o STT, a classificação local e o áudio, demandando processamento e energia da máquina hospedeira. Voz validada em MacBook Air Apple M5 (16 GB); benchmark real em `docs/audits/voice-benchmark-latest.json` após `npm run bench:voice`.
- **Qualidade de voz e modelos**: o STT e o classificador local utilizam modelos leves para garantir baixa latência, enquanto a geração textual foi migrada para o Gemini na Fase 10a após decisão explícita e auditoria adversarial (docs/phase-10-v3.md). A voz das respostas é a do Gemini (Fase 13a, escolhida pelo usuário numa audição às cegas); a voz do sistema (`say`) e o Kokoro rodam localmente e servem de reserva.
- **Roteiro e Fases**:
  - **Fase 3**: Orquestrador (roteamento entre especialistas);
  - **Fase 4**: Primeiros especialistas;
  - **Fase 10a**: Provedor de geração em nuvem (Gemini) — implementado conforme plano auditado.

## 7. Privacidade: o que fica neste computador e o que vai ao Gemini (Fase 12)

**Nunca sai:** o áudio do microfone (a transcrição é feita aqui, pelo Whisper local) e as notas, lembretes e memórias salvos em `data/`. Nenhuma tela ou texto deste projeto deve afirmar o contrário; um teste automatizado falha se reaparecer, em qualquer tela ou documento, uma frase que prometa ausência de nuvem, de custo, de chave ou de tráfego externo. Com `RODRIGO_AUTO_DESKTOP=1`, o Orque controla apps **locais**; a árvore de acessibilidade e o texto lido na tela não vão à nuvem por esse canal — só pelos canais de geração ou visão já configurados.

**Vai ao Gemini (Google), com a geração em nuvem ligada:**

| O quê | Quando | Como desligar |
|---|---|---|
| Texto da conversa recente (as últimas `RODRIGO_HISTORY_TURNS` trocas, 30 por padrão, configurável de 1 a 100): o que você disse e o que o assistente respondeu, **inclusive conteúdo de notas ou memórias repetido na conversa** | em toda resposta gerada | `RODRIGO_SEND_HISTORY=0` (só a fala atual vai) |
| Memórias salvas | junto com cada resposta | `RODRIGO_SEND_MEMORIES=0` |
| Trecho de `docs/research/` (Teologia/Virtologia) | só se ligado; **desligado por padrão** | `RODRIGO_SEND_KNOWLEDGE=1` liga |
| **Imagem da tela** (Fase V) | só se o canal estiver ligado **e** você autorizar na própria fala, naquele pedido; **desligado por padrão** | `RODRIGO_CLOUD_VISION=1` liga; `0` (padrão) mantém a imagem fora do Gemini |
| Texto da fala atual, para entender o pedido (hora, data, lembretes, notas) | falas que parecem esses pedidos | `RODRIGO_CLOUD_INTENT=0` |
| **Texto de cada frase que o assistente vai falar**, para virar áudio (Fase 13a). Só o texto: sem histórico, sem instrução de estilo, sem áudio seu. Inclui frases que você interromper antes de ouvir até o fim | em toda resposta falada com a voz do Gemini | `RODRIGO_CLOUD_TTS=0` (ou `TTS_ENGINE=say`); desligado automaticamente com `RODRIGO_SEND_HISTORY=0` |
| Confirmações que repetem o que você ditou (prévia de lembrete, nota ou memória) | quando a voz do Gemini está ligada | `RODRIGO_TTS_DICTATED=0` ou `RODRIGO_SEND_MEMORIES=0` (ficam na voz do sistema) |

**Modelo de geração e plano B.** A resposta é gerada pelo `gemini-flash-latest` (prazo de 8 s até o primeiro dado). Se ele falhar **antes de qualquer frase ser dita** (erro 5xx de sobrecarga, timeout, 404 ou 429), o app tenta na hora o `gemini-3.5-flash-lite` com **exatamente as mesmas mensagens**, mesmo provedor e mesma conta, sem mudar o que sai da sua máquina. Erros 400/401/403 não tentam de novo (seriam iguais em qualquer modelo), e uma falha **depois** de a resposta já ter começado termina com o que já foi dito, sem recomeçar. A resposta do plano B tende a ser mais simples.

**Voz do Gemini (Fase 13a).** O modelo é o `gemini-3.8-flash-lite-tts`, voz `Charon`. Cada frase vira um pedido; para caber na cota do Google (Nível 1: 10 pedidos por minuto e 100 por dia, por modelo) o app limita-se a 8 por minuto e 90 por dia, agrupa frases de uma mesma resposta (a primeira vai sozinha; as demais em grupos de até 3 frases ou 300 caracteres) e, **esgotada a cota, falha ou desligada a voz em nuvem, a voz do sistema assume na hora**, sem esperar. A tela inicial mostra quantos pedidos do dia já foram usados (`GET /api/voice/tts-status`: só números). Pode haver uma troca de voz no meio de uma resposta longa quando a cota acaba depois de ela já ter começado. O volume é normalizado para o da voz do sistema.

**Atenção ao nível da sua chave do Gemini.** Pelos termos da API (ai.google.dev/gemini-api/terms, atualizados em 28/04/2026, conferidos em 07/10/2026), no **nível gratuito** o Google usa o conteúdo enviado para melhorar seus produtos e **pessoas podem revisá-lo**; no **nível pago**, o Google afirma que não usa os prompts nem as respostas para melhorar produtos. Um projeto sem faturamento configurado no Google AI Studio está no nível gratuito. Tudo o que a tabela acima lista como "vai ao Gemini" (inclusive o texto das frases faladas) fica sujeito ao regime do projeto da sua chave; o painel do AI Studio mostra o nível.

**Guarda de saída (T1).** Antes de o **texto** sair para o Gemini (o prompt de geração com a fala, as memórias e o histórico, e o texto de intenção), o app procura chaves de API, blocos de chave privada, `Bearer <token>`, senha ditada (por exemplo, "a minha senha é Jacaranda2026"), CPF, CNPJ e cartão (com validação por dígito verificador) e age conforme `RODRIGO_OUTBOUND_GUARD`: `redact` (**padrão**) troca cada achado por um marcador com o tipo, como `[cpf omitido]`; `block` não envia nada e avisa por voz; `warn` só conta e envia como está; `off` desliga. Valor diferente desses quatro impede a inicialização. `GET /api/privacy` mostra o modo e os **contadores por tipo**, nunca o conteúdo. **Limites declarados:** o guarda varre texto, **não imagem** (o canal de visão só tem o seu interruptor); mascarar muda o sentido da frase; uma senha ditada toda em minúsculas e só com letras não é reconhecida; e-mail e telefone ainda não são varridos (segunda rodada). A **voz em nuvem (TTS)** também passa pelo guarda: em `redact` o Google recebe o texto mascarado (a voz lê, por exemplo, "cpf omitido"); em `block` a frase inteira é falada pela voz do sistema, neste computador. O **worker Python** também aplica o mesmo guarda (camada em profundidade, `scripts/worker/outbound_guard.py`), caso o Node falhe ou seja contornado, sobre a geração, a intenção, a voz e a pergunta da visão; as duas implementações dão o mesmo resultado nos casos de `src/backend/__tests__/fixtures/outbound-cases.json`.

**Ogra (fase 1, desligada por padrão).** Com `RODRIGO_OGRA=1`, o texto da fala — nunca o áudio — vai ao webhook da Ogra (`GROK_WEBHOOK_URL`). A resposta volta inteira em `POST /api/ogra/reply`, autenticada por `RODRIGO_OGRA_CALLBACK_TOKEN`. Ela pode propor hora, data, lembrete, nota ou memória em `POST /api/ogra/tool`; gravar lembrete, nota ou memória só acontece depois de um SIM falado e ouvido. Desktop, cursor, WhatsApp e envio de mensagens não estão ligados nesta fase. `RODRIGO_OGRA=0` (padrão) deixa a voz como está. Valor diferente de `0` ou `1` impede a inicialização. Se essa ida falhar (limite 429, erro 5xx, outro HTTP que não seja sucesso, prazo, erro de rede ou webhook ausente) e `RODRIGO_OGRA_FALLBACK=1` (padrão), o Ork fala "A Ogra não respondeu, vou seguir por aqui." e o mesmo turno segue o caminho normal — Gemini, ou as ferramentas locais com a nuvem desligada — sem chamar a Ogra de novo. `RODRIGO_OGRA_FALLBACK=0` mantém o aviso de falha e encerra o turno. A Ogra não entra no plano B do Gemini. Nesse caminho de reserva, lembrete, nota e memória continuam pedindo um SIM falado.

**Modo sem nuvem:** `RODRIGO_CLOUD=0` desliga **toda** chamada ao Gemini (geração e intenção). Hora, data, lembretes e notas continuam funcionando; o que exigir uma resposta gerada recebe, por voz, o aviso de que a geração está desligada. Não há fallback para outro provedor. `RODRIGO_OGRA` é um canal à parte: continua desligado no padrão.

**Variáveis só de teste** (não fazem parte do uso normal): `RODRIGO_TEST=1`, `RODRIGO_GEMINI_BASE_URL` (aponta o worker para um Gemini falso em loopback; só vale com `RODRIGO_TEST=1`, só aceita `http://127.0.0.1:<porta>` ou `http://[::1]:<porta>` com porta de 1024 a 65535, usa uma chave sintética e nunca a sua), `RODRIGO_WORKER_NO_MODELS=1` e `RODRIGO_TEST_GEMINI_TIMEOUT_MS`. Fora do modo de teste, `RODRIGO_GEMINI_BASE_URL` é ignorada com um aviso. O worker nunca segue redirecionamentos do Gemini.

Valores aceitos são exatamente `0` ou `1` (um inteiro de 1 a 100 para `RODRIGO_HISTORY_TURNS` e de 1 a 1440 minutos para `RODRIGO_IDLE_TIMEOUT_MINUTES`); qualquer outro valor impede a inicialização. A tela inicial mostra a configuração em vigor (`GET /api/privacy`), que é a configuração declarada, não uma medição do tráfego real.
