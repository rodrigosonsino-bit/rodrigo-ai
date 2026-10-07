import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { redact, REDACTED } from '../redact.js';

interface RedactCase {
  name: string;
  input: string;
  env?: string;
  extra?: string[];
  maxLen?: number;
  notContain?: string[];
  contain?: string[];
  unchanged?: boolean;
  endsWith?: string;
  maxLength?: number;
}

const CASES = (JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'src', 'backend', '__tests__', 'fixtures', 'redact-cases.json'), 'utf-8')
) as { cases: RedactCase[] }).cases;

function withEnvKey<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.GEMINI_API_KEY;
  if (value === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
}

describe('redact() — mesmos casos do espelho Python (Fase 12, §2.6)', () => {
  it('o arquivo de casos foi carregado', () => {
    assert.ok(CASES.length >= 20);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const out = withEnvKey(c.env, () => redact(c.input, c.extra ?? [], c.maxLen));
      for (const frag of c.notContain ?? []) assert.ok(!out.includes(frag), `vazou ${JSON.stringify(frag)}: ${JSON.stringify(out)}`);
      for (const frag of c.contain ?? []) assert.ok(out.includes(frag), `sumiu texto legítimo ${JSON.stringify(frag)}: ${JSON.stringify(out)}`);
      if (c.unchanged) assert.equal(out, c.input);
      if (c.endsWith) assert.ok(out.endsWith(c.endsWith), out);
      if (c.maxLength !== undefined) assert.ok(out.length <= c.maxLength, `len=${out.length}`);
    });
  }

  it('CONTROLE POSITIVO: sem redact (identidade) todo caso de vazamento seria detectado pelo corredor', () => {
    const leaky = CASES.filter((c) => c.notContain?.length);
    assert.ok(leaky.length >= 15);
    for (const c of leaky) {
      const identity = c.maxLen ? c.input.slice(0, c.maxLen) : c.input;
      assert.ok(c.notContain!.some((f) => identity.includes(f)), `o caso "${c.name}" não detectaria um vazamento`);
    }
  });

  it('idempotente: redact(redact(x)) === redact(x) (o marcador não é re-mascarado em outra coisa)', () => {
    for (const c of CASES) {
      const once = withEnvKey(c.env, () => redact(c.input, c.extra ?? []));
      const twice = withEnvKey(c.env, () => redact(once, c.extra ?? []));
      assert.equal(twice, once, c.name);
    }
    assert.ok(REDACTED.length > 0);
  });
});

describe('Eventos de protocolo do worker não carregam texto de exceção (Fase 12, §2.6)', () => {
  it('todo "message" emitido por worker.py é um literal fixo (sem f-string, sem {exc}) — o único canal com exceção é o stderr', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'worker', 'worker.py'), 'utf-8');
    const lines = src.split('\n').filter((l) => /"message"\s*:/.test(l));
    assert.ok(lines.length >= 8, `esperava ≥8 emissões com "message", achei ${lines.length}`);
    for (const l of lines) {
      assert.match(l, /"message"\s*:\s*"[^"{}]*"/, `message não-literal: ${l.trim()}`);
      assert.ok(!/\bf"/.test(l.split('"message"')[1] ?? ''), `f-string em message: ${l.trim()}`);
    }
  });

  it('nenhum log_diag do worker imprime exceção bruta ({exc} / format_exc / str(exc)); tudo passa por safe_exc', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'worker', 'worker.py'), 'utf-8');
    assert.ok(!/\{exc\}/.test(src), '{exc} bruto em f-string');
    assert.ok(!/format_exc\(\)/.test(src), 'traceback.format_exc() imprime a mensagem sem máscara');
    assert.ok(!/\bstr\(exc\)\s*\[/.test(src), 'str(exc)[:N] trunca ANTES de mascarar');
    assert.ok(/safe_exc\(exc\)/.test(src));
  });
});
