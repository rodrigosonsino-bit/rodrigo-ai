# RELATÓRIO DE AUDITORIA ADVERSARIAL — PLANO DA FASE 12 (`docs/phase-12-v1.md`)

Auditoria estrita e adversarial realizada diretamente contra os arquivos do repositório (`src/backend`, `src/frontend`, `scripts/worker`, `scripts/*.mjs`), sem delegação a subtarefas e sem modificação de arquivos.

---

### ACHADO 1 — Exfiltração da `GEMINI_API_KEY` via Redirecionamento HTTP 307 ou Proxy Local com `RODRIGO_GEMINI_BASE_URL`
* **EVIDÊNCIA:** `docs/phase-12-v1.md:124-130` (§2.5) vs `scripts/worker/worker.py:871-873` e comportamento do SDK `google-genai` (v2.28.0).
  * Verificado experimentalmente no ambiente com o cliente `google-genai`: quando o cliente se conecta a uma `base_url` em loopback (`http://127.0.0.1:<porta>`) e o servidor responde com `307 Temporary Redirect` (ou `301`/`302`/`308`) para um destino externo (`Location: http://evil.com/exfiltrate`), o cliente HTTP subjacente (`httpx`) **segue o redirecionamento automaticamente e preserva o header `x-goog-api-key`**, enviando a chave secreta em texto claro para o host externo.
  * Além disso, qualquer processo colocalizado não privilegiado escutando em loopback pode capturar a chave real se a variável for definida no ambiente do usuário, pois o plano não exige que a chave usada em testes com loopback seja sintética/falsa.
* **GRAVIDADE:** CRÍTICA
* **CONFIANÇA:** 100%
* **AÇÃO RECOMENDADA:** 
  1. No cliente Python, instanciar `httpx.Client(follow_redirects=False)` e repassá-lo em `http_options=genai.types.HttpOptions(httpx_client=...)` para desabilitar estritamente qualquer redirecionamento HTTP.
  2. A variável `RODRIGO_GEMINI_BASE_URL` deve ser **estritamente ignorada** a menos que o ambiente declare explicitamente modo de teste (`NODE_ENV === 'test'` ou `RODRIGO_TEST === '1'`).
  3. Quando `RODRIGO_GEMINI_BASE_URL` estiver ativa, o worker deve exigir e usar exclusivamente uma chave de teste fictícia (`api_key="test-dummy-key"`), recusando-se a trafegar a `GEMINI_API_KEY` real.

---

### ACHADO 2 — Omissão de `RODRIGO_SEND_HISTORY` e Vazamento de Dados Locais (Notas, Memórias, Lembretes) para o Gemini via `session.history`
* **EVIDÊNCIA:** `docs/phase-12-v1.md:11, 79-87, 93-100` vs `src/backend/voice/sessionManager.ts:330, 620-623, 732`.
  * No plano (§0, linha 11): o objetivo promete *"controle do que pode sair (histórico, memórias, trecho de pesquisa)"*.
  * No plano (§2.1, linha 85): `PrivacyStatus` declara o campo `sends: { history: boolean; memories: boolean; ... }`.
  * **Contradição frontal:** Na tabela de controles (§2.2, linhas 93-100), **não existe `RODRIGO_SEND_HISTORY`**! Foram definidas apenas `RODRIGO_CLOUD_GENERATION`, `RODRIGO_SEND_MEMORIES` e `RODRIGO_SEND_KNOWLEDGE`.
  * **Vazamento ativo no código:** Em `sessionManager.ts:330`, toda transcrição de usuário é inserida em `session.history`. Em `sessionManager.ts:732`, toda pergunta de confirmação de ferramenta (ex.: *"Posso guardar a nota: segredo bancário X?"*) e todo resultado de execução de ferramenta são inseridos em `session.history` via `markPlayed()`.
  * No próximo turno discursivo que dependa de geração, `messagesForEngine` (`sessionManager.ts:620-623`) envia `{ role: 'system', content: systemPrompt }, ...session.history`.
  * Logo, mesmo com `RODRIGO_SEND_MEMORIES=0` e ferramentas sendo "locais", o conteúdo confidencial de notas, memórias e lembretes tratados na sessão é **integralmente enviado ao Gemini em turnos subsequentes via `session.history`**.
