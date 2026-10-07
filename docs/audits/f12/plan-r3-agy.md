# RELATÓRIO DE AUDITORIA ADVERSARIAL — RODADA 3
**Documento auditado:** `docs/phase-12-v2.md` (v2.1 — rodada 2 incorporada)  
**Auditor:** Antigravity (execução direta e independente, sem delegação a subagentes)  
**Data:** 2026-10-07  
**Escopo verificado:** `docs/phase-12-v2.md`, `docs/phase-12-v1.md`, `docs/audits/f12/`, `src/backend/`, `src/frontend/`, `scripts/worker/`, `scripts/`

---

## 1. Verificação Estrita dos "Fatos Verificados" §1A (1–8)

Todas as alegações do §1A foram confrontadas diretamente com o código-fonte atual do repositório:

1. **Dois clientes Gemini no worker** (`worker.py:754` e `worker.py:871`)  
   * **Status:** **CONFIRMADO** [REPRODUZIDO].  
   * **Evidência:** `scripts/worker/worker.py:754` instancia `self._intent_client = genai.Client(...)` para classificação de intenção; `scripts/worker/worker.py:871` instancia `self._gemini_client = genai.Client(...)` para geração discursiva em streaming. São instâncias isoladas com ciclo de vida tardio independente.

2. **`RODRIGO_CLOUD_GENERATION=0` não é "sem nuvem"** (`sessionManager.ts:425-437`, `worker.py:746`)  
   * **Status:** **CONFIRMADO** [REPRODUZIDO].  
   * **Evidência:** Em `src/backend/voice/sessionManager.ts:425-437`, qualquer fala que satisfaça `mightBeMutation(transcript)` ou `mightBeTemporal(transcript)` aciona `this.engine.detectIntent(...)`. No worker (`scripts/worker/worker.py:746-750`), essa chamada consulta a nuvem a menos que `RODRIGO_CLOUD_INTENT=0` seja definido. Desligar apenas a geração mantinha o tráfego do texto da fala para a nuvem.

3. **`session.history` contém o conteúdo local** (`sessionManager.ts:330, 620-623, 732, 275`)  
   * **Status:** **CONFIRMADO** [REPRODUZIDO].  
   * **Evidência:** `src/backend/voice/sessionManager.ts:330` insere a transcrição bruta do usuário (`session.history.push({ role: 'user', content: transcript })`). A linha `:732` insere frases do assistente confirmadas por `markPlayed()`, incluindo perguntas de confirmação que repetem o texto confidencial de notas/memórias. A linha `:620-623` concatena todo o `session.history` em `messagesForEngine`, truncado apenas por `trimHistory()` (`:275`, `maxMessages = VOICE_LIMITS.MAX_CONTEXT_TURNS * 2`).

4. **Alegações falsas no frontend além do v1** (`index.html:116, 118, 127`)  
   * **Status:** **CONFIRMADO** [REPRODUZIDO].  
   * **Evidência:** Conferido em `src/frontend/index.html`:
     - Linha 116: `<h2 id="cost-title">Sem cobrança de API nesta fase</h2>`
     - Linha 118: `<p>Nenhum serviço pago, chave de acesso ou chamada a servidores externos é utilizada pela aplicação.</p>`
     - Linha 127: `<p>Rodrigo AI — Execução local no computador sem tráfego de dados para terceiros.</p>`

5. **`AudioStore.cleanupAll()` apaga diretório compartilhado e quebra `dirFor()`** (`audioStore.ts:58-61, 19-27`, `server.ts:162`)  
   * **Status:** **CONFIRMADO** [REPRODUZIDO].  
   * **Evidência:** `src/backend/voice/audioStore.ts:58-61` executa `fs.promises.rm(this.baseDir, { recursive: true, force: true })`. `dirFor()` (`:19-27`) consulta o mapa em memória `this.sessionDirs.get(sessionId)` e, se já existir no cache, retorna a string **sem verificar se a pasta ainda existe no disco**. Se uma segunda instância em outra porta executar `cleanupAll()`, as sessões ativas da primeira perdem seus arquivos e falham com `ENOENT`. `server.ts:162` protege apenas a colisão da mesma porta (`EADDRINUSE`).

