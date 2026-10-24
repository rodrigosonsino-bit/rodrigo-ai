import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CONTAINED_ECHO_CHARS,
  OUTPUT_TAIL_MS,
  isTtsEchoTranscript,
  micIgnoredWhileOutput,
  normalizeTtsEcho
} from '../../shared/ttsEcho.js';

describe('ttsEcho', () => {
  it('normaliza acento, pontuação e caixa', () => {
    assert.equal(normalizeTtsEcho('Pensando...'), 'pensando');
    assert.equal(normalizeTtsEcho('  Pensando!! '), 'pensando');
    assert.equal(normalizeTtsEcho('A capital é Brasília.'), 'a capital e brasilia');
  });

  it('casa "Pensando..." por igualdade, não uma frase que só contém a palavra', () => {
    const spoken = ['Pensando...'];
    assert.equal(isTtsEchoTranscript('Pensando...', spoken), true);
    assert.equal(isTtsEchoTranscript('pensando', spoken), true);
    assert.equal(isTtsEchoTranscript('Pensando', spoken), true);
    assert.equal(isTtsEchoTranscript('Pensando... Pensando...', spoken), true);
    assert.equal(isTtsEchoTranscript('estou pensando em sair', spoken), false);
    assert.ok(normalizeTtsEcho('Pensando...').length < MIN_CONTAINED_ECHO_CHARS);
  });

  it('frase longa dentro da transcrição é eco; um pedaço curto dela não é', () => {
    const spoken = ['A capital é Brasília.'];
    assert.equal(isTtsEchoTranscript('A capital é Brasília.', spoken), true);
    assert.equal(isTtsEchoTranscript('é, a capital é brasília', spoken), true);
    assert.equal(isTtsEchoTranscript('capital', spoken), false);
    assert.equal(isTtsEchoTranscript('Brasília', spoken), false);
    assert.equal(isTtsEchoTranscript('', spoken), false);
    assert.equal(isTtsEchoTranscript('olá', []), false);
  });

  it('microfone fica surdo com playback, com SSE falando e no rabo; quieto, não', () => {
    assert.equal(
      micIgnoredWhileOutput({ playbackActive: true, sseSpeaking: false, tailUntil: 0, now: 5_000 }),
      true
    );
    assert.equal(
      micIgnoredWhileOutput({ playbackActive: false, sseSpeaking: true, tailUntil: 0, now: 5_000 }),
      true
    );
    const now = 10_000;
    assert.equal(
      micIgnoredWhileOutput({
        playbackActive: false,
        sseSpeaking: false,
        tailUntil: now + OUTPUT_TAIL_MS,
        now: now + 100
      }),
      true
    );
    assert.equal(
      micIgnoredWhileOutput({
        playbackActive: false,
        sseSpeaking: false,
        tailUntil: now + OUTPUT_TAIL_MS,
        now: now + OUTPUT_TAIL_MS
      }),
      false
    );
    assert.equal(
      micIgnoredWhileOutput({ playbackActive: false, sseSpeaking: false, tailUntil: 0, now }),
      false
    );
  });
});