* **GRAVIDADE:** CRÍTICA
* **CONFIANÇA:** 100%
* **AÇÃO RECOMENDADA:**
  1. Incluir no §2.2 o controle `RODRIGO_SEND_HISTORY` (padrão `1`, se `0` envia apenas a fala do turno atual para geração, sem histórico anterior).
  2. Implementar sanitização/isolamento em `sessionManager.ts` para que turnos que executaram ou confirmaram ferramentas com dados locais (notas, memórias, lembretes) não contaminem o histórico compartilhado com a nuvem, ou recebam expurgo antes de serem despachados para o Gemini.

---

### ACHADO 3 — Falso "Modo Sem Nuvem": `RODRIGO_CLOUD_GENERATION=0` Deixa Chamadas de Intenção (`RODRIGO_CLOUD_INTENT`) Ativas na Nuvem
* **EVIDÊNCIA:** `docs/phase-12-v1.md:97, 153-156` (§2.2 e §3 D3) vs `src/backend/voice/sessionManager.ts:425-437` e `scripts/worker/worker.py:746-749`.
  * O plano chama `RODRIGO_CLOUD_GENERATION=0` de *"modo sem nuvem"* (§3 D3).
  * Porém, em `sessionManager.ts:426-431`, qualquer fala do usuário que passe pelo filtro `mightBeMutation` ou `mightBeTemporal` (como perguntas de hora, data, criação de lembretes, notas e memórias) aciona `this.engine.detectIntent(...)`.
  * No worker (`worker.py:746`), essa chamada é controlada independentemente por `RODRIGO_CLOUD_INTENT` (cujo padrão é `1`).
  * Portanto, com `RODRIGO_CLOUD_GENERATION=0`, a aplicação **NÃO está sem nuvem**: o texto de falas contendo potenciais notas e comandos continua sendo despachado pela internet para o modelo `gemini-3.5-flash-lite` no Google.
  * Além disso, isso faz o critério de aceite H12.3 falhar: se o teste rodar com rede bloqueada e apenas `GENERATION=0`, `detectIntent` tentará bater na API do Gemini na internet, travando a thread por 4.0 segundos (`CLOUD_INTENT_WAIT_S`) a cada uma das 50 tarefas locais.
* **GRAVIDADE:** ALTA
* **CONFIANÇA:** 100%
* **AÇÃO RECOMENDADA:**
  1. Definir que `RODRIGO_CLOUD_GENERATION=0` desative por cascata qualquer saída para nuvem (incluindo intenção), OU criar uma variável mestre `RODRIGO_OFFLINE=1` / `RODRIGO_CLOUD=0`.
  2. Se mantidas separadas, corrigir a documentação e a UI para nunca chamar `RODRIGO_CLOUD_GENERATION=0` de "modo sem nuvem", e sim "modo sem geração discursiva", explicitando que intenção continua saindo.
  3. Atualizar formalmente o critério H12.3 para exigir `RODRIGO_CLOUD_INTENT=0` explicitamente no teste de rede bloqueada.

---

### ACHADO 4 — Dois Clientes Gemini no Worker Ignorados pelo Plano Quebram H12.2 e Isolamento de Rede
* **EVIDÊNCIA:** `docs/phase-12-v1.md:124-129` (§2.5) vs `scripts/worker/worker.py:754-757` e `worker.py:871-877`.
  * O plano §2.5 descreve no singular: *"O cliente genai do worker aceita base_url em HttpOptions. Adicionar RODRIGO_GEMINI_BASE_URL..."*.
  * No código, existem **dois clientes `genai.Client` totalmente distintos e independentes**:
    1. `self._intent_client` em `worker.py:754` (usado por `detectIntent`);
    2. `self._gemini_client` em `worker.py:871` (usado por `handle_generate`).
  * Se a implementação injetar `base_url` apenas no cliente de geração (como o texto do plano sugere), a chamada de intenção continuará conectando ao endpoint real da nuvem na internet (`generativelanguage.googleapis.com`).
  * Em H12.2, o servidor mock em loopback não capturará o tráfego de intenção; se a internet estiver bloqueada ou se dados sensíveis forem testados, haverá vazamento real ou falha por timeout de rede.
  * Adicionalmente, o mock em loopback de H12.2 precisará responder a dois contratos HTTP distintos: streaming SSE para geração (`stream_generate_content`) e JSON estrito conforme o schema para intenção (`intent`, `content`). O plano não especifica o suporte a ambos no mock.
