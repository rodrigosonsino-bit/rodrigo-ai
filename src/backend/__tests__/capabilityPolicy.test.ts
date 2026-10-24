import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';
import { CAPABILITIES, CapabilityPolicy, DEFAULT_CAPABILITY_POLICY, EFFECTIVE_GRANTS, type Capability } from '../agents/capabilityPolicy.js';
import { OgraSubAgent } from '../agents/ograSubAgent.js';
import { ToolSubAgent, SpecialistSubAgent } from '../agents/adapters.js';
import { OPENCLAW_CAPABILITIES } from '../agents/openClawCapabilities.js';
import { OpenClawSubAgent } from '../agents/openClawSubAgent.js';
import { createMutatingTools } from '../tools/index.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { SubAgentCoordinator, type ISubAgent, type SubAgentTaskRequest } from '../agents/subAgent.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager } from '../voice/sessionManager.js';

/**
 * T3: permissões por capacidade, negar por padrão. Para CADA capacidade, uma operação concreta tenta usá-la com um agente
 * que não a tem concedida, e o teste observa que `runTask` NÃO foi chamado. Coerência declaração x política efetiva com
 * prova de mutação.
 */
class Silent implements IVoiceProvider {
  readonly id = 'silent'; readonly name = 'silent';
  isAvailable(): boolean { return true; }
  async synthesize(_t: string, out: string): Promise<void> { await fs.promises.writeFile(out, Buffer.alloc(44)); }
}

