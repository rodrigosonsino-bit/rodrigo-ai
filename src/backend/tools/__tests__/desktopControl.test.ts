import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DesktopTool,
  DigitarTool,
  DitadoLocalTool,
  ToolPreviewRefusedError,
  DENIED_TYPING_BUNDLE_IDS,
  parseDesktopControlFlag,
  resolveAppTarget,
  splitDigitarAppTarget
} from '../desktopControlTool.js';
import { QUERY_NAMES, MUTATION_NAMES } from '../../../shared/voiceProtocol.js';

function editableTarget(overrides: Partial<{
  app: { name: string; bundleId: string };
  role: string | null;
  subrole: string | null;
  title: string | null;
  focused: boolean;
  enabled: boolean;
  editable: boolean;
  secure: boolean;
  supportsValue: boolean;
  directInsertSupported: boolean;
  appendSupported: boolean;
  value: string | null;
  selectedText: string | null;
  selectedRange: { location: number; length: number } | null;
}> = {}) {
  return {
    app: overrides.app ?? { name: 'Notes', bundleId: 'com.apple.Notes' },
    role: overrides.role ?? 'AXTextArea',
    subrole: overrides.subrole ?? null,
    title: overrides.title ?? null,
    focused: overrides.focused ?? true,
    enabled: overrides.enabled ?? true,
    editable: overrides.editable ?? true,
    secure: overrides.secure ?? false,
    supportsValue: overrides.supportsValue ?? true,
    directInsertSupported: overrides.directInsertSupported ?? false,
    appendSupported: overrides.appendSupported ?? false,
    value: overrides.value ?? '',
    selectedText: overrides.selectedText ?? '',
    selectedRange: overrides.selectedRange ?? { location: 0, length: 0 }
  };
}

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

    const refused = await tool.execute('DESKTOP_COMANDO', 'open_app:app inexistente xyz');
    assert.match(refused, /não encontrei o aplicativo/i);
  });

  it('resolveAppTarget prefere Notes para o alias "bloco de notas" e preserva TextEdit em "editor de texto"', () => {
    const notes = resolveAppTarget('bloco de notas');
    const textEdit = resolveAppTarget('editor de texto');
    assert.ok(notes);
    assert.ok(textEdit);
    assert.equal(notes.displayName, 'Notes');
    assert.deepEqual(notes.openArgs, ['-b', 'com.apple.Notes']);
    assert.equal(textEdit.displayName, 'TextEdit');
    assert.deepEqual(textEdit.openArgs, ['-b', 'com.apple.TextEdit']);
  });

  it('open_app e app_quit aceitam fallback por nome de app instalado fora da allowlist fixa', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const tool = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      resolveAppTargetSync: (rawName: string) =>
        rawName === 'Chess'
          ? {
              displayName: 'Chess',
              openArgs: ['-a', 'Chess'],
              quitMode: 'appName',
              quitValue: 'Chess'
            }
          : null,
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    });

    const openMsg = await tool.execute('DESKTOP_COMANDO', 'open_app:Chess');
    assert.match(openMsg, /Chess/);
    assert.deepEqual(calls[0], { file: '/usr/bin/open', args: ['-a', 'Chess'] });

    const preview = tool.preview('DESKTOP_CRITICO', 'app_quit:Chess');
    assert.match(preview, /Vou fechar o aplicativo Chess/);

    const closeMsg = await tool.execute('DESKTOP_CRITICO', 'app_quit:Chess');
    assert.match(closeMsg, /Fechei o aplicativo Chess/);
    assert.equal(calls[1].file, '/usr/bin/osascript');
    assert.match(calls[1].args[1], /tell application appName to quit saving ask/);
    assert.equal(calls[1].args[3], 'Chess');
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

  it('DESKTOP_CRITICO system_restart e system_shutdown pedem confirmação e agendam pós-fala', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const tool = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      schedulePostSpeechAction: (action) => {
        scheduled.push(action);
      },
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    });

    assert.match(tool.preview('DESKTOP_CRITICO', 'system_restart'), /reiniciar/i);
    assert.match(await tool.execute('DESKTOP_CRITICO', 'system_restart'), /Reiniciando/);
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.match(String(calls[0]?.args[1] ?? ''), /restart/i);

    assert.match(tool.preview('DESKTOP_CRITICO', 'system_shutdown'), /desligar/i);
    assert.match(await tool.execute('DESKTOP_CRITICO', 'system_shutdown'), /Desligando/);
    assert.equal(scheduled.length, 2);
    await scheduled[1]();
    assert.match(String(calls[1]?.args[1] ?? ''), /shut down/i);
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
    for (const deniedBundle of ['com.apple.Terminal', 'com.googlecode.iterm2', 'local.rodrigo-ai.desktop']) {
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

  it('DigitarTool tenta restaurar o foco do app-alvo antes de colar', async () => {
    const fronts = [
      { name: 'Safari', bundleId: 'com.apple.Safari' },
      { name: 'Notes', bundleId: 'com.apple.Notes' }
    ];
    let pasted = false;
    const activated: string[] = [];
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => fronts.shift() ?? { name: 'Notes', bundleId: 'com.apple.Notes' },
      activateApp: async (bundleId: string) => {
        activated.push(bundleId);
      },
      accessibility: {
        inspectFocusedTarget: async () => editableTarget(),
        insertText: async () => 'ax'
      },
      pasteViaHid: async () => {
        pasted = true;
      }
    });

    const preview = tool.preview('DIGITAR_TEXTO', 'texto:Texto importante');
    assert.match(preview, /Notes/);

    const result = await tool.execute('DIGITAR_TEXTO', 'texto:Texto importante');
    assert.equal(activated.length, 1);
    assert.equal(activated[0], 'com.apple.Notes');
    assert.match(result, /Pronto, digitei o texto em Notes/);
    assert.equal(pasted, true);
  });

  it('DigitarTool aborta se não conseguir restaurar o foco do app-alvo', async () => {
    let pasted = false;
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Safari', bundleId: 'com.apple.Safari' }),
      activateApp: async () => {},
      accessibility: {
        inspectFocusedTarget: async () => editableTarget({ app: { name: 'Safari', bundleId: 'com.apple.Safari' } }),
        insertText: async () => 'ax'
      },
      pasteViaHid: async () => {
        pasted = true;
      }
    });

    tool.preview('DIGITAR_TEXTO', 'texto:Texto importante');
    const result = await tool.execute('DIGITAR_TEXTO', 'texto:Texto importante');
    assert.match(result, /Cancelado por segurança: o aplicativo em primeiro plano mudou/);
    assert.equal(pasted, false);
  });

  it('DigitarTool cola via helper HID (CGEvent), padrão ClipboardPaster do DitadoLocal', async () => {
    const hidCalls: string[] = [];
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () => editableTarget(),
        insertText: async () => {
          throw new Error('AX não deve ser o caminho primário');
        }
      },
      pasteViaHid: async (text) => {
        hidCalls.push(text);
      }
    });

    tool.preview('DIGITAR_TEXTO', 'texto:Mensagem ditada');
    const res = await tool.execute('DIGITAR_TEXTO', 'texto:Mensagem ditada');
    assert.match(res, /Pronto, digitei o texto em Notes/);
    assert.deepEqual(hidCalls, ['Mensagem ditada']);
  });

  it('DigitarTool permite digitação no Cursor especificamente', async () => {
    const hidCalls: string[] = [];
    const front = { name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92' };

    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => front,
      getFrontmostApp: async () => front,
      accessibility: {
        inspectFocusedTarget: async () => editableTarget({ app: front }),
        insertText: async () => {
          throw new Error('AX não deve ser o caminho primário');
        }
      },
      pasteViaHid: async (text) => {
        hidCalls.push(text);
      }
    });

    const preview = tool.preview('DIGITAR_TEXTO', 'texto:colar no cursor');
    assert.match(preview, /Vou digitar em Cursor/);

    const result = await tool.execute('DIGITAR_TEXTO', 'texto:colar no cursor');
    assert.match(result, /Pronto, digitei o texto em Cursor/);
    assert.deepEqual(hidCalls, ['colar no cursor']);
  });

  it('DigitarTool não bloqueia VS Code só por ser editor', () => {
    const front = { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' };
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => front
    });
    const preview = tool.preview('DIGITAR_TEXTO', 'texto:colar no editor');
    assert.match(preview, /Vou digitar em Visual Studio Code/);
  });

  it('splitDigitarAppTarget e DigitarTool abrem o Editor de Texto quando o pedido nomeia o app', async () => {
    assert.deepEqual(splitDigitarAppTarget('app:TextEdit|texto:reunião às três'), {
      appRaw: 'TextEdit',
      rest: 'texto:reunião às três'
    });

    const calls: Array<{ file: string; args: readonly string[] }> = [];
    let pasted = '';
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Safari', bundleId: 'com.apple.Safari' }),
      getFrontmostApp: async () => ({ name: 'TextEdit', bundleId: 'com.apple.TextEdit' }),
      exec: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
      pasteViaHid: async (text) => {
        pasted = text;
      },
      accessibility: {
        inspectFocusedTarget: async () => editableTarget({ app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit' } }),
        insertText: async () => 'ax'
      }
    });

    const preview = tool.preview('DIGITAR_TEXTO', 'app:TextEdit|texto:reunião às três');
    assert.match(preview, /TextEdit/);
    assert.match(preview, /reunião às três/);

    const result = await tool.execute('DIGITAR_TEXTO', 'app:TextEdit|texto:reunião às três');
    assert.match(result, /TextEdit/);
    assert.equal(pasted, 'reunião às três');
    assert.ok(calls.some((c) => c.file === '/usr/bin/open' && c.args.includes('com.apple.TextEdit')));
  });

  it('DigitarTool prioriza paste HID (CGEvent) na inserção — AX não é o caminho primário', async () => {
    const inserted: Array<{ text: string; mode: string }> = [];
    const hidCalls: string[] = [];
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () =>
          editableTarget({
            directInsertSupported: true,
            value: 'abc',
            selectedRange: { location: 3, length: 0 }
          }),
        insertText: async (text, mode) => {
          inserted.push({ text, mode });
          return 'ax';
        }
      },
      pasteViaHid: async (text) => {
        hidCalls.push(text);
      }
    });

    tool.preview('DIGITAR_INSERIR', 'Olá mundo');
    const result = await tool.execute('DIGITAR_INSERIR', 'Olá mundo');
    assert.match(result, /digitei o texto em Notes/);
    assert.deepEqual(hidCalls, ['Olá mundo']);
    assert.equal(inserted.length, 0, 'inserção comum não deve usar AX');
  });

  it('DigitarTool recusa campo de senha mesmo com foco', async () => {
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Safari', bundleId: 'com.apple.Safari' }),
      getFrontmostApp: async () => ({ name: 'Safari', bundleId: 'com.apple.Safari' }),
      accessibility: {
        inspectFocusedTarget: async () =>
          editableTarget({
            app: { name: 'Safari', bundleId: 'com.apple.Safari' },
            editable: false,
            secure: true,
            role: 'AXSecureTextField'
          }),
        insertText: async () => 'ax'
      }
    });

    tool.preview('DIGITAR_TEXTO', 'texto:senha123');
    const result = await tool.execute('DIGITAR_TEXTO', 'texto:senha123');
    assert.match(result, /campo de senha/i);
  });

  it('DigitarTool cola no foco mesmo quando AX não marca o alvo como editável', async () => {
    let pasted = false;
    const front = { name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92' };
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => front,
      getFrontmostApp: async () => front,
      accessibility: {
        inspectFocusedTarget: async () =>
          editableTarget({
            app: front,
            editable: false,
            secure: false,
            role: 'AXGroup',
            directInsertSupported: false
          }),
        insertText: async () => {
          throw new Error('should not use AX when not editable');
        }
      },
      pasteViaHid: async () => {
        pasted = true;
      }
    });

    tool.preview('DIGITAR_TEXTO', 'texto:colar no cursor');
    const result = await tool.execute('DIGITAR_TEXTO', 'texto:colar no cursor');
    assert.match(result, /Pronto, digitei o texto em Cursor/);
    assert.equal(pasted, true);
  });

  it('DigitarTool cola via HID mesmo se o inspect AX falhar', async () => {
    let pasted = false;
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () => {
          throw new Error('no focused element');
        },
        insertText: async () => {
          throw new Error('unreachable');
        }
      },
      pasteViaHid: async () => {
        pasted = true;
      }
    });

    tool.preview('DIGITAR_INSERIR', 'Mensagem nova');
    const result = await tool.execute('DIGITAR_INSERIR', 'Mensagem nova');
    assert.match(result, /digitei o texto em Notes/);
    assert.equal(pasted, true);
  });

  it('DigitarTool exige seleção real para substituir a seleção', async () => {
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () =>
          editableTarget({
            directInsertSupported: true,
            selectedText: '',
            selectedRange: { location: 4, length: 0 }
          }),
        insertText: async () => 'ax'
      }
    });

    tool.preview('DIGITAR_SUBSTITUIR_SELECAO', 'Texto novo');
    const result = await tool.execute('DIGITAR_SUBSTITUIR_SELECAO', 'Texto novo');
    assert.match(result, /não encontrei texto selecionado/i);
  });

  it('DigitarTool suporta limpar o ditado antes de inserir', async () => {
    const hidCalls: string[] = [];
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () => editableTarget(),
        insertText: async () => {
          throw new Error('AX não deve ser o caminho primário');
        }
      },
      pasteViaHid: async (text) => {
        hidCalls.push(text);
      }
    });

    tool.preview('DIGITAR_LIMPAR_INSERIR', 'hã tipo assim vamos fechar o relatório hoje');
    const result = await tool.execute('DIGITAR_LIMPAR_INSERIR', 'hã tipo assim vamos fechar o relatório hoje');
    assert.match(result, /limpei o ditado e (?:inseri|colei) o texto/i);
    assert.deepEqual(hidCalls, ['Vamos fechar o relatório hoje.']);
  });

  it('DigitarTool suporta anexar texto ao final via AXValue', async () => {
    const inserted: Array<{ text: string; mode: string }> = [];
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () =>
          editableTarget({
            appendSupported: true,
            value: 'Base'
          }),
        insertText: async (text, mode) => {
          inserted.push({ text, mode });
          return 'ax';
        }
      }
    });

    tool.preview('DIGITAR_ANEXAR', ' e complemento');
    const result = await tool.execute('DIGITAR_ANEXAR', ' e complemento');
    assert.match(result, /anexei o texto em Notes/);
    assert.deepEqual(inserted, [{ text: 'e complemento', mode: 'append' }]);
  });

  it('DigitarTool responde honestamente quando traduzir-e-inserir não está disponível', async () => {
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () => editableTarget(),
        insertText: async () => 'ax'
      }
    });

    tool.preview('DIGITAR_TRADUZIR_INSERIR', 'inglês:Bom dia');
    const result = await tool.execute('DIGITAR_TRADUZIR_INSERIR', 'inglês:Bom dia');
    assert.match(result, /tradução local para inserir não está disponível/i);
  });
});