* **GRAVIDADE:** ALTA
* **CONFIANÇA:** 100%
* **AÇÃO RECOMENDADA:**
  * Atualizar o plano para especificar expressamente a configuração de `base_url` em AMBOS os clientes (`self._intent_client` e `self._gemini_client`), e especificar o comportamento do mock para ambas as rotas de API.

---

### ACHADO 5 — Condição de Corrida e Destruição de Sessões Ativas por `audioStore.cleanupAll()`
* **EVIDÊNCIA:** `docs/phase-12-v1.md:117` (§2.4) vs `src/backend/voice/audioStore.ts:58-61` e `src/backend/voice/voiceRuntime.ts:101`.
  * O plano propõe: *"Chamar audioStore.cleanupAll() na inicialização do voiceRuntime (antes de aceitar sessões) e no shutdown."*
  * Em `audioStore.ts:58-61`:
    ```ts
    async cleanupAll(): Promise<void> {
      await fs.promises.rm(this.baseDir, { recursive: true, force: true }).catch(() => {});
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    ```
    onde `this.baseDir` é `.runtime/tmp` (`voiceRuntime.ts:101`).
  * O Rodrigo AI não possui trava de processo único (PID lock / socket lock). Se o servidor principal estiver em execução (`npm run dev`) e o usuário ou script executar um teste (`npm test`, cujos arquivos rodam em processos paralelos pelo Node test runner), ou um benchmark (`node scripts/matrix-c6.mjs`), a nova inicialização executará `cleanupAll()` e **apagará incondicionalmente todos os arquivos e diretórios de áudio de sessões ativas da outra instância**.
  * Pior: `AudioStore.dirFor(sessionId)` armazena em cache `this.sessionDirs.get(sessionId)` em memória. Se a pasta da sessão for apagada no disco por outro processo, `dirFor()` **não a recria**, e qualquer gravação ou leitura de áudio subsequente daquela sessão falhará com erro fatal de sistema de arquivos (`ENOENT`).
* **GRAVIDADE:** ALTA
* **CONFIANÇA:** 100%
* **AÇÃO RECOMENDADA:**
  * Não fazer `rm -rf` cego em `.runtime/tmp`. Implementar limpeza baseada em varredura de diretórios de sessão órfãos com checagem de idade/TTL (ex.: sessões inativas há mais de 10 minutos), ou associar subdiretórios ao PID do processo instanciador (`.runtime/tmp/<pid>/...`).

---

### ACHADO 6 — Ambiguidade de Desenho e Risco Desnecessário na Limpeza de `os.tmpdir()`
* **EVIDÊNCIA:** `docs/phase-12-v1.md:118-119, 191` (§2.4 e §6) vs `src/backend/voice/ttsProviders.ts:41-61`.
  * O plano propõe duas alternativas não decididas: *"Mover o .aiff temporário do say para dentro de .runtime/tmp/ (alcançado por cleanupAll) ou varrer os.tmpdir() por rodrigo-say-* na inicialização."*
  * Varrer `os.tmpdir()` introduz riscos de concorrência com outras instâncias, scripts de benchmark (`scripts/h11-check.mjs:55` que usam `rodrigo-h11-` em `os.tmpdir()`) e reutilização de PID pelo sistema operacional.
  * **Oportunidade de arquitetura ignorada:** Em `SayVoiceProvider.synthesize(text, outputPath)`, o método já recebe `outputPath`, que aponta exatamente para a pasta temporária da sessão (`.runtime/tmp/<uuid>/out-<uuid>.wav`). O arquivo intermediário `.aiff` pode ser criado simplesmente como `${outputPath}.aiff` no mesmo diretório!