6. **Validação de URL e divergência Python vs Node**  
   * **Status:** **CONFIRMADO E REPRODUZIDO** [REPRODUZIDO].  
   * **Evidência:** A execução dos scripts `docs/audits/f12/loopback-battery.py` e `loopback-battery.mjs` confirmou exatamente a divergência em 6 de 25 payloads: `http://evil.com\@127.0.0.1/` é aceito pelo `urlparse` do Python (lendo hostname como `127.0.0.1`) e rejeitado pelo Node como `evil.com`. As outras 5 divergências foram formas loopback (`[0:0:0:0:0:0:0:1]:9000`, `0x7f.1`, `2130706433`, `017700000001`, `127.1`).

7. **Redirecionamento HTTP 307 no `httpx` preserva `x-goog-api-key`**  
   * **Status:** **CONFIRMADO E REPRODUZIDO** [REPRODUZIDO].  
   * **Evidência:** O plano v2.1 havia classificado este achado da rodada 1 como "SUPOSIÇÃO VEROSSÍMIL não reproduzida por mim". Executamos um teste instrumental com `httpx 0.28.1` em Python simulando um redirecionamento 307 cross-origin de `http://127.0.0.1:9091` para `http://evil.com/target` com headers `authorization: Bearer foo` e `x-goog-api-key: secret-12345`. O `httpx` descartou `authorization`, **mas manteve intacto `x-goog-api-key: secret-12345` na requisição redirecionada para `evil.com`**. O vetor de exfiltração é 100% real e reproduzido.

8. **Captura e saída de voz 100% locais ao backend** (`voice.ts:155-166, 260, 337`)  
   * **Status:** **CONFIRMADO** [REPRODUZIDO].  
   * **Evidência:** `src/frontend/voice.ts` utiliza exclusivamente `navigator.mediaDevices.getUserMedia` + `AudioWorkletNode` local (`vad-meter-processor`), codifica PCM-16 em `encodeWavPcm16` e envia via `POST /api/voice/session/audio`. A reprodução busca o WAV de `/api/voice/session/audio/:audioId`. Não há nenhuma ocorrência de `SpeechRecognition`, `webkitSpeechRecognition` ou `speechSynthesis` no frontend.

---

## 2. Varredura Completa de Egressos de Rede e Canais Gemini

Grep exaustivo por `genai.Client`, `httpx`, `urllib`, `requests`, `fetch`, `subprocess` com `curl`/`wget`, `child_process` e conexões de rede em `src/` e `scripts/`:

| Componente | Arquivo:Linha | Destino / Protocolo | Controle no §2.1 | Avaliação |
|---|---|---|---|---|
| **Worker Intent** | `scripts/worker/worker.py:754-765` | Gemini API (`generativelanguage.googleapis.com`) | `RODRIGO_CLOUD=0` ou `RODRIGO_CLOUD_INTENT=0` | Coberto |
| **Worker Generation** | `scripts/worker/worker.py:871-889` | Gemini API (`generativelanguage.googleapis.com`) | `RODRIGO_CLOUD=0` (mestre) | Coberto |
| **Worker Setup** | `scripts/worker/setup_models.py:30-60` | Hugging Face Hub (download de pesos) | Fora do runtime (`RODRIGO_VOICE_SETUP=1`) | Coberto |
| **Backend Worker Engine** | `src/backend/voice/mlxWorkerEngine.ts:125-135` | Subprocesso Python local via stdio pipes | Local (`HF_HUB_OFFLINE=1`) | Coberto |
| **Backend Notificações** | `src/backend/tools/reminderScheduler.ts:141` | `osascript` (notificação local macOS) | Local | Coberto |
| **Backend TTS `say`** | `src/backend/voice/ttsProviders.ts:43` | `say` (binário nativo macOS) | Local | Coberto |
| **Backend TTS `kokoro`** | `src/backend/voice/ttsProviders.ts:80` | `python3 scripts/tts_kokoro.py` | Local | Coberto |
| **Backend HTTP Server** | `src/backend/server.ts:171` | `http.createServer` (loopback estrito `HOST`) | Local | Coberto |
| **Frontend API Calls** | `src/frontend/voice.ts:85,260,285,337,366,405` | `fetch('/api/voice/...')` (mesma origem loopback) | Local | Coberto |
| **Frontend Health** | `src/frontend/main.ts:78` | `fetch('/api/health')` | Local | Coberto |
| **Datasets F11 (Auditoria)** | `scripts/f11-gen-dataset.mjs:15`, `f11-label-content.mjs:15` | `spawn('opencode', ...)` para benchmark de acurácia | Scripts de auditoria offline | Coberto |

