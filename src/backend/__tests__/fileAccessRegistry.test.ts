import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FILE_ACCESS_REGISTRY, SENSITIVE_LIST_APPROVED, WORKER_ALLOWED_OPENS } from '../fileAccessRegistry.js';

/**
 * T2: o inventário é um TESTE, não um documento. Reprova se (a) um arquivo de produção importa `fs` fora do registro,
 * (b) o registro lista um arquivo que não importa `fs` (defasagem), (c) um arquivo `existence-only` passa a ler/gravar,
 * (d) `routes.ts` usa um caminho que não nasce do AudioStore, ou (e) o worker abre arquivo fora da lista permitida.
 */
const ROOT = process.cwd();
const FS_IMPORT = /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"](?:node:)?fs['"]\s*\)/;
const FS_CONTENT_OPS = /\bfs\.(?:promises\.)?(?:read|write|append|createReadStream|createWriteStream|open|rm|unlink|rename|copy|truncate)/;

function productionSources(dir = path.join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...productionSources(p)); }
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join('/');

/** Funções puras do scanner, exercidas também sobre fontes sintéticas (prova de mutação do próprio teste). */
export function filesImportingFs(files: Record<string, string>): string[] {
  return Object.entries(files).filter(([, src]) => FS_IMPORT.test(src)).map(([f]) => f).sort();
}
export function pythonOpenViolations(src: string, allowed: readonly string[]): string[] {
  return src.split('\n').map((l) => l.split(/\s#\s/)[0].trim()).filter((l) => /(^|[^\w.])open\(|\bwave\.open\(/.test(l) && !l.startsWith('#') && !allowed.some((a) => l.startsWith(a)));
}

describe('T2: inventário de acessos a arquivo (registro de exceções)', () => {
  const sources: Record<string, string> = {};
  for (const p of productionSources()) sources[rel(p)] = fs.readFileSync(p, 'utf-8');
  const registered = FILE_ACCESS_REGISTRY.map((e) => e.file).sort();

  it('(a)+(b) todo arquivo de produção que importa fs está no registro, e o registro não tem entrada defasada', () => {
    const importing = filesImportingFs(sources).filter((f) => f !== 'src/backend/fileAccessRegistry.ts');
    assert.deepEqual(importing, registered);
    for (const e of FILE_ACCESS_REGISTRY) assert.ok(e.reason.length > 20, `${e.file}: motivo escrito é obrigatório`);
  });

  it('o scanner enxerga um arquivo novo com fs (prova de mutação do teste)', () => {
    const fake = { ...sources, 'src/backend/novo.ts': "import fs from 'node:fs';\nfs.readFileSync('/x');" };
    assert.ok(filesImportingFs(fake).includes('src/backend/novo.ts'));
    assert.ok(!registered.includes('src/backend/novo.ts'));
  });

  it('(c) arquivos "existence-only" nunca leem nem gravam conteúdo', () => {
    for (const e of FILE_ACCESS_REGISTRY.filter((x) => x.cls === 'existence-only')) {
      assert.doesNotMatch(sources[e.file], FS_CONTENT_OPS, `${e.file} deixou de ser só existência`);
    }
  });

  it('(d) routes.ts: todo caminho de gravação/leitura/remoção nasce do AudioStore ou do id registrado, nunca da requisição', () => {
    const src = sources['src/backend/voice/routes.ts'];
    const assigns = [...src.matchAll(/const\s+(audioPath|filePath)\s*=\s*([^;\n]+)/g)].map((m) => m[2].trim());
    assert.ok(assigns.length >= 3);
    for (const rhs of assigns) {
      assert.match(rhs, /^(?:deps\.audioStore\.new\w+Path\(|deps\.sessionManager\.resolveAudioPath\()/, `origem de caminho inesperada: ${rhs}`);
    }
    for (const m of src.matchAll(/(?:writeFile|createReadStream|rm|existsSync)\(\s*([\w.]+)/g)) {
      assert.match(m[1], /^(audioPath|filePath)$/, `fs usado com argumento inesperado: ${m[1]}`);
    }
  });

  it('(e) worker.py: a única abertura direta de arquivo é a gravação atômica do WAV (destino validado antes)', () => {
    const w = fs.readFileSync(path.join(ROOT, 'scripts', 'worker', 'worker.py'), 'utf-8');
    assert.deepEqual(pythonOpenViolations(w, WORKER_ALLOWED_OPENS), []);
    assert.match(w, /policy_check_writable\(path\)[\s\S]{0,400}?part = path \+ "\.part"/, 'o WAV só é gravado depois de validar o destino');
    assert.match(w, /policy_check_readable\(audio_path\)/, 'transcribe valida o caminho recebido');
    assert.match(w, /policy_read\(image_path, SCREEN_READ_MAX\)/, 'describe_screen lê pela política');
    // prova de mutação do scanner: um open() novo seria pego
    assert.equal(pythonOpenViolations(w + '\nwith open(image_path, "rb") as f:\n', WORKER_ALLOWED_OPENS).length, 1);
  });

  it('o registro declara a lista de sensíveis como rascunho (decisão 7 pendente)', () => {
    const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'sensitive-files.json'), 'utf-8')) as { status: string };
    assert.equal(/RASCUNHO/.test(policy.status), !SENSITIVE_LIST_APPROVED, 'constante e status do JSON precisam concordar');
  });
});
