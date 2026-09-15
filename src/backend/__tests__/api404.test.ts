import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../server.js';
import type { AppConfig } from '../../shared/types.js';

describe('Rotas 404 da API', () => {
  let server: http.Server;
  const testConfig: AppConfig = {
    port: 3998,
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

  it('deve retornar JSON 404 e NUNCA retornar HTML para endpoints /api/*', async () => {
    const res = await fetch(`http://127.0.0.1:${testConfig.port}/api/rota-inexistente`, {
      headers: {
        Host: `127.0.0.1:${testConfig.port}`,
        Accept: 'text/html,application/json'
      }
    });

    assert.equal(res.status, 404);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');

    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'Rota de API não encontrada.');
  });
});