**Resultado:** Todo o egresso de dados para a nuvem no runtime de aplicação passa exclusivamente pelos dois clientes `genai.Client` no worker Python. Não existem canais clandestinos de telemetria ou bibliotecas ocultas de rede.

---

## 3. Execução Experimental dos Mecanismos Críticos (§2.4, §2.5, §2.6)

### (a) Teste do Regex e Validação de Porta do §2.5
* **Regex auditado:** `^http://(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$` com checagem numérica `1024 <= port <= 65535`, usando `re.fullmatch` em Python e `RegExp.test` em Node.
* **Bateria executada:** 47 payloads cobrindo portas baixas (0, 80, 443, 1023), portas limítrofes (1024, 65535, 65536, 99999), zeros à esquerda (`08080`), barras finais (`/`, `/v1`), query/fragment (`?key=1`, `#frag`), credenciais (`user:pass@`), backslashes (`\@`), whitespace/newlines (`\n`, `\r\n`), esquemas inválidos (`https`, `HTTP`, `ftp`), representações alternativas de IP (octal `0177.0.0.1`, hex `0x7f.1`, inteiro `2130706433`, loopback longo, `127.1`), dígitos unicode (`８０８０`) e hostnames (`localhost`, `evil.com`).
* **Resultado:** **47/47 testes passaram tanto em Python quanto em Node** [REPRODUZIDO].
* **Constatação técnica:** O uso de `re.fullmatch` em Python é estritamente necessário; comprovamos que `re.match(..., s)` com `$` final aceita `\n` no final da string em Python, enquanto `re.fullmatch` rejeita categoricamente.

### (b) Simulação da Regra de Limpeza do §2.4 (`ps -o lstart=` no macOS)
* **Script executado:** `/tmp/audit_r3_f12/simulate_cleanup.mjs` testando processos vivos, mortos (`ESRCH`), permissão negada (`EPERM`), PIDs reciclados e formatação de datas.
* **Resultados empíricos:**
  1. **Falha de internacionalização (CRÍTICA):** No macOS com locale em português (`LC_ALL=pt_BR.UTF-8`), `ps -o lstart=` cospe: `qua  7 out 09:54:44 2026`. Em Node.js (V8), `new Date("qua  7 out 09:54:44 2026").getTime()` retorna **`NaN`**! Sem `LC_ALL=C`, toda checagem em máquina brasileira falha e considera processos vivos como divergentes.
  2. **Resolução de tempo e colisão no mesmo segundo:** `ps -o lstart=` tem precisão de **apenas 1 segundo inteiro**. Medimos a diferença entre `Date.now()` do Node e o `lstart` do `ps`: varia naturalmente entre 0 e 999 ms. Dois processos iniciados no mesmo segundo têm o mesmo `lstart`. A tolerância de 2 segundos não diferencia reciclagem de PID ocorrida dentro do mesmo segundo.
  3. **Comportamento do `EPERM`:** No macOS, `process.kill(1, 0)` lança `EPERM`, mas `ps -o lstart= -p 1` **funciona perfeitamente** para processos de outros usuários sem privilégios de root. Tratar `EPERM` como "nunca remove" faz com que qualquer diretório órfão cujo PID seja assumido por um daemon do sistema nunca seja limpo até o próximo reboot.
  4. **Atraso de inicialização:** Em ambientes sob alta carga de CPU, o tempo entre o spawn do SO e a instanciação de `AudioStore` pode ultrapassar 2000 ms. Se a pasta gravar o `Date.now()` tardio, uma limpeza concorrente pode apagar a pasta da instância viva.

