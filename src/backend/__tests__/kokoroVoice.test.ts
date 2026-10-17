import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KOKORO_VOICES, KokoroVoiceProvider, parseKokoroVoice } from '../voice/ttsProviders.js';

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
