import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runDoctor, formatDoctorReport, voiceRuntimePaths, variableNameOnly, type DoctorReport } from '../doctor.js';
import { startServer } from '../server.js';
import type { AppConfig } from '../../shared/types.js';

const ROOT = '/projeto-de-teste';
const ALL_EXIST = () => true;
const NONE_EXIST = () => false;
const FIXED_NOW = () => new Date('2026-10-13T12:00:00.000Z');

function doctor(env: Record<string, string | undefined>, exists = ALL_EXIST): DoctorReport {
  return runDoctor({ env, rootDir: ROOT, exists, now: FIXED_NOW });
}
function byId(r: DoctorReport, id: string) {
  return r.checks.find((c) => c.id === id);
}

describe('doctor (T5a): cada verificação tem um caso de sucesso e um de falha', () => {
  it('privacy-config: ok com padrões; erro com valor inválido, citando só o NOME da variável', () => {
    assert.equal(byId(doctor({}), 'privacy-config')?.severity, 'ok');
    const bad = byId(doctor({ RODRIGO_CLOUD: 'talvez-isto-seja-um-segredo-123' }), 'privacy-config');
    assert.equal(bad?.severity, 'error');
    assert.match(bad!.detail, /RODRIGO_CLOUD/);
    assert.doesNotMatch(bad!.detail, /talvez-isto-seja-um-segredo-123/, 'o valor recebido nunca entra no relatório');
  });

  it('ports: ok; erro para porta inválida, portas iguais e host fora do loopback', () => {
    assert.equal(byId(doctor({}), 'ports')?.severity, 'ok');
    assert.equal(byId(doctor({ PORT: '3000abc' }), 'ports')?.severity, 'error');
    assert.equal(byId(doctor({ PORT: '4000', CLIENT_PORT: '4000' }), 'ports')?.severity, 'error');
    const host = byId(doctor({ HOST: '0.0.0.0' }), 'ports');
    assert.equal(host?.severity, 'error');
    assert.doesNotMatch(host!.detail, /0\.0\.0\.0/);
  });

  it('voice-runtime: ok quando os três caminhos existem; aviso listando o que falta; info quando desabilitado', () => {
    assert.equal(byId(doctor({}, ALL_EXIST), 'voice-runtime')?.severity, 'ok');
    const missing = byId(doctor({}, NONE_EXIST), 'voice-runtime');
    assert.equal(missing?.severity, 'warn');
    for (const name of Object.keys(voiceRuntimePaths(ROOT))) assert.match(missing!.detail, new RegExp(name));
    assert.equal(byId(doctor({ RODRIGO_VOICE_DISABLE: '1' }, NONE_EXIST), 'voice-runtime')?.severity, 'info');
  });

  it('cloud-master: ok com RODRIGO_CLOUD=0; aviso sem chave; info com chave', () => {
    assert.equal(byId(doctor({ RODRIGO_CLOUD: '0' }), 'cloud-master')?.severity, 'ok');
    assert.equal(byId(doctor({}), 'cloud-master')?.severity, 'warn');
    assert.equal(byId(doctor({ GEMINI_API_KEY: 'k' }), 'cloud-master')?.severity, 'info');
    assert.equal(byId(doctor({ GEMINI_API_KEY: '   ' }), 'cloud-master')?.severity, 'warn', 'chave em branco não conta como presente');
  });

  it('cloud-channels: lista os canais declarados; some com o mestre desligado', () => {
    const on = byId(doctor({ GEMINI_API_KEY: 'k' }), 'cloud-channels');
    assert.match(on!.detail, /intenção/);
    assert.match(on!.detail, /histórico/);
    assert.match(on!.detail, /visão/);
    assert.equal(byId(doctor({ RODRIGO_CLOUD: '0' }), 'cloud-channels'), undefined);
  });

  it('risk-history-memories: aviso com ambos ligados; some se um deles é desligado', () => {
    assert.equal(byId(doctor({}), 'risk-history-memories')?.severity, 'warn');
    assert.equal(byId(doctor({ RODRIGO_SEND_MEMORIES: '0' }), 'risk-history-memories'), undefined);
    assert.equal(byId(doctor({ RODRIGO_SEND_HISTORY: '0' }), 'risk-history-memories'), undefined);
    assert.equal(byId(doctor({ RODRIGO_CLOUD: '0' }), 'risk-history-memories'), undefined);
  });

  it('risk-knowledge, risk-vision, risk-web-search, risk-tts-dictated: aparecem só quando o canal está efetivamente ligado', () => {
    assert.equal(byId(doctor({}), 'risk-knowledge'), undefined, 'conhecimento é padrão 0');
    assert.equal(byId(doctor({ RODRIGO_SEND_KNOWLEDGE: '1' }), 'risk-knowledge')?.severity, 'warn');
    assert.equal(byId(doctor({}), 'risk-vision')?.severity, 'warn', 'visão é padrão ligado hoje (a decisão 10 muda isso na T1)');
    assert.equal(byId(doctor({ RODRIGO_CLOUD_VISION: '0' }), 'risk-vision'), undefined);
    assert.equal(byId(doctor({}), 'risk-web-search'), undefined, 'busca web é padrão 0');
    assert.equal(byId(doctor({ RODRIGO_WEB_SEARCH: '1' }), 'risk-web-search')?.severity, 'warn');
    assert.equal(byId(doctor({}), 'risk-tts-dictated')?.severity, 'warn');
    assert.equal(byId(doctor({ RODRIGO_TTS_DICTATED: '0' }), 'risk-tts-dictated'), undefined);
  });

  it('resumo conta as gravidades e o relatório é determinístico com relógio injetado', () => {
    const r = doctor({ RODRIGO_CLOUD: 'x' });
    assert.equal(r.generatedAt, '2026-10-13T12:00:00.000Z');
    assert.equal(r.version, 1);
    const total = Object.values(r.summary).reduce((a, b) => a + b, 0);
    assert.equal(total, r.checks.length);
    assert.ok(r.summary.error >= 1);
  });

  it('variableNameOnly extrai só o nome da variável', () => {
    assert.equal(variableNameOnly('Configuração inválida: RODRIGO_CLOUD deve ser "0" ou "1". Valor recebido: "abc"'), 'RODRIGO_CLOUD');
    assert.equal(variableNameOnly('sem nome'), 'variável desconhecida');
  });
});