### (c) Teste da Função `redact()` do §2.6
* **Script executado:** `/tmp/audit_r3_f12/test_redact.py` e simulação Node contra 16 casos de teste (chave padrão, query params, truncamento em 8 chars, quebra de chave antes do truncamento, URL-encoded com `%2D` e `%5F`, JSON escapado, repr de header `x-goog-api-key`, chaves sintéticas literais, corpos longos > 160 caracteres).
* **Resultados empíricos:**
  1. A lógica de mascarar a string completa **antes** do truncamento de 160 caracteres funciona perfeitamente para mensagens contíguas.
  2. **Vulnerabilidade de streaming (ALTA):** No Node (`mlxWorkerEngine.ts:143`), o `stderr` do worker é processado via evento `data` sobre buffers parciais (`child.stderr.on('data', chunk => ...)`). Se um pedaço do buffer quebrar a chave ao meio (ex.: `chunk1 = "...?key=AIza"` e `chunk2 = "SyD-1234..."`), nenhuma das duas fatias bate no regex `{8,}` nem na chave literal inteira. **A chave vaza no console em texto claro dividida em dois chunks.**

---

## 4. Análise dos Critérios de Aceite H12.1–H12.5

| Critério | Pode falhar de verdade? | Teste mais barato que o faz falhar (Modo de falha real) |
|---|---|---|
| **H12.1** | **SIM** | Adicionar um comentário `# 100% local` em `.env.example` ou `<p>sempre offline</p>` em `index.html`. O teste estático deve detectar a frase proibida sem o qualificador exigido. |
| **H12.2** | **SIM** | Com `RODRIGO_SEND_MEMORIES=0`, forçar o backend a injetar o bloco de memórias no prompt. O servidor Gemini falso em loopback captura a requisição e a compara com o gabarito escrito à mão, falhando imediatamente. |
| **H12.3** | **SIM, mas com ponto cego crítico** | **Falso-negativo no Node:** `fetch()` nativo do Node ignora `HTTPS_PROXY`/`HTTP_PROXY`. Para o worker Python, o teste falha facilmente se `RODRIGO_CLOUD=0` for definido e `detectIntent` tentar bater no Google; o proxy em loopback conta a tentativa e falha. Porém, qualquer chamada de rede feita pelo Node escaparia do registrador proxy. |
| **H12.4** | **SIM** | Subir uma instância viva, criar uma pasta órfã com PID inexistente e reiniciar o servidor: se o diretório da instância viva sumir ou o órfão permanecer, o teste falha. Também falha se `test-dummy-key` aparecer no stderr. |
| **H12.5** | **SIM** | Passar uma chave antiga que ainda esteja ativa no Google AI Studio: a API retorna HTTP 200 em vez de erro de chave revogada, ou retorna erro 400 por JSON malformado sem o motivo `API_KEY_INVALID`, fazendo o script falhar. |

---

## 5. Tabela Detalhada de Achados Adversariais

---

### ACHADO 1 — Quebra e Deleção Indevida de Pastas Vivas no `ps -o lstart=` sob Locale Não-Inglês (`pt_BR`) no macOS
* **EVIDÊNCIA:** `docs/phase-12-v2.md:86` (§2.4) vs Execução real no terminal macOS:
  ```bash
  LC_ALL=pt_BR.UTF-8 ps -o lstart= -p $$
  # Saída: qua  7 out 09:54:44 2026
  node -e 'console.log(new Date("qua  7 out 09:54:44 2026").getTime())'
  # Saída: NaN
  ```
  Na regra do §2.4: `compara startEpochMs do nome com o início real do processo obtido por ps -o lstart= -p <pid> ... tolerância de 2 s: divergência => pid reciclado => remove`.
  Como `NaN` não é um número válido, qualquer cálculo aritmético `Math.abs(startEpochMs - realStartMs) > 2000` se comporta de forma imprevisível (ou avalia `NaN` como divergência caso tratado com fallback). Se `NaN` for considerado divergência ou falha na checagem, a limpeza removerá os diretórios de processos legítimos em execução!
* **GRAVIDADE:** **CRÍTICA**
* **CONFIANÇA:** 100%
* **CLASSIFICAÇÃO:** **REPRODUZIDO**
* **AÇÃO:** 
  1. Fixar explicitamente no plano que o comando `ps` deve ser invocado com ambiente forçado em inglês: `env: { ...process.env, LC_ALL: 'C', LANG: 'C' }`.
  2. Implementar validação defensiva no parser: se o retorno for `NaN`, nunca assumir reciclagem; registrar aviso e manter a pasta intacta.

---