* **GRAVIDADE:** MÉDIA
* **CONFIANÇA:** 100%
* **AÇÃO RECOMENDADA:**
  * Eliminar a opção de varrer `os.tmpdir()`. Fixar no plano a alteração de `SayVoiceProvider` para gravar o `.aiff` temporário no mesmo diretório de `outputPath` (`.runtime/tmp/...`), sendo limpo naturalmente no `cleanupSession()`.

---

### ACHADO 7 — Contradição Formal entre H12.2 e §7 quanto à "Marca Só Local"
* **EVIDÊNCIA:** `docs/phase-12-v1.md:161-163` (§4, H12.2) vs `docs/phase-12-v1.md:196` (§7).
  * No critério de aceite H12.2: *"zero áudio e zero conteúdo marcado como 'só local' nas requisições"*.
  * No escopo (§7, Fora de escopo): *"Marca 'só local' por item (F14)"*.
  * O teste H12.2 exige validar a ausência de itens com uma marcação que não existe e foi expressamente jogada para a Fase 14. Esse critério é impossível de ser testado contra código real ou gera um falso teste.
* **GRAVIDADE:** MÉDIA
* **CONFIANÇA:** 100%
* **AÇÃO RECOMENDADA:**
  * Remover a menção a "marcado como só local" de H12.2, restringindo o critério a: "zero áudio; zero memórias com `SEND_MEMORIES=0`; zero trechos de pesquisa com `SEND_KNOWLEDGE=0`; e envio estrito apenas dos campos declarados em `/api/privacy`".

---

### ACHADO 8 — Omissões Graves de Alegações Falsas de Privacidade em `src/frontend/index.html`
* **EVIDÊNCIA:** `docs/phase-12-v1.md:40-49, 110-112` (§1.2 e §2.3) vs `src/frontend/index.html:116, 118, 127`.
  * O plano lista em §1.2 e §2.3 apenas as linhas `:40`, `:92` e `:121` do `index.html` para correção.
  * Uma auditoria linha a linha de `src/frontend/index.html` revela declarações falsas categóricas não listadas no plano:
    1. **Linha 127 (Footer):** `<footer><p>Rodrigo AI — Execução local no computador sem tráfego de dados para terceiros.</p></footer>` (Afirmação 100% falsa com Gemini ativo).
    2. **Linha 116 e 118 (Card de Custo):** `<h2 id="cost-title">Sem cobrança de API nesta fase</h2>` e `<p>Nenhum serviço pago, chave de acesso ou chamada a servidores externos é utilizada pela aplicação.</p>` (Afirmação 100% falsa: a aplicação utiliza chave de acesso e servidores do Google).
    3. **Linha 6 (Meta tag):** `<meta name="description" content="Rodrigo AI — Orchestrator Local (Fase 3)" />`.
  * Se o plano for executado como escrito, o footer e o card de custo continuarão prometendo ao usuário que "não há tráfego de dados para terceiros" e que "nenhuma chave de acesso ou servidor externo é utilizado".
* **GRAVIDADE:** ALTA
* **CONFIANÇA:** 100%
* **AÇÃO RECOMENDADA:**
  * Incluir formalmente no plano a retificação ou remoção das linhas 116, 118 e 127 de `src/frontend/index.html`, além do teste de consistência estático cobrir essas frases literais.

---

### ACHADO 9 — Risco de Vazamento de Prompts, Falas e Chaves via `log_diag` / Stderr no Worker
* **EVIDÊNCIA:** `docs/phase-12-v1.md:62-66` (§1.4) vs `scripts/worker/worker.py:784, 794, 956` e `src/backend/voice/mlxWorkerEngine.ts:143`.
  * O plano assume como "suposição a verificar na implementação" que o worker nunca imprime falas ou chaves.
  * Auditando o código de `worker.py`:
    - Linha 784: `return unavailable(f"{type(exc).__name__}: {str(exc)[:160]}")`
    - Linha 794: `unavailable(f"erro: {type(exc).__name__}: {str(exc)[:200]}")`
    - Linha 956: `log_diag(f"Erro na geração via Gemini: {exc}\n{traceback.format_exc()}")`
  * Todas as chamadas `unavailable()` emitem log para stderr via `log_diag` (linha 739: `log_diag(f"Intenção em nuvem indisponível ({reason})...")`).
  * Em `mlxWorkerEngine.ts:143`, o Node repassa sem qualquer filtro todo o stderr do worker:
    `console.error(`[voice-worker] ${chunk.toString('utf-8').trimEnd()}`);`
  * Exceções do cliente `google.genai.errors.APIError` ou falhas de validação de HTTP (`ClientError`, 400 Bad Request) frequentemente reproduzem em `str(exc)` a URL completa com parâmetros de consulta ou trechos do payload do request rejeitado. Em caso de falha de autenticação ou schema, a chave ou fragmentos do prompt podem ser cuspidos diretamente no console/log.
