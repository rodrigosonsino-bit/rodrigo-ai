# T2-0: inventário dos pontos de leitura e escrita de arquivo e contrato de IPC do helper

Estado: **ENTREGA DA T2-0** (decisão 1: T2-0 aprovada para entrar no ciclo; decisão 9: veículo = helper no worker Python). Documento, sem código de produto. **Ainda não auditado.** Base: `main` em `746b2c3`, plano `docs/plans/openjarvis-voz-desktop-v2.md` v2.6.

**Método e limite:** levantamento por busca no código (`rg`) em `src/` (fora de `__tests__`) e em `scripts/worker/worker.py`; a **classificação é provisória**: foi feita pelo contexto da linha, **sem ler cada função inteira**. Cada item marcado "a confirmar" precisa de leitura própria na T2 antes de valer. O que não aparece na busca (acesso por biblioteca de terceiros, subprocessos, `spawn` de binários) **não está coberto**.

## 1. Quem a política protege, e de quê

A T2 não é "o app nunca lê arquivo sensível". O app lê o próprio `.env` e o corpus local de propósito. O que a política protege é: (i) **executores de nuvem** (o registro de executores e o `delegar`) não receberem tarefa que toque arquivo sensível; (ii) caminhos que dependem de **entrada que o app não controla** (nomes de arquivo vindos de requisição, de store ou de ferramenta) não serem desviados por symlink ou por troca entre a checagem e o uso. Por isso o inventário separa o que é **caminho controlado pelo app** do que é **derivado de entrada**.

## 2. Inventário (Node, `src/`, fora de testes)

| # | Arquivo:linha | Operação | Origem do caminho | Classe provisória |
|---|---|---|---|---|
| 1 | `storage/jsonStore.ts:30,37,68,69` | `mkdir`, leitura, escrita em `tmp` + `rename` | `baseDir` = `data/` ou `RODRIGO_DATA_DIR`, nomes fixos (`lembretes.json`, `notas.json`, `memorias.json`) | **Exceção declarada** (decisão 12), com validação do diretório na inicialização |
| 2 | `agents/pendingAsyncStore.ts:56` | via `JsonStore` | `baseDir` do app | Exceção declarada (mesmo item 1) |
| 3 | `config.ts:11,13` | leitura de arquivo `.env` | `targetPath` de configuração do app | **Exceção declarada**: o app lê a própria configuração; é o arquivo que a política lista como sensível. A confirmar de onde vem `targetPath` |
| 4 | `knowledge/corpus.ts:158` | leitura de arquivos de `docs/research/` | diretório do corpus, nomes listados pelo app | **Exceção declarada, controlada por `RODRIGO_SEND_KNOWLEDGE`**: leitura local para a busca BM25; só sai para a nuvem com a flag ligada (padrão desligado). A confirmar se há `readdir` |
| 5 | `voice/ttsBudget.ts:110,140-165` | leitura, `mkdir`, `lock` com `openSync('wx')`, escrita em `tmp` + `rename`, `unlink` | `.runtime/tts-budget.json`, caminho fixo | Exceção declarada (arquivo operacional do app, não contém dado do usuário) |
| 6 | `voice/tmpSweeper.ts:106,116,143` | `readdir`, `lstat`, `rmSync(recursive)` | `baseDir` dos temporários de áudio | **A confirmar com cuidado:** apaga recursivamente; usa `lstat`, bom sinal; verificar que nunca sai do `baseDir` |
| 7 | `voice/audioStore.ts:19,30,76` | `mkdir` | `baseDir` de áudio temporário | Exceção declarada |
| 8 | `voice/routes.ts:298-303` | `existsSync` + `createReadStream(filePath)` servido ao cliente | `filePath` **a confirmar**: se vem de um id no store (seguro) ou de parâmetro da requisição (**risco**) | **Candidato a passar pela API**; maior prioridade de leitura |
| 9 | `server.ts:111-147` | `existsSync`, `statSync`, `createReadStream` | `targetFile` derivado da URL, com guarda de path traversal (documentada no `CLAUDE.md`) | Arquivos estáticos públicos de `dist/client`; **confirmar a guarda** (symlink dentro de `dist/`?) |
| 10 | `voice/sessionManager.ts:1325,1333,1440` | `fs.rm(filePath, {force})` | `filePath` de áudio temporário | A confirmar a origem de `filePath` |
| 11 | `voice/voiceRuntime.ts:59,66,73` | só `existsSync` | caminhos fixos do runtime | Sem risco (só existência) |
| 12 | `voice/ttsProviders.ts:41,94` | só `existsSync` | binários fixos | Sem risco |
| 13 | `voice/mlxWorkerEngine.ts:187` | `mkdir` do cache do Hugging Face | `hfCacheDir` fixo | Exceção declarada |
| 14 | `voice/fakeEngine.ts:2` | importa `fs` | motor de teste | Fora de produção |

## 3. Inventário (Python, `scripts/worker/worker.py`)

| # | Linha | Operação | Origem do caminho | Classe provisória |
|---|---|---|---|---|
| 15 | `607-621` | grava WAV em `.part` e `os.replace`; `unlink` do `.part` em falha | caminho de saída de TTS recebido do Node (a confirmar a validação) | **Deve passar pela escrita segura** do helper, ou ficar como exceção com o caminho validado |
| 16 | `1149` | `open(image_path, "rb")` da captura de tela | `image_path` recebido do Node no comando `describe_screen` | **Deve passar pela leitura segura**: é o ponto em que um caminho vindo do Node vira leitura e **o conteúdo sai para a nuvem** |

