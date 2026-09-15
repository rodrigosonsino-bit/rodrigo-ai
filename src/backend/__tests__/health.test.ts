import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../server.js';
import type { AppConfig, HealthResponse } from '../../shared/types.js';

describe('Endpoint de Saúde /api/health', () => {
  let server: http.Server;
  const testConfig: AppConfig = {
    port: 3999,
    host: '127.0.0.1',
    clientPort: 5173
  };

  before(async () => {
    server = await startServer(testConfig);
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('deve retornar 200 OK com campos estritos e sem segredos', async () => {
    const res = await fetch(`http://127.0.0.1:${testConfig.port}/api/health`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');

    const body = (await res.json()) as HealthResponse;
    // Validar formato estrito
    assert.deepEqual(body, {
      status: 'ok',
      version: '0.3.0'
    });

    // Validar ausência absoluta de campos adicionais, dados de ambiente ou segredos
    const keys = Object.keys(body);
    assert.equal(keys.length, 2);
    assert.equal(keys.includes('env'), false);
    assert.equal(keys.includes('process'), false);
    assert.equal(keys.includes('secrets'), false);
    assert.equal(keys.includes('paths'), false);
  });

  it('deve responder adequadamente a requisições HEAD', async () => {
    const res = await fetch(`http://127.0.0.1:${testConfig.port}/api/health`, {
      method: 'HEAD'
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, '');
  });

  it('deve rejeitar métodos não suportados (ex.: POST) com 405', async () => {
    const res = await fetch(`http://127.0.0.1:${testConfig.port}/api/health`, {
      method: 'POST'
    });

    assert.equal(res.status, 405);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'Método não permitido');
  });

  it('deve rejeitar requisições com Host não autorizado (localhost.evil, evil.localhost, 192.0.2.1) com 403', async () => {
    const testHosts = ['localhost.evil', 'evil.localhost', '192.0.2.1'];

    for (const host of testHosts) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: testConfig.port,
            path: '/api/health',
            method: 'GET',
            headers: {
              host
            }
          },
          (res) => {
            resolve(res.statusCode || 0);
          }
        );
        req.on('error', reject);
        req.end();
      });

      assert.equal(status, 403, `Host "${host}" deveria ter sido rejeitado com 403`);
    }
  });
});
