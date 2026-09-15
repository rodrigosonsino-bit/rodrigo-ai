import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePort, validateHost, loadConfig, loadDotEnv } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Validação Estrita de Configuração e Portas', () => {
  it('deve usar portas padrão quando não informadas', () => {
    const config = loadConfig({});
    assert.equal(config.port, 3000);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.clientPort, 5173);
  });

  it('deve aceitar valores inteiros válidos de porta', () => {
    assert.equal(validatePort('8080', 'PORT', 3000), 8080);
    assert.equal(validatePort('1', 'PORT', 3000), 1);
    assert.equal(validatePort('65535', 'PORT', 3000), 65535);
  });

  it('deve rejeitar texto e caracteres alfanuméricos em portas (ex: 3000abc)', () => {
    assert.throws(
      () => validatePort('3000abc', 'PORT', 3000),
      /Configuração inválida: PORT deve ser um número inteiro positivo/
    );
    assert.throws(
      () => validatePort('abc', 'PORT', 3000),
      /Configuração inválida: PORT deve ser um número inteiro positivo/
    );
  });

  it('deve rejeitar números decimais em portas (ex: 3.5)', () => {
    assert.throws(
      () => validatePort('3.5', 'PORT', 3000),
      /Configuração inválida: PORT deve ser um número inteiro positivo/
    );
    assert.throws(
      () => validatePort('3000.0', 'PORT', 3000),
      /Configuração inválida: PORT deve ser um número inteiro positivo/
    );
  });

  it('deve rejeitar porta zero (0) e números negativos', () => {
    assert.throws(
      () => validatePort('0', 'PORT', 3000),
      /Configuração inválida: PORT deve ser um número inteiro positivo/
    );
    assert.throws(
      () => validatePort('-1', 'PORT', 3000),
      /Configuração inválida: PORT deve ser um número inteiro positivo/
    );
  });

  it('deve rejeitar portas maiores que 65535', () => {
    assert.throws(
      () => validatePort('65536', 'PORT', 3000),
      /Configuração inválida: PORT deve ser um número inteiro positivo/
    );
    assert.throws(
      () => validatePort('99999', 'PORT', 3000),
      /Configuração inválida: PORT deve ser um número inteiro positivo/
    );
  });

  it('deve rejeitar quando PORT e CLIENT_PORT forem idênticos', () => {
    assert.throws(
      () => loadConfig({ PORT: '4000', CLIENT_PORT: '4000' } as any),
      /devem ser portas distintas/
    );
  });

  it('deve aceitar apenas 127.0.0.1 ou localhost para HOST', () => {
    assert.equal(validateHost('127.0.0.1'), '127.0.0.1');
    assert.equal(validateHost('localhost'), 'localhost');

    assert.throws(
      () => validateHost('0.0.0.0'),
      /Configuração inválida: HOST deve ser exclusivamente um endereço de loopback/
    );
    assert.throws(
      () => validateHost('192.168.1.100'),
      /Configuração inválida: HOST deve ser exclusivamente um endereço de loopback/
    );
    assert.throws(
      () => validateHost('evil.com'),
      /Configuração inválida: HOST deve ser exclusivamente um endereço de loopback/
    );
  });

  it('deve carregar variáveis do arquivo .env quando presente', () => {
    const tempEnvPath = path.resolve(process.cwd(), '.env.test-temp');
    fs.writeFileSync(tempEnvPath, 'TEST_ENV_VAR=valor_teste\n# comentario\nANOTHER_VAR=42\n');

    loadDotEnv(tempEnvPath);

    assert.equal(process.env.TEST_ENV_VAR, 'valor_teste');
    assert.equal(process.env.ANOTHER_VAR, '42');

    fs.unlinkSync(tempEnvPath);
    delete process.env.TEST_ENV_VAR;
    delete process.env.ANOTHER_VAR;
  });
});