describe('T3: capacidades tipadas, negar por padrão', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function setup(agent: ISubAgent, policy?: CapabilityPolicy): { sm: SessionManager; runs: SubAgentTaskRequest[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-')); dirs.push(dir);
    const coordinator = new SubAgentCoordinator();
    const runs: SubAgentTaskRequest[] = [];
    const wrapped: ISubAgent = { ...agent, runTask: async (req, signal) => { runs.push(req); return agent.runTask(req, signal); } };
    coordinator.register(wrapped);
    const sm = new SessionManager(new FakeVoiceEngine(), new Silent(), new AudioStore(dir), [], null, [], [], null, undefined, {}, null, coordinator);
    if (policy) sm.capabilityPolicy = policy;
    return { sm, runs };
  }
  const ok = (): Promise<{ success: true; output: string }> => Promise.resolve({ success: true, output: 'feito' });
  const delegate = (sm: SessionManager, id: string, extra: { needs?: readonly Capability[]; context?: Record<string, unknown> } = {}, turn = 't1') =>
    sm.runSubAgentDelegation({ turnId: turn, query: 'q', subAgentId: id, prompt: 'faça', isMutation: false, signal: new AbortController().signal, ...extra });

  for (const cap of CAPABILITIES) {
    it(`capacidade '${cap}': agente SEM a concessão é recusado e NÃO é invocado`, async () => {
      const agent: ISubAgent = { id: 'sem_grants', name: 'sem grants', capabilities: ['x'], runTask: ok };
      const { sm, runs } = setup(agent);
      const r = await delegate(sm, 'sem_grants', { needs: [cap] });
      assert.equal(r.ok, false);
      assert.match(r.result?.error ?? '', new RegExp(`Capacidade negada.*${cap}`));
      assert.equal(runs.length, 0, 'runTask não pode ter sido chamado');
    });
  }

  it("dado sensível declarado no contexto exige 'sensitive_data' (que ninguém recebe por padrão)", async () => {
    const agent: ISubAgent = { id: 'qualquer', name: 'q', capabilities: ['x'], runTask: ok };
    const { sm, runs } = setup(agent);
    const r = await delegate(sm, 'qualquer', { context: { dataClass: 'sensitive' } });
    assert.equal(r.ok, false); assert.equal(runs.length, 0);
    assert.match(r.result?.error ?? '', /sensitive_data/);
  });

  it('declarar a capacidade NÃO basta: sem política efetiva continua negado (interseção)', async () => {
    const agent: ISubAgent = { id: 'declara_so', name: 'd', capabilities: ['x'], grants: ['shell'], runTask: ok };
    const { sm, runs } = setup(agent);
    const r = await delegate(sm, 'declara_so', { needs: ['shell'] });
    assert.equal(r.ok, false); assert.equal(runs.length, 0);
  });

  it('com declaração E política efetiva a mesma operação passa e o agente é invocado (controle positivo)', async () => {
    const agent: ISubAgent = { id: 'liberado', name: 'l', capabilities: ['x'], grants: ['shell'], runTask: ok };
    const policy = new CapabilityPolicy({ liberado: ['shell'] }, {});
    const { sm, runs } = setup(agent, policy);
    const r = await delegate(sm, 'liberado', { needs: ['shell'] });
    assert.equal(r.ok, true); assert.equal(runs.length, 1);
  });

  it('o agente web exige rede implicitamente: concedida pela política, passa; com a tabela vazia, nem é invocado', async () => {
    const web: ISubAgent = { id: 'openclaw_web', name: 'web', capabilities: ['openclaw_web'], grants: ['network'], runTask: ok };
    const a = setup(web);
    assert.equal((await delegate(a.sm, 'openclaw_web')).ok, true);
    const b = setup(web, new CapabilityPolicy({}, { openclaw_web: ['network'] })); // mutação: removeu a concessão
    const r = await delegate(b.sm, 'openclaw_web');
    assert.equal(r.ok, false); assert.equal(b.runs.length, 0);
  });

  it('operação sem exigência alguma segue funcionando (a política só restringe o que for exigido)', async () => {
    const agent: ISubAgent = { id: 'tool_hora', name: 'h', capabilities: ['ferramenta'], runTask: ok };
    const { sm, runs } = setup(agent);
    assert.equal((await delegate(sm, 'tool_hora')).ok, true); assert.equal(runs.length, 1);
  });

  it('MUTAÇÃO exige write_file sem o chamador declarar: agente sem a concessão não é invocado (achado do Codex)', async () => {
    const agent: ISubAgent = { id: 'qualquer_mutador', name: 'm', capabilities: ['x'], runTask: ok };
    const { sm, runs } = setup(agent);
    const r = await sm.runSubAgentDelegation({ turnId: 'tm', query: 'q', subAgentId: 'qualquer_mutador', prompt: 'x', isMutation: true, signal: new AbortController().signal });
    assert.equal(r.ok, false); assert.equal(runs.length, 0);
    assert.match(r.result?.error ?? '', /write_file/);
  });

  it('a mesma ferramenta de LEITURA (isMutation=false) segue funcionando sem concessão', async () => {
    const agent: ISubAgent = { id: 'leitor', name: 'l', capabilities: ['x'], runTask: ok };
    const { sm, runs } = setup(agent);
    const r = await delegate(sm, 'leitor');
    assert.equal(r.ok, true); assert.equal(runs.length, 1);
  });

  describe('coerência entre a declaração no registro e a política efetiva', () => {
    const registered = (): ISubAgent[] => {
      const out: ISubAgent[] = OPENCLAW_CAPABILITIES.map((c) => new OpenClawSubAgent(c.id, c.name, [c.id]));
      for (const a of createSpecialistAgents()) out.push(new SpecialistSubAgent(a));
      out.push(new ToolSubAgent({ name: 'HoraAtualTool' } as never));
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-tools-')); dirs.push(dataDir);
      for (const t of createMutatingTools(dataDir).tools) out.push(new ToolSubAgent(t)); // LEMBRETE, NOTA, MEMORIA
      out.push(new OgraSubAgent({ webhook: { url: 'https://ogra.example/hook', key: 'k' }, catalog: () => [] }));
      return out;
    };

    it('os agentes reais declaram exatamente o que a política efetiva concede', () => {
      assert.deepEqual(DEFAULT_CAPABILITY_POLICY.coherenceErrors(registered()), []);
      assert.ok(registered().length >= 8);
    });

    it('mutação 1: declarar uma capacidade a mais sem política efetiva reprova', () => {
      const agents = registered().map((a) => (a.id === 'openclaw_web' ? ({ ...a, grants: ['network', 'shell'] } as ISubAgent) : a));
      const errs = DEFAULT_CAPABILITY_POLICY.coherenceErrors(agents);
      assert.equal(errs.length, 1); assert.match(errs[0], /openclaw_web declara 'shell' sem política efetiva/);
    });

    it('mutação 2: remover uma concessão da política efetiva (deny) reprova', () => {
      const weaker = new CapabilityPolicy({ ...EFFECTIVE_GRANTS, openclaw_web: [] });
      const errs = weaker.coherenceErrors(registered());
      assert.ok(errs.some((e) => /openclaw_web declara 'network' sem política efetiva/.test(e)));
    });

    it('nenhum agente real recebe sensitive_data, shell ou browser; write_file só as 3 ferramentas que mutam', () => {
      for (const a of registered()) {
        const have = DEFAULT_CAPABILITY_POLICY.granted(a);
        for (const c of ['sensitive_data', 'shell', 'browser'] as const) assert.equal(have.has(c), false, `${a.id} não deveria ter ${c}`);
        assert.equal(have.has('write_file'), ['tool_lembrete', 'tool_nota', 'tool_memoria'].includes(a.id), `${a.id}: write_file`);
      }
    });
  });
});