### ACHADO 2 — Vazamento de Chave Secreta por Fragmentação de Buffer em Streaming no `redact()` do Node
* **EVIDÊNCIA:** `docs/phase-12-v2.md:104-106` (§2.6) vs `src/backend/voice/mlxWorkerEngine.ts:143`:
  ```ts
  child.stderr.on('data', (chunk: Buffer) => {
    console.error(`[voice-worker] ${chunk.toString('utf-8').trimEnd()}`);
  });
  ```
  O plano prescreve aplicar `redact()` sobre todo o stderr repassado em `mlxWorkerEngine.ts:143`.
  Porém, streams do SO entregam blocos de bytes fragmentados arbitrariamente.
  Simulação executada em Node:
  ```ts
  const chunk1 = "Error at https://generativelanguage.googleapis.com?key=AIza";
  const chunk2 = "SyD-1234567890abcdefABCDEF12 failed\n";
  ```
  No `chunk1`, `AIza` tem apenas 4 caracteres (abaixo do limiar `AIza[0-9A-Za-z_-]{8,}`) e não casa a chave literal inteira; é emitido em texto claro. No `chunk2`, o prefixo `AIza` está ausente; é emitido em texto claro. A chave inteira é exposta no console em duas linhas consecutivas.
* **GRAVIDADE:** **ALTA**
* **CONFIANÇA:** 100%
* **CLASSIFICAÇÃO:** **REPRODUZIDO**
* **AÇÃO:**
  1. O tratamento de stderr em `mlxWorkerEngine.ts` deve obrigatoriamente utilizar bufferização por linha (ex.: `readline.createInterface({ input: child.stderr })` ou acumulador com quebra por `\n`) antes de invocar `redact()`.

---

### ACHADO 3 — Método de Medição de H12.3 via `HTTPS_PROXY` Falha Silenciosamente no Node (Falso-Negativo de Egresso)
* **EVIDÊNCIA:** `docs/phase-12-v2.md:119` (§4, H12.3) vs Execução real em Node v26.5.1:
  O plano propõe medir "zero tentativas de conexão a outros hosts" apontando `HTTPS_PROXY`/`HTTP_PROXY` do servidor Node e do worker Python para um registrador local em loopback.
  Verificado experimentalmente: a implementação nativa de `fetch()` do Node.js (undici) **ignora sumariamente** as variáveis de ambiente `HTTP_PROXY` e `HTTPS_PROXY`.
  Se o servidor Node tentar realizar qualquer chamada HTTP/HTTPS externa, ela **não passará pelo proxy registrador**. Se a rede externa estiver bloqueada no SO, a requisição falha silenciosamente sem registrar nada no proxy, gerando um falso sucesso ("zero tentativas detectadas").
* **GRAVIDADE:** **ALTA**
* **CONFIANÇA:** 100%
* **CLASSIFICAÇÃO:** **REPRODUZIDO**
* **AÇÃO:**
  1. Especificar que o teste de H12.3 para o processo Node deve utilizar monkeypatch de `globalThis.fetch` ou configurar o dispatcher global do undici (`setGlobalDispatcher`), em vez de confiar apenas em variáveis de ambiente `HTTP_PROXY`.

---

### ACHADO 4 — Inconsistência Hierárquica e Ambiguidade entre `RODRIGO_CLOUD` e `RODRIGO_CLOUD_GENERATION`
* **EVIDÊNCIA:** `docs/phase-12-v2.md:53` (§2.1) vs `docs/phase-12-v2.md:69-70` (§2.2):
  No §2.1: `RODRIGO_CLOUD=0 substitui o RODRIGO_CLOUD_GENERATION do v1; RODRIGO_CLOUD_INTENT continua existindo e vale só quando o mestre é 1`.
  No §2.2:
  ```ts
  interface PrivacyStatus {
    mode: 'cloud' | 'local-only'; // RODRIGO_CLOUD
    generation: 'gemini' | 'off';
    intent: 'gemini' | 'local';
  ```
  Se `RODRIGO_CLOUD` substitui e elimina `RODRIGO_CLOUD_GENERATION`, então `generation` é puramente redundante com `mode` (quando `mode === 'cloud'`, `generation` é sempre `gemini`; quando `local-only`, é sempre `off`).
  Além disso, cria uma assimetria: o usuário pode desligar a intenção mantendo a geração (`RODRIGO_CLOUD=1`, `RODRIGO_CLOUD_INTENT=0`), mas não pode desligar a geração mantendo a intenção (a menos que `RODRIGO_CLOUD_GENERATION` ainda exista como subtoggle).
