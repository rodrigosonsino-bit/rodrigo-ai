import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aecStatusMessage,
  parseSpeakerphoneFlag,
  playbackDuckGain,
  shouldClearSource,
  speakingForVad,
  vadThresholds,
  DEFAULT_VAD,
  SPEAKERPHONE_VAD
} from '../../shared/speakerphoneProfile.js';

describe('speakerphoneProfile (viva-voz v3-min)', () => {
  it('H-VV.M1: limiares do viva-voz são estritamente maiores que o padrão', () => {
    const off = vadThresholds(false);
    const on = vadThresholds(true);
    assert.equal(off.rmsListen, DEFAULT_VAD.rmsListen);
    assert.ok(on.rmsListen > off.rmsListen);
    assert.ok(on.rmsWhileOutput > off.rmsWhileOutput);
    assert.ok(on.bargeInHysteresisMs > off.bargeInHysteresisMs);
    assert.equal(on.rmsWhileOutput, SPEAKERPHONE_VAD.rmsWhileOutput);
  });

  it('H-VV.M2: com viva-voz, SSE falando OU playback elevam; sem viva-voz, só SSE', () => {
    assert.equal(speakingForVad(true, false, true), true, 'SSE falando entre frases');
    assert.equal(speakingForVad(true, true, false), true, 'playback real com SSE já ouvindo');
    assert.equal(speakingForVad(true, false, false), false);
    assert.equal(speakingForVad(false, true, false), false, 'off: playback sozinho não muda (legado)');
    assert.equal(speakingForVad(false, false, true), true);
  });

  it('H-VV.M3: onended só limpa se a identidade do source bater', () => {
    const a = { id: 1 };
    const b = { id: 2 };
    assert.equal(shouldClearSource(a, a), true);
    assert.equal(shouldClearSource(a, b), false);
    assert.equal(shouldClearSource(null, a), false);
  });

  it('H-VV.M4: aviso AEC nunca promete eco filtrado; undefined = risco', () => {
    const ok = aecStatusMessage(true);
    const bad = aecStatusMessage(false);
    const missing = aecStatusMessage(undefined);
    assert.doesNotMatch(ok, /filtrado/i);
    assert.doesNotMatch(bad, /filtrado/i);
    assert.match(bad, /risco/i);
    assert.match(missing, /risco/i);
  });

  it('H-VV.M5: duck 0,85 só com viva-voz', () => {
    assert.equal(playbackDuckGain(true), 0.85);
    assert.equal(playbackDuckGain(false), 1);
  });

  it('H-VV.M6: parse de flag de persistência', () => {
    assert.equal(parseSpeakerphoneFlag('1'), true);
    assert.equal(parseSpeakerphoneFlag('0'), false);
    assert.equal(parseSpeakerphoneFlag(' true '), true);
    assert.equal(parseSpeakerphoneFlag('lixo'), false);
    assert.equal(parseSpeakerphoneFlag(undefined), false);
  });
});
