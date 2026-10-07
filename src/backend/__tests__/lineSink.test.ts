import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLineSink, TAIL_OVERLAP } from '../voice/lineSink.js';
import { MlxWorkerEngine } from '../voice/mlxWorkerEngine.js';

const K = 'AIzaSyD-SEGREDO-SINTETICO-0123456789abcd';
const FRAGMENTS = ['AIza', 'SyD-SEG', 'SEGREDO', 'SINTETICO', '0123456789abcd'];

function leaks(text: string): string[] {
  return FRAGMENTS.filter((f) => text.includes(f));
}
function collect(): { lines: string[]; sink: ReturnType<typeof createLineSink> } {
  const lines: string[] = [];
  return { lines, sink: createLineSink((l) => lines.push(l)) };
}

describe('createLineSink — buffer por linha antes do redact (Fase 12, achado 2 da rodada 3)', () => {
  it('chave partida em QUALQUER ponto entre dois blocos nunca vaza (todos os cortes possíveis)', () => {
    const line = `Erro ao chamar https://x/y?key=${K} falhou\n`;
    for (let i = 1; i < line.length; i++) {
      const { lines, sink } = collect();
      sink.push(line.slice(0, i));
      sink.push(line.slice(i));
      sink.flush();
      assert.deepEqual(leaks(lines.join('\n')), [], `corte em ${i}: ${JSON.stringify(lines)}`);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].startsWith('Erro ao chamar') && lines[0].endsWith('falhou'));
    }
  });

  it('CONTROLE POSITIVO: o mesmo corte, sem buffer por linha (redact por bloco), VAZA — o teste discrimina', () => {
    const line = `Erro ?key=${K} falhou`;
    const cut = line.indexOf('AIza') + 6; // dentro da chave
    // implementação ingênua = a anterior: cada bloco impresso sozinho
    const naive = [line.slice(0, cut), line.slice(cut)].map((c) => redact0(c)).join('|');
    assert.ok(leaks(naive).length > 0, `a versão por bloco deveria vazar, saiu: ${naive}`);
  });

  it('caractere multibyte partido entre blocos não corrompe o texto', () => {
    const { lines, sink } = collect();
    const bytes = Buffer.from('ação inválida — não\n', 'utf-8');
    for (let cut = 1; cut < bytes.length; cut++) {
      lines.length = 0;
      sink.push(bytes.subarray(0, cut));
      sink.push(bytes.subarray(cut));
      assert.deepEqual(lines, ['ação inválida — não'], `corte em ${cut}`);
    }
  });

  it('várias linhas num bloco; linha parcial só sai no flush; linhas vazias são descartadas', () => {
    const { lines, sink } = collect();
    sink.push('um\n\ndois\ntrês sem quebra');
    assert.deepEqual(lines, ['um', 'dois']);
    sink.flush();
    assert.deepEqual(lines, ['um', 'dois', 'três sem quebra']);
    sink.flush();
    assert.equal(lines.length, 3, 'flush repetido não duplica');
  });

  it('linha gigante sem \\n: a chave que cai em qualquer posição perto do corte por tamanho nunca vaza e nada se perde', () => {
    const total = 20000;
    for (let pos = total - TAIL_OVERLAP - 60; pos <= total - TAIL_OVERLAP + 20; pos += 7) {
      // delimitador '.' após a chave: o padrão da chave é guloso em [0-9A-Za-z_-] (super-mascarar é inofensivo, mas muda o texto esperado)
      const text = 'x'.repeat(pos) + K + '.' + 'y'.repeat(total - pos - K.length - 1);
      // dois modos de entrega: tudo de uma vez, e em blocos de 997 bytes
      for (const step of [text.length, 997]) {
        const { lines, sink } = collect();
        for (let i = 0; i < text.length; i += step) sink.push(text.slice(i, i + step));
        sink.flush();
        const joined = lines.join('');
        assert.deepEqual(leaks(joined), [], `pos=${pos} step=${step}`);
        assert.equal(joined, 'x'.repeat(pos) + '[REDACTED].' + 'y'.repeat(total - pos - K.length - 1), `nada perdido (pos=${pos}, step=${step})`);
      }
    }
  });
});

function redact0(c: string): string {
  // o que o código ANTERIOR fazia, com a máscara aplicada por bloco (mesmo redact, sem buffer por linha)
  return redactNaive(c);
}
import { redact as redactNaive } from '../redact.js';

describe('MlxWorkerEngine — o stderr do worker real passa pelo buffer por linha (integração com worker falso)', () => {
  it('chave escrita em duas fatias espaçadas no tempo nunca chega ao console; linha limpa chega (controle positivo)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-fakeworker-'));
    const script = path.join(dir, 'fake-worker.mjs');
    fs.writeFileSync(
      script,
      `process.stderr.write('Erro https://x/y?key=AIzaSyD-SEG');
       setTimeout(() => process.stderr.write('REDO-SINTETICO-0123456789abcd falhou\\n'), 80);
       setTimeout(() => process.stderr.write('linha limpa\\n'), 160);
       process.stdout.write('lixo-nao-json ?key=AIzaSyD-SEGREDO-SINTETICO-0123456789abcd\\n');
       setInterval(() => {}, 1000);`
    );
    const captured: string[] = [];
    const savedError = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    const engine = new MlxWorkerEngine({ pythonBin: process.execPath, workerScript: script, hfCacheDir: path.join(dir, 'hf') });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !captured.some((l) => l.includes('linha limpa'))) await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.error = savedError;
      await engine.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const all = captured.join('\n');
    assert.ok(all.includes('[voice-worker] linha limpa'), `o captador funciona: ${all}`);
    assert.ok(all.includes('[voice-worker] Erro https://x/y?key=[REDACTED]'), `a linha com a chave saiu mascarada: ${all}`);
    assert.ok(all.includes('Linha de protocolo inválida ignorada: lixo-nao-json ?key=[REDACTED]'), `o caminho do stdout inválido saiu mascarado: ${all}`);
    assert.deepEqual(leaks(all), [], `vazou: ${all}`);
  });
});
