import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FORBIDDEN, findViolations } from './privacyClaims.js';

/**
 * Fase 12 (docs/phase-12-v2.md §2.3, H12.1): nenhuma tela ou documento pode prometer ausência de
 * nuvem/custo/chave/terceiros enquanto a geração em nuvem existe. A lista de padrões é versionada
 * aqui; cada arquivo tem CONTROLE POSITIVO (um fixture com a frase proibida DEVE ser detectado),
 * senão um detector quebrado passaria em silêncio.
 */
const ROOT = process.cwd();
function frontendFiles(): string[] {
  const dir = path.join(ROOT, 'src', 'frontend');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.html') || f.endsWith('.ts') || f.endsWith('.css'))
    .map((f) => path.join('src', 'frontend', f));
}
const FILES = [...frontendFiles(), 'README.md', '.env.example', 'CLAUDE.md'];

describe('Consistência da promessa de privacidade (Fase 12, H12.1)', () => {
  it('a lista de arquivos varridos inclui os quatro alvos do plano (e existe no disco)', () => {
    for (const must of ['src/frontend/index.html', 'README.md', '.env.example', 'CLAUDE.md']) {
      assert.ok(FILES.includes(must), `${must} deve estar na varredura`);
      assert.ok(fs.existsSync(path.join(ROOT, must)), `${must} deve existir (cwd=${ROOT})`);
    }
  });

  for (const rel of FILES) {
    it(`${rel}: nenhuma frase proibida`, () => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      assert.deepEqual(findViolations(content), [], `frases proibidas em ${rel}`);
    });

    it(`${rel}: controle positivo — o detector acusa a frase proibida injetada`, () => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      for (const { name, re, sample } of FORBIDDEN) {
        assert.ok(re.test(sample), `padrão ${name} deve casar a própria amostra (${sample})`);
        const polluted = `${content}\n${sample}\n`;
        const found = findViolations(polluted).filter((v) => v.pattern === name);
        assert.ok(found.length >= 1, `injetar "${sample}" em ${rel} deve ser detectado`);
      }
    });
  }

  it('o qualificador legítimo libera a linha (e só ela)', () => {
    assert.deepEqual(findViolations('Voz 100% local com geração em nuvem desligada.'), []);
    assert.equal(findViolations('Voz 100% local.\nOutra linha com geração em nuvem desligada.').length, 1);
  });
});
