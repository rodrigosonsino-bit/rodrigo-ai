import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DesktopTool,
  DigitarTool,
  DitadoLocalTool,
  ToolPreviewRefusedError,
  DENIED_TYPING_BUNDLE_IDS,
  parseDesktopControlFlag
} from '../desktopControlTool.js';
import { QUERY_NAMES, MUTATION_NAMES } from '../../../shared/voiceProtocol.js';

describe('Pilar 1 — DesktopTool (DESKTOP_COMANDO & DESKTOP_CRITICO)', () => {
  it('parseDesktopControlFlag: padrão 1; aceita 0 e 1; rejeita valor inválido', () => {
    assert.equal(parseDesktopControlFlag({}), true);
    assert.equal(parseDesktopControlFlag({ RODRIGO_DESKTOP_CONTROL: '1' }), true);
    assert.equal(parseDesktopControlFlag({ RODRIGO_DESKTOP_CONTROL: '0' }), false);
    assert.throws(() => parseDesktopControlFlag({ RODRIGO_DESKTOP_CONTROL: 'talvez' }), /RODRIGO_DESKTOP_CONTROL/);
  });

  it('recusa todas as ações quando RODRIGO_DESKTOP_CONTROL=0', async () => {
    const tool = new DesktopTool({ env: { RODRIGO_DESKTOP_CONTROL: '0' } });
    assert.throws(
      () => tool.preview('DESKTOP_CRITICO', 'lock_screen'),
      (err) => err instanceof Error
    );
    const res = await tool.execute('DESKTOP_COMANDO', 'volume_up');
    assert.match(res, /desativado/);
  });

  it('volume_down respeita piso mínimo de 10% + without output muted via on run argv', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const tool = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      exec: async (file, args) => {
        calls.push({ file, args });
        if (args[1]?.includes('output volume of (get volume settings)')) {
          return { stdout: '15\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    });

    const msg = await tool.execute('DESKTOP_COMANDO', 'volume_down');
    assert.match(msg, /10 por cento/);
    const setCall = calls.find((c) => c.args[1]?.includes('set volume output volume'));
    assert.ok(setCall, 'deve ter chamado set volume output volume');
    assert.match(setCall.args[1], /set volume output volume v without output muted/);
    assert.equal(setCall.args[3], '10');
  });

  it('volume_set > 0 inclui without output muted via on run argv', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const tool = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    });

    const msg = await tool.execute('DESKTOP_COMANDO', 'volume_set:45');
    assert.match(msg, /45 por cento/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].args[1], /set volume output volume v without output muted/);
    assert.equal(calls[0].args[3], '45');
  });

  it('open_app abre apenas aplicativos da allowlist por bundle ID (-b) e recusa apps fora da lista', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const tool = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    });

    const okMsg = await tool.execute('DESKTOP_COMANDO', 'open_app:Safari');
    assert.match(okMsg, /Safari/);
    assert.deepEqual(calls[0], { file: '/usr/bin/open', args: ['-b', 'com.apple.Safari'] });

    const refused = await tool.execute('DESKTOP_COMANDO', 'open_app:Terminal');
    assert.match(refused, /não está na lista de aplicativos permitidos/);
  });

  it('DESKTOP_CRITICO lock_screen e system_sleep agendam execução pós-fala (markPlayed) em vez de cortar o áudio', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    let scheduledAction: (() => Promise<void>) | undefined;

    const tool = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
      schedulePostSpeechAction: (fn) => {
        scheduledAction = fn;
      }
    });

    const speech = await tool.execute('DESKTOP_CRITICO', 'lock_screen');
    assert.equal(speech, 'Bloqueando a tela.');
    assert.equal(calls.length, 0, 'NÃO pode bloquear a tela antes de a fala terminar');
    assert.ok(scheduledAction, 'deve ter agendado a ação pós-fala');

    await scheduledAction();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['-suspend']);
  });
});