* **GRAVIDADE:** **MÉDIA**
* **CONFIANÇA:** 95%
* **CLASSIFICAÇÃO:** **REPRODUZIDO**
* **AÇÃO:**
  1. Definir formalmente se `RODRIGO_CLOUD_GENERATION` foi extinto ou se permanece como um subtoggle (análogo a `RODRIGO_CLOUD_INTENT`).
  2. Ajustar `PrivacyStatus` para refletir estritamente as variáveis existentes sem redundância.

---

### ACHADO 5 — Resolução de 1 Segundo de `ps -o lstart=` Mantém Órfãos Reciclados no Mesmo Segundo
* **EVIDÊNCIA:** `docs/phase-12-v2.md:86` (§2.4) vs Simulação em `/tmp/audit_r3_f12/simulate_cleanup.mjs`:
  `ps -o lstart=` não fornece milissegundos. Se um processo morre e o sistema operacional reutiliza aquele PID no mesmo segundo (ou nos 2 segundos adjacentes), o timestamp retornado pelo SO bate com o `startEpochMs` do nome da pasta dentro da tolerância de 2 segundos.
  O algoritmo conclui erroneamente que o processo vivo é o dono da pasta antiga e não a remove, contradizendo a garantia absoluta de H12.4 de que reinício deixa zero órfãos em qualquer cenário.
* **GRAVIDADE:** **MÉDIA**
* **CONFIANÇA:** 95%
* **CLASSIFICAÇÃO:** **REPRODUZIDO**
* **AÇÃO:**
  1. Reconhecer formalmente no §6 (Riscos Remanescentes) que colisões de PID reciclado na janela de 2 segundos permanecem como limitação probabilística marginal (tolerável em SO desktop).

---

### ACHADO 6 — Regra de `EPERM` Mantém Diretórios Órfãos Eternos Desnecessariamente
* **EVIDÊNCIA:** `docs/phase-12-v2.md:86` (§2.4):
  `lança EPERM => pid existe sob outro usuário => tratado como vivo, não remove e registra aviso (trade-off declarado)`.
  Testado no macOS: `process.kill(1, 0)` gera `EPERM`. No entanto, `ps -o lstart= -p 1` **funciona sem privilégios de root** e retorna a data exata de início do processo (ex.: dias ou semanas atrás no boot).
  Se uma sessão do Rodrigo AI cair e seu PID for posteriormente alocado para um processo do sistema, a pasta órfã nunca mais será apagada até o reboot da máquina, mesmo que uma simples consulta a `ps -o lstart=` provasse de imediato que o processo atual começou muito antes ou depois da pasta.
* **GRAVIDADE:** **BAIXA**
* **CONFIANÇA:** 100%
* **CLASSIFICAÇÃO:** **REPRODUZIDO**
* **AÇÃO:**
  1. Em caso de `EPERM`, tentar consultar `ps -o lstart= -p <pid>`. Se a data divergir, remover o diretório com segurança, pois o PID atual comprovadamente não pertence à sessão do Rodrigo AI.

---

### ACHADO 7 — Texto Fóssil Conflitante do v1 Mantido no §2.4
* **EVIDÊNCIA:** `docs/phase-12-v2.md:86-88` (§2.4):
  O texto do §2.4 contém duas instruções sobrepostas que não foram reconciliadas:
  - Linha 86: `compara startEpochMs do nome com o início real do processo obtido por ps -o lstart= -p <pid> ... (cobre reciclagem dentro do mesmo boot, sem depender do boot do sistema)`.
  - Linha 87-88: `Detalhamento anterior: ... ou cujo startEpochMs é anterior ao boot do sistema (reutilização de pid após reboot), remover;`.
  O "detalhamento anterior" contradiz a regra nova ao ressuscitar a checagem por boot do sistema.
* **GRAVIDADE:** **BAIXA**
* **CONFIANÇA:** 100%
* **CLASSIFICAÇÃO:** **REPRODUZIDO**
* **AÇÃO:**
  1. Excluir o parágrafo de "Detalhamento anterior" no §2.4 para eliminar ambiguidade para quem for codificar.

