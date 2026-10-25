import net from 'node:net';

/**
 * Porta livre pedida ao sistema operacional. Os testes que subiam servidor usavam `Math.random()` em faixas fixas que se
 * SOBREPÕEM entre arquivos (20000-25000, 25000-29000, 26000-28000, 28000-33000, 29000-29900, 29900-29990), e `node --test`
 * roda os arquivos em paralelo: duas suítes caíam na mesma porta de vez em quando (ECONNRESET intermitente).
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