describe('Pilar 2 — DigitarTool (DIGITAR_TEXTO) vs DitadoLocalTool (DITADO_LOCAL)', () => {
  it('DitadoLocalTool está em QUERY_NAMES (isMutation: false) e limpa muletas localmente sem jamais injetar teclas', async () => {
    assert.equal(QUERY_NAMES.includes('DITADO_LOCAL'), true);
    assert.equal(MUTATION_NAMES.includes('DIGITAR_TEXTO'), true);
    const ditado = new DitadoLocalTool();
    const out = await ditado.execute('DITADO_LOCAL', 'limpar:hã tipo assim vamos fechar o relatório hoje');
    assert.match(out, /Texto limpo pelo Ditado Local:/);
    assert.match(out, /Vamos fechar o relatório hoje\./);
  });

  it('DigitarTool bloqueia DENIED_TYPING_BUNDLE_IDS no preview() com ToolPreviewRefusedError', async () => {
    for (const deniedBundle of ['com.apple.Terminal', 'com.googlecode.iterm2', 'com.microsoft.VSCode', 'local.rodrigo-ai.desktop']) {
      assert.equal(DENIED_TYPING_BUNDLE_IDS.includes(deniedBundle), true);
      const tool = new DigitarTool({
        env: { RODRIGO_DESKTOP_CONTROL: '1' },
        getFrontmostAppSync: () => ({ name: 'App Sensível', bundleId: deniedBundle })
      });
      assert.throws(
        () => tool.preview('DIGITAR_TEXTO', 'texto:Olá mundo'),
        (err) => err instanceof ToolPreviewRefusedError && /por segurança/i.test(err.message)
      );
    }
  });

  it('DigitarTool aborta no execute() se o foco mudar entre preview() e a confirmação SIM', async () => {
    let front = { name: 'Notes', bundleId: 'com.apple.Notes' };
    let pasted = false;
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => front,
      getFrontmostApp: async () => front,
      exec: async () => {
        pasted = true;
        return { stdout: '', stderr: '' };
      }
    });

    const preview = tool.preview('DIGITAR_TEXTO', 'texto:Texto importante');
    assert.match(preview, /Notes/);

    // Usuário alternou para o Safari antes de dizer "Sim"
    front = { name: 'Safari', bundleId: 'com.apple.Safari' };
    const result = await tool.execute('DIGITAR_TEXTO', 'texto:Texto importante');
    assert.match(result, /Cancelado por segurança: o aplicativo em primeiro plano mudou/);
    assert.equal(pasted, false);
  });

  it('DigitarTool preserva o clipboard usando changeCount (padrão ClipboardPaster do DitadoLocal)', async () => {
    let clipboardText = 'CONTEUDO_ANTERIOR_DO_USUARIO';
    let changeCount = 10;
    const osascriptCalls: string[][] = [];

    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      pasteRestoreDelayMs: 5,
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      exec: async (_file, args) => {
        osascriptCalls.push([...args]);
        return { stdout: '', stderr: '' };
      },
      clipboard: {
        getSnapshot: async () => ({ text: clipboardText, changeCount }),
        setText: async (text: string) => {
          clipboardText = text;
          changeCount += 1;
          return { changeCount };
        },
        getChangeCount: async () => changeCount
      }
    });

    tool.preview('DIGITAR_TEXTO', 'texto:Mensagem ditada');
    const res = await tool.execute('DIGITAR_TEXTO', 'texto:Mensagem ditada');
    assert.match(res, /Pronto, digitei o texto em Notes/);
    assert.equal(osascriptCalls.length, 1);
    assert.match(osascriptCalls[0][1], /keystroke "v" using \{command down\}/);
    assert.equal(clipboardText, 'CONTEUDO_ANTERIOR_DO_USUARIO', 'clipboard original deve ser restaurado');
  });

  it('DigitarTool NÃO sobrescreve o clipboard se o usuário copiou algo novo durante os 500ms (changeCount divergente)', async () => {
    let clipboardText = 'CONTEUDO_ANTERIOR';
    let changeCount = 1;

    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      pasteRestoreDelayMs: 5,
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      exec: async () => {
        // Simula o usuário copiando algo novo logo após o Cmd+V
        clipboardText = 'COPIA_NOVA_DO_USUARIO';
        changeCount += 1;
        return { stdout: '', stderr: '' };
      },
      clipboard: {
        getSnapshot: async () => ({ text: clipboardText, changeCount }),
        setText: async (text: string) => {
          clipboardText = text;
          changeCount += 1;
          return { changeCount };
        },
        getChangeCount: async () => changeCount
      }
    });

    tool.preview('DIGITAR_TEXTO', 'texto:Mensagem ditada');
    await tool.execute('DIGITAR_TEXTO', 'texto:Mensagem ditada');
    assert.equal(clipboardText, 'COPIA_NOVA_DO_USUARIO', 'não deve sobrescrever cópia nova do usuário');
  });
});
