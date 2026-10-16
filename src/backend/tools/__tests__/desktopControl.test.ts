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

function editableTarget(overrides: Partial<{
  app: { name: string; bundleId: string };
  role: string | null;
  subrole: string | null;
  title: string | null;
  focused: boolean;
  enabled: boolean;
  editable: boolean;
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
      exec: async () => {
        pasted = true;
        return { stdout: '', stderr: '' };
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
      exec: async () => {
        pasted = true;
        return { stdout: '', stderr: '' };
      }
    });

    tool.preview('DIGITAR_TEXTO', 'texto:Texto importante');
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
      accessibility: {
        inspectFocusedTarget: async () => editableTarget(),
        insertText: async () => {
          throw new Error('selection unavailable');
        }
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
      accessibility: {
        inspectFocusedTarget: async () => editableTarget(),
        insertText: async () => {
          throw new Error('selection unavailable');
        }
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

  it('DigitarTool permite digitação no Cursor especificamente', async () => {
    let clipboardText = 'ANTES';
    let changeCount = 20;
    const osascriptCalls: string[][] = [];
    const front = { name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92' };

    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      pasteRestoreDelayMs: 5,
      getFrontmostAppSync: () => front,
      getFrontmostApp: async () => front,
      exec: async (_file, args) => {
        osascriptCalls.push([...args]);
        return { stdout: '', stderr: '' };
      },
      accessibility: {
        inspectFocusedTarget: async () =>
          editableTarget({
            app: front
          }),
        insertText: async () => {
          throw new Error('selection unavailable');
        }
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

    const preview = tool.preview('DIGITAR_TEXTO', 'texto:colar no cursor');
    assert.match(preview, /Vou digitar em Cursor/);

    const result = await tool.execute('DIGITAR_TEXTO', 'texto:colar no cursor');
    assert.match(result, /Pronto, digitei o texto em Cursor/);
    assert.equal(osascriptCalls.length, 1);
    assert.match(osascriptCalls[0][1], /keystroke "v" using \{command down\}/);
    assert.equal(clipboardText, 'ANTES');
  });

  it('DigitarTool usa inserção AX-first quando o alvo suporta AXValue + AXSelectedTextRange', async () => {
    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const inserted: Array<{ text: string; mode: string }> = [];
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
      exec: async (file, args) => {
        execCalls.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    });

    tool.preview('DIGITAR_INSERIR', 'Olá mundo');
    const result = await tool.execute('DIGITAR_INSERIR', 'Olá mundo');
    assert.match(result, /inseri o texto em Notes/);
    assert.deepEqual(inserted, [{ text: 'Olá mundo', mode: 'insert' }]);
    assert.equal(execCalls.length, 0, 'não deve usar paste quando AX direto funciona');
  });

  it('DigitarTool recusa quando o app está em foco mas não há campo editável', async () => {
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92' }),
      getFrontmostApp: async () => ({ name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92' }),
      accessibility: {
        inspectFocusedTarget: async () =>
          editableTarget({
            app: { name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92' },
            editable: false,
            role: 'AXButton'
          }),
        insertText: async () => 'ax'
      }
    });

    tool.preview('DIGITAR_TEXTO', 'texto:colar no cursor');
    const result = await tool.execute('DIGITAR_TEXTO', 'texto:colar no cursor');
    assert.match(result, /não é um campo editável/i);
  });

  it('DigitarTool faz fallback para paste quando AX direto falha em inserção comum', async () => {
    let pasted = false;
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      pasteRestoreDelayMs: 5,
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () =>
          editableTarget({
            directInsertSupported: true,
            value: 'abc',
            selectedRange: { location: 3, length: 0 }
          }),
        insertText: async () => {
          throw new Error('AXValue unavailable');
        }
      },
      exec: async () => {
        pasted = true;
        return { stdout: '', stderr: '' };
      },
      clipboard: {
        getSnapshot: async () => ({ text: 'ANTES', changeCount: 1 }),
        setText: async () => ({ changeCount: 2 }),
        getChangeCount: async () => 99
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
    const inserted: Array<{ text: string; mode: string }> = [];
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () =>
          editableTarget({
            directInsertSupported: true,
            value: '',
            selectedRange: { location: 0, length: 0 }
          }),
        insertText: async (text, mode) => {
          inserted.push({ text, mode });
          return 'ax';
        }
      }
    });

    tool.preview('DIGITAR_LIMPAR_INSERIR', 'hã tipo assim vamos fechar o relatório hoje');
    const result = await tool.execute('DIGITAR_LIMPAR_INSERIR', 'hã tipo assim vamos fechar o relatório hoje');
    assert.match(result, /limpei o ditado e inseri o texto/i);
    assert.deepEqual(inserted, [{ text: 'Vamos fechar o relatório hoje.', mode: 'insert' }]);
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

  it('sem permissão de Acessibilidade: inserção simples cai para colagem via Cmd+V', async () => {
    const keystrokes: string[][] = [];
    let clipboardText = 'anterior';
    let changeCount = 1;
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () => {
          throw new Error('AXError -25204');
        },
        insertText: async () => {
          throw new Error('não deveria ser chamado sem leitura AX');
        }
      },
      clipboard: {
        getSnapshot: async () => ({ text: clipboardText, changeCount }),
        setText: async (text: string) => {
          clipboardText = text;
          changeCount += 1;
          return { changeCount };
        },
        getChangeCount: async () => changeCount
      },
      exec: (async (cmd: string, args: string[]) => {
        keystrokes.push([cmd, ...args]);
        return { stdout: '', stderr: '' };
      }) as never
    });

    tool.preview('DIGITAR_TEXTO', 'texto:Olá mundo');
    const result = await tool.execute('DIGITAR_TEXTO', 'texto:Olá mundo');
    assert.match(result, /Pronto, digitei o texto em Notes/);
    assert.ok(
      keystrokes.some((k) => k.join(' ').includes('keystroke "v"')),
      'deveria disparar Cmd+V sintético'
    );
  });

  it('sem permissão de Acessibilidade: anexar continua recusado (precisa ler o campo)', async () => {
    const tool = new DigitarTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      getFrontmostAppSync: () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      getFrontmostApp: async () => ({ name: 'Notes', bundleId: 'com.apple.Notes' }),
      accessibility: {
        inspectFocusedTarget: async () => {
          throw new Error('AX_BAD_JSON: (empty stdout)');
        },
        insertText: async () => 'ax' as never
      }
    });

    tool.preview('DIGITAR_ANEXAR', ' e complemento');
    const result = await tool.execute('DIGITAR_ANEXAR', ' e complemento');
    assert.match(result, /só a inserção simples por colagem/i);
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
