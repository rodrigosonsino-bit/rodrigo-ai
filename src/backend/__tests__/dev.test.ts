import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

function checkPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => {
      s.close(() => resolve(true));
    });
    s.listen(port, host);
  });
}

describe('Comportamento do Script de Desenvolvimento scripts/dev.mjs', () => {
  it('deve falhar imediatamente com código de erro ao receber porta com texto ou decimal', async () => {
    const runCheck = (envOverrides: Record<string, string>) => {
      return new Promise<{ code: number | null; output: string }>((resolve) => {
        let output = '';
        const proc = spawn(process.execPath, ['scripts/dev.mjs'], {
          env: { ...process.env, RODRIGO_VOICE_DISABLE: '1', ...envOverrides }
        });
        proc.stdout.on('data', (d) => (output += d.toString()));
        proc.stderr.on('data', (d) => (output += d.toString()));
        proc.on('exit', (code) => {
          resolve({ code, output });
        });
      });
    };

    const res1 = await runCheck({ PORT: '3000abc' });
    assert.equal(res1.code, 1);
    assert.match(res1.output, /Configuração inválida: PORT/);

    const res2 = await runCheck({ CLIENT_PORT: '5.5' });
    assert.equal(res2.code, 1);
    assert.match(res2.output, /Configuração inválida: CLIENT_PORT/);

    const res3 = await runCheck({ PORT: '4000', CLIENT_PORT: '4000' });
    assert.equal(res3.code, 1);
    assert.match(res3.output, /devem ser portas distintas/);
  });

  it('deve falhar imediatamente se a porta já estiver ocupada', async () => {
    const testPort = 4444;
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(testPort, '127.0.0.1', resolve));

    try {
      const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve) => {
        let output = '';
        const proc = spawn(process.execPath, ['scripts/dev.mjs'], {
          env: { ...process.env, RODRIGO_VOICE_DISABLE: '1', PORT: String(testPort), CLIENT_PORT: '5555' }
        });
        proc.stdout.on('data', (d) => (output += d.toString()));
        proc.stderr.on('data', (d) => (output += d.toString()));
        proc.on('exit', (c) => resolve({ code: c, output }));
      });

      assert.equal(code, 1);
      assert.match(output, /Erro de porta: A porta 4444 já está ocupada/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('deve liberar todas as portas sem deixar órfãos ao receber SIGTERM', async () => {
    const devPort = 4880;
    const clientPort = 4881;

    const proc = spawn(process.execPath, ['scripts/dev.mjs'], {
      env: { ...process.env, RODRIGO_VOICE_DISABLE: '1', PORT: String(devPort), CLIENT_PORT: String(clientPort) }
    });

    // Aguardar o servidor iniciar
    let started = false;
    await new Promise<void>((resolve) => {
      proc.stdout.on('data', (d) => {
        const str = d.toString();
        if (str.includes('Servidor ouvindo') || str.includes('Local:')) {
          started = true;
          resolve();
        }
      });
      setTimeout(resolve, 3000); // timeout de segurança
    });

    // Enviar SIGTERM ao processo coordenador dev
    proc.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      proc.on('exit', () => resolve());
    });

    // Aguardar liberação completa dos sockets
    await new Promise((r) => setTimeout(r, 600));

    const backendFree = await checkPortFree(devPort);
    const clientFree = await checkPortFree(clientPort);

    assert.equal(backendFree, true, 'Porta do backend deve estar livre após SIGTERM');
    assert.equal(clientFree, true, 'Porta do cliente deve estar livre após SIGTERM');
  });
});
