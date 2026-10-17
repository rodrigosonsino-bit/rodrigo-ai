import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KOKORO_VOICES, KokoroVoiceProvider, parseKokoroVoice, resolveKokoroVoiceRequest } from '../voice/ttsProviders.js';

describe('troca de voz por pedido → Kokoro', () => {
  it('nomes, ids e "kokoro <nome>"', () => {
    assert.equal(resolveKokoroVoiceRequest('alex', {}), 'pm_alex');
    assert.equal(resolveKokoroVoiceRequest('santa', {}), 'pm_santa');
    assert.equal(resolveKokoroVoiceRequest('dora', {}), 'pf_dora');
    assert.equal(resolveKokoroVoiceRequest('pm_santa', {}), 'pm_santa');
    assert.equal(resolveKokoroVoiceRequest('kokoro alex', {}), 'pm_alex');
  });

  it('"kokoro" sozinho usa o KOKORO_VOICE do .env', () => {
    assert.equal(resolveKokoroVoiceRequest('kokoro', { KOKORO_VOICE: 'pm_alex' }), 'pm_alex');
    assert.equal(resolveKokoroVoiceRequest('kokoro', {}), 'pf_dora');
  });

  it('outros pedidos não são Kokoro (seguem para say/Gemini)', () => {
    for (const r of ['charon', 'felipe', 'alexandra', 'kokoroalex', 'voxcpm']) {
      assert.equal(resolveKokoroVoiceRequest(r, {}), null, r);
    }
  });
});

describe('KOKORO_VOICE', () => {
  it('ausente ou vazio usa pf_dora', () => {
    assert.equal(parseKokoroVoice({}), 'pf_dora');
    assert.equal(parseKokoroVoice({ KOKORO_VOICE: '  ' }), 'pf_dora');
  });

  it('aceita as 3 vozes pt-BR, sem diferenciar maiúsculas', () => {
    for (const v of KOKORO_VOICES) assert.equal(parseKokoroVoice({ KOKORO_VOICE: v }), v);
    assert.equal(parseKokoroVoice({ KOKORO_VOICE: ' PM_ALEX ' }), 'pm_alex');
  });

  it('valor fora da lista volta para pf_dora com aviso', () => {
    const logs: string[] = [];
    for (const bad of ['af_heart', 'pm_alex --x', '../voz']) {
      assert.equal(parseKokoroVoice({ KOKORO_VOICE: bad }, (m) => logs.push(m)), 'pf_dora');
    }
    assert.equal(logs.length, 3);
  });

  it('o nome do provedor mostra a voz escolhida', () => {
    assert.equal(new KokoroVoiceProvider('/x', '/y', 'pm_santa').name, 'Kokoro-82M (pm_santa)');
    assert.equal(new KokoroVoiceProvider('/x', '/y').name, 'Kokoro-82M (pf_dora)');
  });
});
