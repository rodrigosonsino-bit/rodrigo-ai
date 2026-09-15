import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedHost } from '../hostValidator.js';

describe('Validação Estrita de Host Header', () => {
  const allowedPorts = [3000, 5173];

  it('deve aceitar localhost e 127.0.0.1 com portas permitidas', () => {
    assert.equal(isAllowedHost('localhost:3000', allowedPorts), true);
    assert.equal(isAllowedHost('127.0.0.1:3000', allowedPorts), true);
    assert.equal(isAllowedHost('localhost:5173', allowedPorts), true);
    assert.equal(isAllowedHost('127.0.0.1:5173', allowedPorts), true);
    assert.equal(isAllowedHost('localhost', allowedPorts), true);
    assert.equal(isAllowedHost('127.0.0.1', allowedPorts), true);
  });

  it('deve rejeitar categoricamente localhost.evil, evil.localhost, 192.0.2.1 e similares', () => {
    assert.equal(isAllowedHost('localhost.evil', allowedPorts), false);
    assert.equal(isAllowedHost('localhost.evil:3000', allowedPorts), false);
    assert.equal(isAllowedHost('evil.localhost', allowedPorts), false);
    assert.equal(isAllowedHost('evil.localhost:3000', allowedPorts), false);
    assert.equal(isAllowedHost('evil.localhost:5173', allowedPorts), false);
    assert.equal(isAllowedHost('192.0.2.1', allowedPorts), false);
    assert.equal(isAllowedHost('192.0.2.1:3000', allowedPorts), false);
    assert.equal(isAllowedHost('attacker.com', allowedPorts), false);
    assert.equal(isAllowedHost('127.0.0.1.nip.io', allowedPorts), false);
    assert.equal(isAllowedHost('0.0.0.0', allowedPorts), false);
  });

  it('deve rejeitar requisições com portas não autorizadas', () => {
    assert.equal(isAllowedHost('localhost:8080', allowedPorts), false);
    assert.equal(isAllowedHost('127.0.0.1:9999', allowedPorts), false);
  });

  it('deve rejeitar cabeçalhos inválidos ou vazios', () => {
    assert.equal(isAllowedHost(undefined, allowedPorts), false);
    assert.equal(isAllowedHost('', allowedPorts), false);
    assert.equal(isAllowedHost('   ', allowedPorts), false);
  });
});