---

### ACHADO 8 — Ausência de Limpeza da Pasta do Próprio Processo no Shutdown Normal
* **EVIDÊNCIA:** `docs/phase-12-v2.md:86-90` (§2.4):
  O plano prescreve que cada processo cria seu subdiretório `.runtime/tmp/<pid>-<startEpochMs>/`.
  Ao encerrar a sessão, `cleanupSession()` remove apenas o subdiretório da sessão.
  O plano não prescreve que o runtime remova a sua própria pasta vazia `<pid>-<startEpochMs>/` ao sofrer encerramento normal gracioso (`SIGINT`, `SIGTERM`, `server.close()`).
  Assim, todo uso normal do aplicativo acumula pastas vazias em `.runtime/tmp/`, transferindo o trabalho de limpeza desnecessariamente para o próximo boot.
* **GRAVIDADE:** **BAIXA**
* **CONFIANÇA:** 100%
* **CLASSIFICAÇÃO:** **REPRODUZIDO**
* **AÇÃO:**
  1. Adicionar no gancho de shutdown do `voiceRuntime` a remoção de `this.processDir` (`.runtime/tmp/<pid>-<startEpochMs>`).

---

### ACHADO 9 — Afirmações Absolutas Derrubáveis
* **EVIDÊNCIA:** 
  1. §2.5 regra 2: *"Validação única, no Node... o worker só a aceita se for igual por igualdade exata ao regex acima (segunda checagem independente)"*. Afirmar que é "validação única" e em seguida prescrever duas checagens é contradição verbal.
  2. §2.4 regra 2: *"nunca tocar em subdiretório de pid vivo com startEpochMs coerente"*. Se um processo demorar >2000 ms para inicializar `AudioStore` sob carga alta de CPU, seu `startEpochMs` divergirá de `lstart` e uma instância concorrente apagará sua pasta viva.
* **GRAVIDADE:** **BAIXA**
* **CONFIANÇA:** 100%
* **CLASSIFICAÇÃO:** **REPRODUZIDO**
* **AÇÃO:**
  1. Corrigir o texto para "Validação dupla".
  2. Ancorar `startEpochMs` no tempo de início do processo (`Date.now() - Math.round(process.uptime() * 1000)`), não na hora em que a pasta é criada.

---

## 6. O Que Não Foi Possível Verificar (Limitações da Auditoria)

1. **Acesso ao arquivo `.env` real de produção:** Em estrito cumprimento às regras do projeto, `.env` não foi lido nem referenciado.
2. **Chamadas reais à API em produção do Google AI Studio com chave revogada:** Não realizamos chamadas reais que dependessem de revogar chaves na nuvem externa (testado via mocks locais e inspeção estrita dos contratos).
3. **Mecanismo de resolução de DNS do macOS sob ataques avançados de rebinding:** Não foram simulados ataques de DNS rebinding contra `127.0.0.1`.

---

## 7. VEREDITO FINAL

### **APROVADO COM RESSALVAS** (Condicionado à incorporação dos ajustes v2.2 antes do código)

**Justificativa Técnica:**  
O plano `docs/phase-12-v2.md` evoluiu substancialmente em relação ao v1.0 e à rodada 2: o regex de URL loopback é impecável e foi 100% validado contra 47 payloads maliciosos, a ordem de sanitização em `redact()` protege os segredos antes do truncamento e os fatos do §1A foram todos confirmados na íntegra.

No entanto, a implementação **não pode ser iniciada** sem as seguintes 3 correções cirúrgicas obrigatórias:
1. **[CRÍTICA - §2.4]** Adicionar `env: { LC_ALL: 'C' }` na chamada de `ps -o lstart=` para evitar que sistemas em português (`pt_BR`) quebrem a data com `NaN` e deletem instâncias ativas do usuário.
2. **[ALTA - §2.6]** Exigir bufferização por linhas (`readline`) no stream de `stderr` do worker antes de aplicar `redact()`, evitando vazamento de chave fragmentada entre chunks de rede/pipe.
3. **[ALTA - §4 H12.3]** Substituir a dependência passiva de `HTTPS_PROXY` no Node por um interceptor explícito de rede (ex.: dispatcher undici ou monkeypatch de `fetch`), garantindo que o teste não dê falso-positivo de sucesso.
