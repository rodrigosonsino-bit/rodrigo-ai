import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENERATION_DISABLED_TEXT, DEFAULT_PRIVACY, type PrivacyConfig } from '../privacy.js';
import { GENERATION_FAILURE_TEXT } from '../../shared/voiceProtocol.js';
import { HAVE_VENV, REAL_LOOKING_KEY, startEgressHarness, type EgressHarness, type RecordedRequest } from './helpers/egress.js';

/**
 * Fase 12, H12.2 (docs/phase-12-v2.md §4): o que REALMENTE sai ao Gemini, medido num Gemini FALSO em loopback.
 * Cadeia real: SessionManager -> MlxWorkerEngine -> worker.py (google-genai) -> fake. 7 cenários x 15 turnos = 105.
 * O GABARITO é escrito à mão por cenário e é independente de effectivePrivacy()/da própria configuração.
 */
const skip = !HAVE_VENV && 'venv do worker (.runtime/.venv) ausente';
const MEM = 'MARCADOR-MEMORIA-5521';
const KNOW = 'MARCADOR-PESQUISA-8830';
const KNOW_MD = `## 1. Exegese histórico-gramatical\nO método histórico-gramatical situa o texto no judaísmo do Segundo Templo antes de qualquer aplicação. ${KNOW}\n`;
const TEO_QUERY = 'explique o método histórico-gramatical do Segundo Templo';
const TURNS = 15;

interface Gen { system: string; users: string[]; roles: string[]; raw: string }
function parseGen(r: RecordedRequest): Gen {
  const b = JSON.parse(r.body) as { systemInstruction?: { parts: Array<{ text: string }> }; contents: Array<{ role: string; parts: Array<{ text: string }> }> };
  return {
    system: b.systemInstruction?.parts.map((p) => p.text).join('\n') ?? '',
    users: b.contents.filter((c) => c.role === 'user').map((c) => c.parts.map((p) => p.text).join('\n')),
    roles: b.contents.map((c) => c.role),
    raw: r.body
  };
}

/** Texto da fala do turno t do cenário s. Turnos 5, 10 e 15 são "temporais" (acionam a classificação de intenção). */
const fala = (s: string, t: number): string => `${t % 5 === 0 ? 'que horas são agora' : TEO_QUERY} MARCADOR-FALA-${s}-${String(t).padStart(2, '0')}`;

interface Scenario {
  name: string;
  privacy: PrivacyConfig;
  /** gabarito escrito à mão */
  expect: {
    genRequests: number;
    intentRequests: number;
    memoryInSystem: boolean;
    knowledgeInSystem: boolean;
    /** quantas falas ANTERIORES (marcadores) aparecem na requisição do turno k (k>=1) */
    previousUserMessages: (k: number) => number;
  };
}

const D = DEFAULT_PRIVACY;
const SCENARIOS: Scenario[] = [
  { name: 'A padrão de produção (trecho de pesquisa desligado — D1)', privacy: D,
    expect: { genRequests: 15, intentRequests: 3, memoryInSystem: true, knowledgeInSystem: false, previousUserMessages: (k) => Math.min(k - 1, 15) } },
  { name: 'B memórias desligadas', privacy: { ...D, sendMemories: false },
    expect: { genRequests: 15, intentRequests: 3, memoryInSystem: false, knowledgeInSystem: false, previousUserMessages: (k) => Math.min(k - 1, 15) } },
  { name: 'C trecho de pesquisa LIGADO (controle positivo de A)', privacy: { ...D, sendKnowledge: true },
    expect: { genRequests: 15, intentRequests: 3, memoryInSystem: true, knowledgeInSystem: true, previousUserMessages: (k) => Math.min(k - 1, 15) } },
  { name: 'D histórico desligado', privacy: { ...D, sendHistory: false },
    expect: { genRequests: 15, intentRequests: 3, memoryInSystem: true, knowledgeInSystem: false, previousUserMessages: () => 0 } },
  { name: 'E janela de 2 turnos (4 mensagens: a atual + 3 anteriores)', privacy: { ...D, historyTurns: 2 },
    expect: { genRequests: 15, intentRequests: 3, memoryInSystem: true, knowledgeInSystem: false, previousUserMessages: (k) => Math.min(k - 1, 3) } },
  { name: 'F intenção em nuvem desligada (a geração continua)', privacy: { ...D, cloudIntent: false },
    expect: { genRequests: 15, intentRequests: 0, memoryInSystem: true, knowledgeInSystem: false, previousUserMessages: (k) => Math.min(k - 1, 15) } },
  { name: 'G mestre RODRIGO_CLOUD=0: nada sai', privacy: { ...D, cloud: false },
    expect: { genRequests: 0, intentRequests: 0, memoryInSystem: false, knowledgeInSystem: false, previousUserMessages: () => 0 } }
];

const everyRequest: RecordedRequest[] = [];
let totalTurns = 0;

