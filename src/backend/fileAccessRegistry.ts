/**
 * T2 (docs/plans/t2-0-inventario-e-contrato-ipc.md): TODO ponto de produção que lê ou grava arquivo no Node está aqui,
 * com a classe e o motivo. A regra do plano: ou passa pela API (o worker aplica a política de `config/sensitive-files.json`
 * via `engine.fileRead`/`fileWrite`), ou é uma EXCEÇÃO DECLARADA. O teste `fileAccessRegistry.test.ts` reprova se um arquivo
 * de produção importar `fs` sem estar aqui, ou se esta lista ficar defasada.
 *
 * A lista de arquivos sensíveis é RASCUNHO da decisão 7 (não aprovada pelo Rodrigo).
 */
export type FileAccessClass =
  | 'exception'        // fs direto, declarado, com o motivo e o limite
  | 'existence-only'   // só existsSync/stat: nunca abre nem lê conteúdo
  | 'non-production';  // motor de teste

export interface FileAccessEntry {
  file: string;
  cls: FileAccessClass;
  reason: string;
}

export const FILE_ACCESS_REGISTRY: readonly FileAccessEntry[] = [
  { file: 'src/backend/config.ts', cls: 'exception', reason: 'o app lê a PRÓPRIA configuração (.env em process.cwd()); é o arquivo que a política lista como sensível, mas quem o lê é o próprio dono; o conteúdo só vai para process.env' },
  { file: 'src/backend/audit/decisionLog.ts', cls: 'exception', reason: 'T4: arquivo de auditoria append-only (JSONL com cadeia de hashes) em <dataDir>/audit/decisions.jsonl, sem conteúdo do usuário (lista fechada de campos + guarda em block); modo 0600' },
  { file: 'src/backend/doctor.ts', cls: 'existence-only', reason: 'T5a: só existência de 3 caminhos fixos do runtime; nunca abre .env, notas, memórias nem docs/research' },
  { file: 'src/backend/knowledge/corpus.ts', cls: 'exception', reason: 'lê docs/research/ para a busca BM25 local; o trecho só sai para a nuvem com RODRIGO_SEND_KNOWLEDGE=1 (padrão desligado)' },
  { file: 'src/backend/server.ts', cls: 'exception', reason: 'serve arquivos estáticos públicos de dist/client com guarda de path traversal (hostValidator + testes)' },
  { file: 'src/backend/storage/jsonStore.ts', cls: 'exception', reason: 'decisão 12: JsonStore (lembretes, notas, memórias) fica em data/ ou RODRIGO_DATA_DIR, nomes fixos, escrita tmp + rename; migração para a API fica para depois' },
  { file: 'src/backend/voice/audioStore.ts', cls: 'exception', reason: 'cria diretórios por sessão; todo nome de arquivo é gerado com crypto.randomUUID(), nunca derivado de entrada' },
  { file: 'src/backend/voice/fakeEngine.ts', cls: 'non-production', reason: 'motor de voz FALSO usado só nos testes; não é carregado em produção (voiceRuntime só constrói o MlxWorkerEngine real)' },
  { file: 'src/backend/voice/mlxWorkerEngine.ts', cls: 'exception', reason: 'cria o diretório do cache do Hugging Face (hfCacheDir fixo); leituras/gravações de conteúdo passam por fileRead/fileWrite' },
  { file: 'src/backend/voice/routes.ts', cls: 'exception', reason: 'grava o corpo (áudio, captura de tela) em caminhos gerados pelo AudioStore e serve áudio pelo id registrado; o teste confere que nenhum caminho vem da requisição' },
  { file: 'src/backend/voice/sessionManager.ts', cls: 'exception', reason: 'apaga (rm) arquivos de áudio temporários cujos caminhos vieram do AudioStore' },
  { file: 'src/backend/voice/tmpSweeper.ts', cls: 'exception', reason: 'varre e apaga SOMENTE dentro de .runtime/tmp (lstat; nunca segue symlink para fora)' },
  { file: 'src/backend/voice/usageLedger.ts', cls: 'exception', reason: 'livro-caixa do gasto próprio (.runtime/usage-ledger.jsonl): só números por (fonte, modelo), nunca texto de conversa; append + leitura filtrada pelo dia' },
  { file: 'src/backend/voice/ttsBudget.ts', cls: 'exception', reason: 'arquivo operacional do app (.runtime/tts-budget.json): contadores, sem dado do usuário; escrita tmp + rename' },
  { file: 'src/backend/tools/macosAccessibility.ts', cls: 'exception', reason: 'só verifica a existência do binário pré-compilado (.runtime/bin/desktop-accessibility); a execução do helper passa pelo executor de comandos auditado' },
  { file: 'src/backend/voice/ttsProviders.ts', cls: 'exception', reason: 'verifica binários/vozes e apaga o AIFF temporário que ele mesmo gerou para o `say` (nome gerado pelo app)' },
  { file: 'src/backend/voice/voiceRuntime.ts', cls: 'existence-only', reason: 'só verifica a existência do runtime de voz e do manifesto' }
];

/**
 * Decisão 7: a lista de arquivos sensíveis (`config/sensitive-files.json`) só deixa de ser rascunho quando o Rodrigo a
 * aprovar. O `doctor` avisa enquanto isto for false; o teste confere que a constante e o `status` do JSON concordam.
 */
export const SENSITIVE_LIST_APPROVED = false;

/** Aberturas de arquivo permitidas no worker Python (`scripts/worker/worker.py`): tudo mais passa por `file_policy`. */
export const WORKER_ALLOWED_OPENS: readonly string[] = [
  'with os.fdopen(os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL', // write_wav_atomic: destino validado ANTES; temporário O_EXCL|O_NOFOLLOW
  'with wave.open(f, "wb") as w:'
];