* **GRAVIDADE:** MÉDIA
* **CONFIANÇA:** 95%
* **AÇÃO RECOMENDADA:**
  * Sanitizar mensagens de erro antes de emitir para `log_diag`: mascarar qualquer padrão semelhante a chave de API (`AIza...`) e truncar mensagens de exceção HTTP sem incluir o corpo bruto do request/response.

---

### ACHADO 10 — Fragilidade na Validação e Teste de Rotação de Chave (H12.5)
* **EVIDÊNCIA:** `docs/phase-12-v1.md:68-70, 169-170` (§1.5 e §4, H12.5).
  * H12.5 prescreve: *"chamada de 1 token com a antiga deve falhar"*.
  * O plano não define qual componente executa essa chamada, onde a chave antiga é guardada para esse teste e como isso é automatizado.
  * Se a chave antiga estiver revogada no Google AI Studio, o usuário não pode colocá-la em arquivos do repositório (regra de segredos). Se for passada por variável de ambiente para um script de teste, há risco de entrar em histórico de shell ou ser herdada por outros processos.
* **GRAVIDADE:** BAIXA
* **CONFIANÇA:** 90%
* **AÇÃO RECOMENDADA:**
  * Especificar o roteiro operacional exato de H12.5 como um script interativo ou verificação manual com prompt estrito de teste (sem persistência da chave antiga em disco nem em variáveis globais).

---

## O QUE NÃO FOI POSSÍVEL VERIFICAR (LIMITAÇÕES DA AUDITORIA)

1. **Conteúdo real do arquivo `.env` de produção**: Em cumprimento estrito às regras de segurança e privacidade do projeto, o arquivo `.env` não foi lido para checar se a chave atual do usuário está ativa ou se contém outras variáveis.
2. **Comportamento dinâmico em tempo de execução dos servidores do Google AI Studio**: Não foram feitas chamadas ativas à API pública do Gemini pela internet durante esta auditoria (apenas testes locais contra servidores mock e inspeção estática das bibliotecas instaladas).
3. **Resolução de DNS de sistemas operacionais em cenários de rebinding**: Não foi testada a pilha de DNS do macOS sob ataques ativos de DNS rebinding contra `localhost`.

---

## VEREDITO FINAL

### **REJEITADO**

**Justificativa Técnica:**
O plano `docs/phase-12-v1.md` falha nos seus dois objetivos principais de segurança e privacidade:
1. **Segurança de Rede:** A nova variável de instrumentação `RODRIGO_GEMINI_BASE_URL` cria um vetor crítico de exfiltração da `GEMINI_API_KEY` via redirecionamento HTTP 307 (comportamento padrão confirmado da SDK `google-genai`), além de não mitigar colocalização local e desconsiderar a existência de dois clientes Gemini no worker Python.
2. **Privacidade e Honestidade:** A promessa de privacidade continuaria falsa ao final da fase: o plano omitiu completamente o controle de `history` em §2.2 (embora prometido no §0 e §2.1), permitindo que notas, memórias e lembretes tratados "localmente" vazem para o Gemini via `session.history` na fala discursiva seguinte. Além disso, o chamado "modo sem nuvem" mantém o envio de falas para a nuvem via intenção (`RODRIGO_CLOUD_INTENT`), e o frontend continuaria exibindo alegações falsas no footer e no card de custo que o plano não previu para correção.

O plano deve ser atualizado para a versão **v2.0**, incorporando as correções dos Achados 1 a 8 antes de ser liberado para implementação.
