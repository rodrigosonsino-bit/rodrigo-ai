import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DEFAULT_PRIVACY, GENERATION_DISABLED_TEXT } from '../privacy.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';
import {
  HAVE_VENV, RecordingProxy, installTcpGuard, startEgressHarness, type EgressHarness, type EgressSession
} from './helpers/egress.js';

/**
 * Fase 12, H12.3 (docs/phase-12-v2.md §4): com RODRIGO_CLOUD=0, 50 tarefas locais funcionam e há ZERO TENTATIVAS
 * de conexão externa — medidas no worker Python (proxy de rede em loopback via HTTP(S)_PROXY, que recusa e conta) E
 * no servidor Node (guarda em net.Socket.connect, que enxerga fetch/http/https/tls; o fetch do Node IGNORA HTTP_PROXY,
 * por isso o proxy sozinho não bastaria). Bloquear a rede sem registrar mascararia as tentativas.
 */
const skip = !HAVE_VENV && 'venv do worker (.runtime/.venv) ausente';

async function mutation(h: EgressHarness, s: EgressSession, kind: string, content: string, ask: string): Promise<string> {
  h.engine.mutationToReturn = [kind as never, content];
  const q = await h.say(s, ask);
  assert.equal(q.spoken.length, 1, `pergunta de confirmação esperada: ${JSON.stringify(q.spoken)}`);
  await h.played(s, q.turnId, q.spoken[0]);
  h.engine.mutationToReturn = ['NENHUMA', null];
  const done = await h.say(s, 'sim, pode fazer');
  return done.spoken.join(' ');
}

describe('H12.3 — 50 tarefas locais com RODRIGO_CLOUD=0: zero tentativas externas', { skip }, () => {
  it('50 tarefas funcionam; ZERO requisições ao Gemini, ZERO no proxy do worker, ZERO conexões não-loopback no Node', async () => {
    const proxy = new RecordingProxy();
    await proxy.start();
    const guard = installTcpGuard();
    const h = await startEgressHarness({
      privacy: { ...DEFAULT_PRIVACY, cloud: false },
      systemTools: true,
      mutating: true,
      workerEnv: { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url }
    });
    try {
      const s = await h.newSession();
      let tasks = 0;

      for (let i = 1; i <= 10; i++) {
        h.engine.toolToReturn = 'HORA';
        const r = await h.say(s, `que horas são agora ${i}`);
        assert.match(r.spoken.join(' '), /\d/, `hora: ${JSON.stringify(r.spoken)}`);
        tasks++;
      }
      for (let i = 1; i <= 10; i++) {
        h.engine.toolToReturn = 'DATA';
        const r = await h.say(s, `que dia é hoje ${i}`);
        assert.match(r.spoken.join(' '), /outubro/i, `data: ${JSON.stringify(r.spoken)}`);
        tasks++;
      }
      h.engine.toolToReturn = 'NENHUMA';
      for (let i = 1; i <= 10; i++) {
        const said = await mutation(h, s, 'LEMBRETE_CRIAR', `ligar pro dentista ${i}`, `Lembrete: ligar pro dentista ${i}`);
        assert.match(said, /riado|riei|alvei|notei/i, `lembrete ${i}: ${said}`);
        tasks++;
      }
      for (let i = 1; i <= 10; i++) {
        await mutation(h, s, 'NOTA_CRIAR', `ideia número ${i}`, `Anota uma nota: ideia número ${i}`);
        tasks++;
      }
      for (let i = 1; i <= 10; i++) {
        await mutation(h, s, 'MEMORIA_GUARDAR', `gosto de café ${i}`, `Guarda isso na memória: gosto de café ${i}`);
        tasks++;
      }
      assert.equal(tasks, 50);

      // as tarefas realmente FIZERAM o que prometem (não foi "zero porque nada rodou")
      assert.equal(new JsonStore<StoredItem>(h.dataDir, 'lembretes.json').read().items.length, 10);
      assert.equal(new JsonStore<StoredItem>(h.dataDir, 'notas.json').read().items.length, 10);
      assert.equal(new JsonStore<StoredItem>(h.dataDir, 'memorias.json').read().items.length, 10);

      // o que EXIGE geração em nuvem é dito com clareza, sem tentar a nuvem e sem outro provedor
      for (let i = 1; i <= 5; i++) {
        const r = await h.say(s, `conta uma curiosidade número ${i}`);
        assert.ok(r.spoken.includes(GENERATION_DISABLED_TEXT), JSON.stringify(r.spoken));
      }
      s.close();

      assert.equal(h.gemini.requests.length, 0, `o Gemini falso recebeu ${h.gemini.requests.length} requisição(ões)`);
      assert.deepEqual(proxy.seen, [], `o proxy do worker viu tentativas: ${JSON.stringify(proxy.seen)}`);
      assert.deepEqual(guard.nonLoopback, [], `o Node tentou conexões externas: ${JSON.stringify(guard.nonLoopback)}`);
      assert.ok(guard.attempts.length > 0, 'a guarda do Node funciona (viu as conexões de loopback do próprio teste)');
    } finally {
      guard.restore();
      await h.stop();
      await proxy.stop();
    }
  });

  it('CONTROLE POSITIVO (worker): com a nuvem LIGADA e as mesmas variáveis de proxy, o proxy VÊ a tentativa — a medição pode falhar', async () => {
    const proxy = new RecordingProxy();
    await proxy.start();
    const h = await startEgressHarness({
      privacy: DEFAULT_PRIVACY,
      workerEnv: { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url }
    });
    try {
      const s = await h.newSession();
      await h.say(s, 'conta uma curiosidade');
      s.close();
      assert.ok(proxy.seen.length >= 1, `o proxy deveria ver a tentativa do worker; viu ${JSON.stringify(proxy.seen)}`);
    } finally {
      await h.stop();
      await proxy.stop();
    }
  });

  it('CONTROLE POSITIVO (Node): a guarda registra e bloqueia uma conexão fora do loopback — por net.connect E pelo fetch (o caminho real do app)', async () => {
    const guard = installTcpGuard();
    try {
      assert.throws(() => net.connect({ host: '93.184.216.34', port: 80 }), /egress guard/);
      assert.deepEqual(guard.nonLoopback, ['93.184.216.34:80']);
      await assert.rejects(fetch('http://93.184.216.35:81/'));
      assert.ok(guard.nonLoopback.includes('93.184.216.35:81'), `o fetch deveria ter sido visto: ${JSON.stringify(guard.nonLoopback)}`);
    } finally {
      guard.restore();
    }
  });
});