describe('H12.2 — o que realmente sai (Gemini falso em loopback, worker Python real)', { skip }, () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: ${TURNS} turnos`, async () => {
      const h: EgressHarness = await startEgressHarness({
        privacy: sc.privacy,
        withKnowledge: KNOW_MD,
        memories: [MEM],
        systemTools: true,
        mutating: true
      });
      try {
        h.gemini.intent = { intent: 'NENHUMA', content: null };
        const s = await h.newSession();
        const letter = sc.name[0];
        for (let t = 1; t <= TURNS; t++) {
          const r = await h.say(s, fala(letter, t), 'TEOLOGIA');
          totalTurns += 1;
          assert.ok(r.turnId.length > 0);
          if (!sc.privacy.cloud) assert.ok(r.spoken.includes(GENERATION_DISABLED_TEXT), `turno ${t}: deveria avisar que a geração está desligada: ${JSON.stringify(r.spoken)}`);
        }
        s.close();

        const gens = h.gemini.streamRequests();
        const intents = h.gemini.intentRequests();
        everyRequest.push(...h.gemini.requests);
        assert.equal(gens.length, sc.expect.genRequests, 'nº de requisições de geração');
        assert.equal(intents.length, sc.expect.intentRequests, 'nº de requisições de intenção');
        assert.equal(h.gemini.requests.length, sc.expect.genRequests + sc.expect.intentRequests, 'nenhuma requisição além das esperadas');

        gens.forEach((req, idx) => {
          const k = idx + 1;
          const g = parseGen(req);
          assert.equal(g.system.includes(MEM), sc.expect.memoryInSystem, `turno ${k}: memória no prompt`);
          assert.equal(g.system.includes(KNOW), sc.expect.knowledgeInSystem, `turno ${k}: trecho de pesquisa no prompt`);
          // a fala atual SEMPRE vai (é a pergunta); o histórico depende do controle
          assert.ok(g.users[g.users.length - 1].includes(`MARCADOR-FALA-${sc.name[0]}-${String(k).padStart(2, '0')}`), `turno ${k}: fala atual`);
          // conta FALAS (marcadores), não mensagens: o worker junta mensagens consecutivas do mesmo papel numa só
          const previous = (g.users.join('\n').match(/MARCADOR-FALA/g) ?? []).length - 1;
          assert.equal(previous, sc.expect.previousUserMessages(k), `turno ${k}: nº de falas anteriores enviadas`);
          if (previous > 0) assert.ok(g.users.some((u) => u.includes(`MARCADOR-FALA-${sc.name[0]}-${String(k - 1).padStart(2, '0')}`)), `turno ${k}: o turno imediatamente anterior deve estar presente`);
          if (k > 4 && sc.expect.previousUserMessages(k) <= 3) {
            assert.ok(!g.raw.includes(`MARCADOR-FALA-${sc.name[0]}-01`), `turno ${k}: o turno 1 já saiu da janela`);
          }
        });

        // intenção: SÓ o texto da fala atual, no formato fixo — nunca histórico, memória, trecho ou outra fala
        intents.forEach((req) => {
          const b = JSON.parse(req.body) as { contents: Array<{ parts: Array<{ text: string }> }> };
          const only = b.contents.map((c) => c.parts.map((p) => p.text).join('')).join('');
          assert.match(only, /^<fala>\nque horas são agora MARCADOR-FALA-[A-G]-(05|10|15)\n<\/fala>$/, `corpo da intenção: ${only}`);
          assert.ok(!req.body.includes(MEM) && !req.body.includes(KNOW));
          assert.equal((req.body.match(/MARCADOR-FALA/g) ?? []).length, 1, 'exatamente UMA fala na requisição de intenção');
        });
      } finally {
        await h.stop();
      }
    });
  }

  it('invariantes sobre TODAS as requisições de TODOS os cenários (≥100 turnos)', () => {
    assert.ok(totalTurns >= 100, `turnos rodados: ${totalTurns}`);
    assert.ok(everyRequest.length >= 90, `requisições capturadas: ${everyRequest.length}`);
    for (const r of everyRequest) {
      // ZERO áudio: nenhum corpo carrega WAV/RIFF em base64, inlineData, nem mime de áudio
      assert.ok(!/UklGR/.test(r.body), 'bytes de WAV (RIFF em base64) numa requisição');
      assert.ok(!/inlineData|inline_data|audio\//i.test(r.body), 'inlineData/mime de áudio numa requisição');
      // a chave "real" do usuário NUNCA sai; em modo de teste só a sintética
      assert.equal(r.headers['x-goog-api-key'], 'test-dummy-key');
      assert.ok(!r.body.includes(REAL_LOOKING_KEY) && !JSON.stringify(r.headers).includes('CHAVE-REAL'));
      // só os dois endpoints esperados
      assert.match(r.url, /^\/v1beta\/models\/(gemini-flash-latest:streamGenerateContent\?alt=sse|gemini-3\.5-flash-lite:generateContent)$/);
    }
  });

  it('CONTROLE: o detector de áudio/chave acusaria um vazamento sintético (o teste pode falhar)', () => {
    const leak = (body: string, key: string): boolean => /UklGR/.test(body) || /inlineData|audio\//i.test(body) || key !== 'test-dummy-key';
    assert.ok(leak('{"contents":[{"parts":[{"inlineData":{"mimeType":"audio/wav","data":"UklGRiQ"}}]}]}', 'test-dummy-key'));
    assert.ok(leak('{}', REAL_LOOKING_KEY));
    assert.ok(!leak('{"contents":[{"parts":[{"text":"oi"}]}]}', 'test-dummy-key'));
  });
});

// exporta para outros arquivos de teste de egresso
export { GENERATION_FAILURE_TEXT };