Os comandos atuais do worker são `transcribe`, `classify`, `detect_tool`, `detect_mutation`, `detect_intent` e `describe_screen` (loop em `work_loop`, linhas 1681-1700). **Nenhum** lê ou grava arquivo em nome do Node; os itens 15 e 16 são as únicas aberturas dentro do worker.

## 4. Fora do app: scripts (não cobertos aqui)

`scripts/` tem 17 arquivos Python e Node que leem ou gravam arquivo (`dev.mjs`, `setup-voice.mjs`, `notebooklm-sync.py`, `bench-voice.mjs`, scripts de medição da F11 e outros). São ferramentas de desenvolvimento rodadas pelo Rodrigo ou por agentes, **não** o runtime do app. Entram na T2 só se o registro de executores e o `delegar` passarem a mediar o que um executor de nuvem pode pedir a eles. **A decidir na T2**, não aqui.

## 5. Conclusões provisórias para a T2

1. **Exceções declaradas (provável maioria):** itens 1, 2, 3, 4, 5, 7, 13: arquivos operacionais ou de configuração do próprio app, com caminho fixo. Cada exceção precisa de um **teste de bypass** (o plano exige) e do motivo escrito.
2. **Candidatos reais à API do helper:** 8 (`routes.ts`, servir arquivo ao cliente), 16 (captura de tela que sai para a nuvem) e 15 (escrita de WAV com caminho vindo do Node), mais o 10 e o 6 depois de lidos.
3. **A confirmar por leitura antes de qualquer código:** origem de `filePath` nos itens 8 e 10, de `targetPath` no 3, de `listdir` no 4 e a guarda de path traversal do item 9.
4. **O `JsonStore` (item 1) é o maior risco de exceção** porque guarda dado do usuário; a decisão 12 já o deixa como exceção com validação na inicialização (`realpath` no lugar esperado, não é symlink, permissão 700). Isso protege contra um `data/` trocado antes de iniciar, **não** contra troca durante a execução; é um limite declarado.

## 6. Contrato de IPC (versão refinada da proposta do plano v2.6, ainda não implementada)

Transporte: o NDJSON por stdio que o worker já usa, com os mesmos campos de controle dos comandos atuais (a confirmar na leitura do `work_loop`: `cmd`, `turnId`, `epoch` e como a resposta é correlacionada). **Os comandos de arquivo NÃO podem passar pela fila de geração**: o plano proíbe isso, porque a geração ocupa o laço e a fila tem tamanho 1; usam um **pool próprio de threads**, como a síntese de voz.

### 6.1 `file_read`

Pedido: `{"cmd":"file_read","id":"<uuid>","path":"<caminho>","max_bytes":1048576}`

Resposta de sucesso: `{"id":"<uuid>","ok":true,"bytes_b64":"...","size":1234,"class":"ordinary"}`

Resposta de falha: `{"id":"<uuid>","ok":false,"reason":"<enumerado>"}`

### 6.2 `file_write`

Pedido: `{"cmd":"file_write","id":"<uuid>","path":"<caminho>","data_b64":"..."}`

Resposta de sucesso: `{"id":"<uuid>","ok":true,"bytes_written":1234,"sha256":"<hex>"}`

Falha: `{"id":"<uuid>","ok":false,"reason":"<enumerado>"}`

### 6.3 Regras comuns

- **`reason` enumerado:** `sensitive`, `symlink`, `too_large`, `not_found`, `io_error`, `timeout`, `bad_request`.
- **Limites iniciais (palpites, a medir):** leitura até 1 MiB; escrita até 256 KiB; 5 s por pedido; no máximo N pedidos em voo (a definir).
- **Abertura:** componente a componente com `dir_fd` e `O_NOFOLLOW` (`ENOTDIR` esperado para diretório pai trocado, `ELOOP` para arquivo trocado, conforme os experimentos `t2_openat_escrita.py` e `t2b_escrita_recusa_symlink.py`); classificação do descritor já aberto por **nome e por inode**, com **testes unitários próprios por camada** (achado dos experimentos).
- **Escrita:** arquivo temporário com `O_CREAT|O_EXCL|O_NOFOLLOW` e `rename` no mesmo diretório; **recusa** destino que seja symlink; o `rename` sem seguir o symlink é a defesa de fundo.
- **Falha fechada:** worker ausente, atrasado ou com erro resulta em recusa; o Node **nunca** lê direto como reserva.
- **Confirmação da escrita:** o Node confere o `sha256` devolvido contra o do que enviou.
- **Sem descritor no meio do canal:** descritor aberto no Python não atravessa os pipes; o Python lê e devolve os **bytes**.

### 6.4 Pontos em aberto do contrato (a fechar na T2, não aqui)

1. Formato exato dos campos de correlação e de cancelamento (ler o protocolo atual do `work_loop`).
2. O que fazer com arquivos maiores que o limite (streaming, partes, ou recusa).
3. O `JsonStore` fica fora (decisão 12); se um dia migrar, a escrita precisa de **transação por arquivo**, e o marcador `applied` da T4 entra na mesma troca atômica.
4. Quem classifica "sensível": a lista aprovada (decisão 7, **ainda pendente**). Sem ela a classificação não pode ser implementada; o helper pode ser escrito e testado só com uma lista de testes (marcadores falsos).

## 7. O que esta entrega não faz

Não implementa nenhum comando no worker, não altera nenhum arquivo de produção e **não libera a T2**, que segue bloqueada pela decisão 7 (aprovação da lista de arquivos sensíveis). Serve de base para o plano de implementação detalhado da T2 e para a auditoria dele.