describe('doctor (T5a): o relatório nunca contém segredo nem texto do usuário', () => {
  const KEY = 'AIzaSyD-MARCADOR-DE-CHAVE-FALSA-0123456789';
  const TEXT = 'MARCADOR-TEXTO-DO-USUARIO-nao-pode-aparecer';
  const env = {
    GEMINI_API_KEY: KEY,
    SAY_VOICE: TEXT,
    RODRIGO_DATA_DIR: `/tmp/${TEXT}`,
    RODRIGO_HISTORY_TURNS: '3'
  };

  it('com a chave e valores de ambiente presentes, nenhum valor aparece no JSON nem no texto do terminal', () => {
    const r = doctor(env);
    const json = JSON.stringify(r);
    const text = formatDoctorReport(r);
    for (const blob of [json, text]) {
      assert.equal(blob.includes(KEY), false, 'a chave não pode aparecer');
      assert.equal(blob.includes('MARCADOR'), false, 'valores de ambiente/texto do usuário não podem aparecer');
    }
    assert.equal(byId(r, 'cloud-master')?.severity, 'info', 'controle positivo: o doctor DETECTOU a chave sem exibi-la');
  });

  it('controle positivo do teste: um relatório que ecoasse o ambiente seria pego pela mesma checagem', () => {
    const vazando = JSON.stringify({ env });
    assert.equal(vazando.includes(KEY), true);
  });
});

describe('GET /api/doctor (T5a)', () => {
  const testConfig: AppConfig = { port: 3987, clientPort: 5987, host: '127.0.0.1' };
  let server: http.Server;
  const base = `http://127.0.0.1:${testConfig.port}`;

  before(async () => {
    server = await startServer(testConfig);
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET devolve 200 com JSON do relatório e cabeçalhos sem cache', async () => {
    const res = await fetch(`${base}/api/doctor`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    const body = (await res.json()) as DoctorReport;
    assert.equal(body.version, 1);
    assert.ok(Array.isArray(body.checks) && body.checks.length >= 3);
  });

  it('POST é recusado com 405', async () => {
    const res = await fetch(`${base}/api/doctor`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  it('Host fora da lista é recusado com 403 (mesma validação dos demais endpoints)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: testConfig.port, path: '/api/doctor', headers: { Host: 'evil.example.com' } },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});
