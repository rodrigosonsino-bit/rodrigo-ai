import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_OGRA_CUE_SOUND,
  OGRA_CUE_MAX_BYTES,
  aiffPcmToWav,
  createDefaultPlayOgraCue,
  isCueWav,
  resolveOgraCueSoundPath
} from '../voice/ograCue.js';
import { buildTestWav } from './helpers/egress.js';

function writeExtended80(buf: Buffer, offset: number, value: number): void {
  const highest = Math.floor(Math.log2(value));
  const shift = 63 - highest;
  const exp = 16383 + highest;
  let hi: number;
  let lo: number;
  if (shift >= 32) {
    hi = Math.trunc(value * 2 ** (shift - 32));
    lo = 0;
  } else {
    hi = Math.trunc(value / 2 ** (32 - shift));
    lo = Math.trunc(value * 2 ** shift) >>> 0;
  }
  buf.writeUInt16BE(exp, offset);
  buf.writeUInt32BE(hi >>> 0, offset + 2);
  buf.writeUInt32BE(lo >>> 0, offset + 6);
}

function chunk(id: string, data: Buffer): Buffer {
  const pad = data.length % 2;
  const out = Buffer.alloc(8 + data.length + pad);
  out.write(id, 0, 'ascii');
  out.writeUInt32BE(data.length, 4);
  data.copy(out, 8);
  return out;
}

function buildAiff(samples: Int16Array, sampleRate: number, aifc: 'twos' | 'sowt' | 'ima4' | null): Buffer {
  const comm = Buffer.alloc(aifc ? 23 : 18);
  comm.writeInt16BE(1, 0);
  comm.writeUInt32BE(samples.length, 2);
  comm.writeInt16BE(16, 6);
  writeExtended80(comm, 8, sampleRate);
  if (aifc) {
    comm.write(aifc, 18, 'ascii');
    comm.writeUInt8(0, 22);
  }
  const ssnd = Buffer.alloc(8 + samples.length * 2);
  ssnd.writeUInt32BE(0, 0);
  ssnd.writeUInt32BE(0, 4);
  for (let i = 0; i < samples.length; i++) {
    if (aifc === 'sowt') ssnd.writeInt16LE(samples[i], 8 + i * 2);
    else ssnd.writeInt16BE(samples[i], 8 + i * 2);
  }
  const body = Buffer.concat([Buffer.from(aifc ? 'AIFC' : 'AIFF'), chunk('COMM', comm), chunk('SSND', ssnd)]);
  const form = Buffer.alloc(8);
  form.write('FORM', 0, 'ascii');
  form.writeUInt32BE(body.length, 4);
  return Buffer.concat([form, body]);
}

describe('sinal sonoro da Ogra', () => {
  it('vazio e off desligam; ausente aponta para o Tink', () => {
    assert.equal(resolveOgraCueSoundPath({}), DEFAULT_OGRA_CUE_SOUND);
    assert.equal(resolveOgraCueSoundPath({ RODRIGO_OGRA_CUE_SOUND: '' }), null);
    assert.equal(resolveOgraCueSoundPath({ RODRIGO_OGRA_CUE_SOUND: '   ' }), null);
    assert.equal(resolveOgraCueSoundPath({ RODRIGO_OGRA_CUE_SOUND: 'off' }), null);
    assert.equal(resolveOgraCueSoundPath({ RODRIGO_OGRA_CUE_SOUND: 'OFF' }), null);
    assert.equal(resolveOgraCueSoundPath({ RODRIGO_OGRA_CUE_SOUND: ' /tmp/tink.aiff ' }), '/tmp/tink.aiff');
  });

  it('desligado não lê arquivo nem entrega WAV', async () => {
    let reads = 0;
    const play = createDefaultPlayOgraCue(
      { RODRIGO_OGRA_CUE_SOUND: 'off' },
      {
        readFile: () => {
          reads += 1;
          return Buffer.alloc(0);
        }
      }
    );
    let delivered = 0;
    await play({
      deliverWav: () => {
        delivered += 1;
      }
    });
    assert.equal(reads, 0);
    assert.equal(delivered, 0);
  });

  it('WAV no caminho configurado é entregue sem ffmpeg', async () => {
    const wav = buildTestWav(0.05, 16000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogra-cue-'));
    const file = path.join(dir, 'tink.wav');
    fs.writeFileSync(file, wav);
    try {
      let ffmpeg = 0;
      const play = createDefaultPlayOgraCue(
        { RODRIGO_OGRA_CUE_SOUND: file },
        {
          ffmpeg: async () => {
            ffmpeg += 1;
            return wav;
          }
        }
      );
      const got: Buffer[] = [];
      await play({ deliverWav: (buf) => got.push(buf) });
      assert.equal(got.length, 1);
      assert.ok(got[0].equals(wav));
      assert.equal(ffmpeg, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AIFF PCM 16-bit vira WAV que o navegador decodifica, nas duas endiannesses', () => {
    const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    for (const kind of [null, 'twos', 'sowt'] as const) {
      const wav = aiffPcmToWav(buildAiff(samples, 44100, kind));
      assert.ok(wav && isCueWav(wav), kind ?? 'AIFF');
      assert.equal(wav!.readUInt16LE(22), 1);
      assert.equal(wav!.readUInt32LE(24), 44100);
      assert.equal(wav!.readUInt32LE(40), samples.length * 2);
      for (let i = 0; i < samples.length; i++) {
        assert.equal(wav!.readInt16LE(44 + i * 2), samples[i]);
      }
    }
  });

  it('AIFF comprimido passa pelo conversor injetado; arquivo ausente ou grande não lança', async () => {
    const compressed = buildAiff(Int16Array.from([1, 2]), 16000, 'ima4');
    assert.equal(aiffPcmToWav(compressed), null);
    const wav = buildTestWav(0.05);
    let ffmpegPath = '';
    const play = createDefaultPlayOgraCue(
      { RODRIGO_OGRA_CUE_SOUND: '/som/Tink.aiff' },
      {
        stat: () => ({ size: compressed.length, isFile: () => true }),
        readFile: () => compressed,
        ffmpeg: async (p) => {
          ffmpegPath = p;
          return wav;
        }
      }
    );
    const got: Buffer[] = [];
    await play({ deliverWav: (buf) => got.push(buf) });
    assert.equal(ffmpegPath, '/som/Tink.aiff');
    assert.equal(got.length, 1);
    assert.ok(got[0].equals(wav));

    const missing = createDefaultPlayOgraCue(
      { RODRIGO_OGRA_CUE_SOUND: '/nao/existe.aiff' },
      {
        stat: () => {
          throw new Error('ENOENT');
        }
      }
    );
    await assert.doesNotReject(async () => {
      await missing({
        deliverWav: () => {
          throw new Error('não devia entregar');
        }
      });
    });

    const huge = createDefaultPlayOgraCue(
      { RODRIGO_OGRA_CUE_SOUND: '/som/grande.aiff' },
      {
        stat: () => ({ size: OGRA_CUE_MAX_BYTES + 1, isFile: () => true }),
        readFile: () => {
          throw new Error('não devia ler');
        }
      }
    );
    let delivered = 0;
    await huge({
      deliverWav: () => {
        delivered += 1;
      }
    });
    assert.equal(delivered, 0);
  });
});
