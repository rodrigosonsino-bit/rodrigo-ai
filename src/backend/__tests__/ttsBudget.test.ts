import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TtsBudget, laDay } from '../voice/ttsBudget.js';

/**
 * Fase 13a (docs/phase-13a-v3.md §4.4): orçamento do TTS em nuvem — reserva REAL, janela por minuto, dia no fuso de Los
 * Angeles, falha fechada em arquivo corrompido/ilegível e contagem conservadora entre instâncias.
 */
describe('TtsBudget (Fase 13a)', () => {
  let dir: string;
  let file: string;
  let t: number;
  const clock = (): number => t;
  const logs: string[] = [];
  const make = (over: { rpm?: number; rpd?: number; filePath?: string } = {}): TtsBudget =>
    new TtsBudget({ filePath: over.filePath ?? file, rpm: over.rpm ?? 8, rpd: over.rpd ?? 90, now: clock, log: (m) => logs.push(m) });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-budget-'));
    file = path.join(dir, '.runtime', 'tts-budget.json');
    t = Date.UTC(2026, 9, 8, 18, 0, 0); // 2026-10-08 11:00 em Los Angeles (PDT)
    logs.length = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reserva feita antes da virada do dia e usada depois: o envio conta no dia NOVO (auditoria F13a, achado 9)', () => {
    t = Date.UTC(2026, 9, 9, 6, 59, 50); // 23:59:50 de 2026-10-08 em LA
    const b = make();
    const r = b.reserve(2);
    assert.ok(r);
    assert.ok(r.take());
    t = Date.UTC(2026, 9, 9, 7, 0, 30); // 00:00:30 de 2026-10-09 em LA
    assert.ok(r.take());
    assert.equal(b.status().used, 1, 'o envio de depois da meia-noite pertence ao dia novo');
    assert.equal(make().status().used, 1, 'e o arquivo em disco é o do dia novo (outra instância lê o mesmo número)');
  });

  it('o dia é o de America/Los_Angeles, não o do relógio local nem o UTC (virada às 07:00Z em outubro)', () => {
    assert.equal(laDay(Date.UTC(2026, 9, 8, 6, 59, 0)), '2026-10-07'); // 23:59 do dia 7 em LA, já é dia 8 em UTC
    assert.equal(laDay(Date.UTC(2026, 9, 8, 7, 0, 0)), '2026-10-08');
    assert.equal(laDay(Date.UTC(2026, 11, 8, 7, 59, 0)), '2026-12-07'); // inverno (PST): virada às 08:00Z
    assert.equal(laDay(Date.UTC(2026, 11, 8, 8, 0, 0)), '2026-12-08');
  });

  it('arquivo ausente = dia novo com zero usado', () => {
    const b = make();
    const st = b.status();
    assert.equal(st.used, 0);
    assert.equal(st.exhausted, false);
    assert.equal(st.ioProblems, 0);
  });

  it('reserva REAL: concede, impede a corrida (2 reservas de 5 num limite de 8) e estorna o não usado', () => {
    const b = make({ rpm: 8 });
    const r1 = b.reserve(5);
    assert.ok(r1);
    assert.equal(b.reserve(5), null, 'a segunda reserva de 5 não cabe: 5 já estão segurados');
    const r2 = b.reserve(3);
    assert.ok(r2, '3 ainda cabem');
    assert.equal(b.reserve(1), null, 'tudo segurado');
    assert.equal(b.status().held, 8);
    assert.equal(r1.take(), true);
    r1.release(); // devolve os 4 não usados
    assert.equal(b.status().held, 3);
    assert.equal(b.status().used, 1, 'só o pedido enviado desconta do dia');
    assert.ok(b.reserve(4), 'os 4 estornados voltaram a caber');
    r1.release(); // idempotente
    assert.equal(b.status().held, 7);
  });

  it('take() só funciona enquanto há reserva; sem reserva não há consumo', () => {
    const b = make();
    const r = b.reserve(2)!;
    assert.equal(r.take(), true);
    assert.equal(r.take(), true);
    assert.equal(r.take(), false);
    assert.equal(b.status().used, 2);
  });

  it('janela por minuto: 8 pedidos enchem; 61 s depois liberam', () => {
    const b = make({ rpm: 8 });
    for (let i = 0; i < 8; i += 1) assert.equal(b.tryTake(), true, `pedido ${i}`);
    assert.equal(b.tryTake(), false, 'o 9º no mesmo minuto é bloqueado localmente');
    assert.equal(b.status().used, 8, 'o bloqueado localmente NÃO desconta');
    t += 30_000;
    assert.equal(b.tryTake(), false);
    t += 31_000;
    assert.equal(b.tryTake(), true);
  });

  it('limite diário: 90 pedidos esgotam o dia; o dia seguinte (LA) zera', () => {
    const b = make({ rpm: 1000, rpd: 90 });
    for (let i = 0; i < 90; i += 1) assert.equal(b.tryTake(), true);
    assert.equal(b.tryTake(), false);
    assert.equal(b.status().exhausted, true);
    t = Date.UTC(2026, 9, 9, 7, 5, 0); // passou da meia-noite de LA
    assert.equal(b.status().used, 0);
    assert.equal(b.tryTake(), true);
  });

  it('a reserva respeita o dia: 89 usados + reserva de 2 não cabe', () => {
    const b = make({ rpm: 1000, rpd: 90 });
    for (let i = 0; i < 89; i += 1) b.tryTake();
    assert.equal(b.reserve(2), null);
    assert.ok(b.reserve(1));
  });

  it('persiste entre processos: uma nova instância continua do que a anterior gravou', () => {
    const a = make();
    for (let i = 0; i < 5; i += 1) a.tryTake();
    const b = make();
    assert.equal(b.status().used, 5);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { day: '2026-10-08', count: 5 });
    assert.ok(!fs.existsSync(`${file}.tmp`) && !fs.existsSync(`${file}.lock`), 'sem .tmp nem .lock sobrando');
  });

  it('duas instâncias vivas: o contador local é o MAIOR entre memória e disco (estimativa conservadora)', () => {
    const a = make({ rpm: 1000 });
    const b = make({ rpm: 1000 });
    for (let i = 0; i < 4; i += 1) a.tryTake();
    for (let i = 0; i < 2; i += 1) b.tryTake(); // b enxerga 4 do disco e soma +1 por pedido
    assert.ok(b.status().used >= 4, `b deve ter visto o que a gravou, usado=${b.status().used}`);
  });

  it('arquivo de ontem é ignorado (dia novo)', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ day: '2026-10-07', count: 90 }));
    const b = make();
    assert.equal(b.status().used, 0);
    assert.equal(b.tryTake(), true);
  });

  it('arquivo CORROMPIDO = esgotado (falha fechada), com log e contador, até a virada do dia', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ isto não é json');
    const b = make();
    assert.equal(b.tryTake(), false);
    assert.equal(b.reserve(1), null);
    assert.equal(b.status().exhausted, true);
    assert.equal(b.status().ioProblems, 1, 'contado uma vez, sem repetir a cada consulta');
    b.tryTake();
    b.status();
    assert.equal(b.status().ioProblems, 1);
    assert.ok(logs.some((l) => /corrompido/.test(l) && /ESGOTADO/.test(l)));
    t = Date.UTC(2026, 9, 9, 7, 5, 0);
    assert.equal(b.status().exhausted, false, 'na virada do dia volta');
    assert.equal(b.tryTake(), true);
  });

  it('formato inválido (tipos errados, contagem negativa ou fracionária) também é corrupção', () => {
    for (const bad of [{ day: 5, count: 1 }, { day: '2026-10-08', count: -1 }, { day: '2026-10-08', count: 1.5 }, { day: '2026-10-08' }, []]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(bad));
      assert.equal(make().tryTake(), false, JSON.stringify(bad));
    }
  });

  it('arquivo ilegível desde o início (caminho impossível) = esgotado antes do 1º pedido, com log', () => {
    const blocker = path.join(dir, 'arquivo-no-lugar-da-pasta');
    fs.writeFileSync(blocker, 'x');
    const b = make({ filePath: path.join(blocker, 'tts-budget.json') }); // o "diretório" é um arquivo: ler dá ENOTDIR
    assert.equal(b.tryTake(), false);
    assert.equal(b.status().exhausted, true);
    assert.ok(b.status().ioProblems >= 1);
    assert.ok(logs.some((l) => /ESGOTADO/.test(l)));
  });

  it('erro de E/S ao GRAVAR (leitura ok): o pedido já concedido não é desfeito, mas a partir daí = esgotado (nunca "ilimitado")', () => {
    const sub = path.join(dir, 'somente-leitura');
    fs.mkdirSync(sub);
    fs.chmodSync(sub, 0o500);
    try {
      const b = make({ filePath: path.join(sub, 'tts-budget.json') });
      assert.equal(b.tryTake(), true, 'concedido: a decisão foi tomada antes da gravação');
      assert.equal(b.tryTake(), false, 'depois da falha de gravação, esgotado');
      assert.equal(b.status().exhausted, true);
      assert.ok(b.status().ioProblems >= 1);
    } finally {
      fs.chmodSync(sub, 0o700);
    }
  });

  it('lock órfão (de um processo que morreu) é removido; lock vivo recente bloqueia sem derrubar o orçamento', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, '');
    const old = new Date(t - 60_000);
    fs.utimesSync(lock, old, old);
    t += 0;
    const b = make();
    assert.equal(b.tryTake(), true);
    assert.ok(!fs.existsSync(lock));
  });

  it('bloqueio por 429: block() impede até a hora; nunca encurta um bloqueio maior; markDayExhausted vale até a virada', () => {
    const b = make();
    b.block(t + 60_000);
    b.block(t + 10_000); // não encurta
    assert.equal(b.tryTake(), false);
    assert.equal(b.status().blockedForMs, 60_000);
    t += 60_001;
    assert.equal(b.tryTake(), true);
    b.markDayExhausted();
    assert.equal(b.tryTake(), false);
    t = Date.UTC(2026, 9, 9, 7, 5, 0);
    assert.equal(b.tryTake(), true);
  });

  it('pedido enviado conta mesmo que dê erro depois (desconto na concessão, não no sucesso)', () => {
    const b = make();
    const r = b.reserve(2)!;
    r.take(); // enviado ao Google; o resultado (429/cancelado) não devolve
    r.release();
    assert.equal(b.status().used, 1);
    assert.equal(b.status().held, 0);
  });
});
