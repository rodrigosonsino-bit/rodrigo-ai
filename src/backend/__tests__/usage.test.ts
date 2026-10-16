import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleUsageRequest } from '../routes/usage.js';
import type { UsageStatus } from '../../shared/types.js';

function mockRes(): { res: Partial<ServerResponse>; out: { status: number; body: string } } {
  const out = { status: 0, body: '' };
  const res = {
    writeHead: (status: number) => {
      out.status = status;
    },
    end: (body?: string) => {
      out.body = body ?? '';
    }
  };
  return { res: res as Partial<ServerResponse>, out };
}

const SUMMARY: UsageStatus = {
  day: '2026-10-15',
  resetInMs: 3600000,
  models: [
    { source: 'geracao', model: 'gemini-flash-latest', req: 3, inTokens: 300, outTokens: 60, cap: 100, pct: 0.03 },
    { source: 'tts', model: 'gemini-3.8-flash-lite-tts', req: 5, inTokens: 45, outTokens: 75, cap: 90, pct: 0.06 }
  ]
};

describe('GET /api/usage', () => {
  it('200 com números agregados por (fonte, modelo)', () => {
    const { res, out } = mockRes();
    handleUsageRequest(
      { method: 'GET' } as IncomingMessage,
      res as ServerResponse,
      () => SUMMARY
    );
    assert.equal(out.status, 200);
    const body = JSON.parse(out.body) as UsageStatus;
    assert.equal(body.day, '2026-10-15');
    assert.equal(body.models.length, 2);
    assert.equal(body.models[0].req, 3);
  });

  it('só números: nenhum texto de conversa na resposta', () => {
    const { res, out } = mockRes();
    handleUsageRequest(
      { method: 'GET' } as IncomingMessage,
      res as ServerResponse,
      () => SUMMARY
    );
    const body = JSON.parse(out.body) as UsageStatus;
    const strings: string[] = [];
    JSON.stringify(body, (_k, v) => {
      if (typeof v === 'string') strings.push(v);
      return v;
    });
    const allowed = new Set(['2026-10-15', 'geracao', 'tts', 'gemini-flash-latest', 'gemini-3.8-flash-lite-tts']);
    for (const s of strings) {
      assert.ok(allowed.has(s), `string inesperada na resposta: ${s}`);
    }
  });

  it('503 honesto sem runtime de voz (nunca zeros enganosos)', () => {
    const { res, out } = mockRes();
    handleUsageRequest({ method: 'GET' } as IncomingMessage, res as ServerResponse, undefined);
    assert.equal(out.status, 503);
  });

  it('POST => 405', () => {
    const { res, out } = mockRes();
    handleUsageRequest(
      { method: 'POST' } as IncomingMessage,
      res as ServerResponse,
      () => SUMMARY
    );
    assert.equal(out.status, 405);
  });
});
