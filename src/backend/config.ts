import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../shared/types.js';

/**
 * Carregador leve e seguro de arquivo .env sem dependências externas.
 * Carrega variáveis apenas se não estiverem previamente definidas em process.env.
 */
export function loadDotEnv(envPath?: string): void {
  const targetPath = envPath || path.resolve(process.cwd(), '.env');
  if (fs.existsSync(targetPath)) {
    try {
      const content = fs.readFileSync(targetPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (!(key in process.env) && key.length > 0) {
            process.env[key] = val;
          }
        }
      }
    } catch {
      // Falhas de leitura do .env são toleradas
    }
  }
}

export function validatePort(value: unknown, paramName: string, defaultPort: number): number {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return defaultPort;
  }

  const str = String(value).trim();
  // Validar estritamente apenas dígitos decimais (rejeita 3000abc, 3.5, números negativos, texto)
  if (!/^\d+$/.test(str)) {
    throw new Error(
      `Configuração inválida: ${paramName} deve ser um número inteiro positivo entre 1 e 65535. Valor recebido: "${value}"`
    );
  }

  const port = parseInt(str, 10);
  if (port < 1 || port > 65535) {
    throw new Error(
      `Configuração inválida: ${paramName} deve ser um número inteiro positivo entre 1 e 65535. Valor recebido: "${value}"`
    );
  }

  return port;
}

export function validateHost(value: unknown, defaultHost = '127.0.0.1'): string {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return defaultHost;
  }

  const trimmed = String(value).trim().toLowerCase();
  if (trimmed !== '127.0.0.1' && trimmed !== 'localhost') {
    throw new Error(
      `Configuração inválida: HOST deve ser exclusivamente um endereço de loopback (127.0.0.1 ou localhost). Valor recebido: "${value}"`
    );
  }

  return trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotEnv();

  const port = validatePort(env.PORT, 'PORT', 3000);
  const host = validateHost(env.HOST, '127.0.0.1');
  const clientPort = validatePort(env.CLIENT_PORT, 'CLIENT_PORT', 5173);

  if (port === clientPort) {
    throw new Error(
      `Configuração inválida: PORT (${port}) e CLIENT_PORT (${clientPort}) devem ser portas distintas para evitar conflito entre API e cliente.`
    );
  }

  return {
    port,
    host,
    clientPort
  };
}
