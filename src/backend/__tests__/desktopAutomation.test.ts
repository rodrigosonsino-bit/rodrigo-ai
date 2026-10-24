import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionLog } from '../audit/decisionLog.js';
import {
  DesktopAutomationAgent,
  CRITICAL_DESKTOP_ACTIONS,
  extractActionFromModelText,
  isAutomationKillPhrase,
  parseDesktopAction,
  type DesktopAction
} from '../agents/desktopAutomationAgent.js';
import { DesktopTool } from '../tools/desktopControlTool.js';
import {
  SecureFieldDeniedError,
  type AccessibilityAdapter,
  type AxTreeNode,
  type FocusedTargetSnapshot
} from '../tools/macosAccessibility.js';
import { parsePrivacyConfig, autoDesktopEffective, effectivePrivacy } from '../privacy.js';

function editableSnap(over: Partial<FocusedTargetSnapshot> = {}): FocusedTargetSnapshot {
  return {
    app: { bundleId: 'com.apple.TextEdit', name: 'TextEdit' },
    role: 'AXTextArea',
    subrole: null,
    title: null,
    focused: true,
    enabled: true,
    editable: true,
    secure: false,
    supportsValue: true,
    directInsertSupported: true,
    appendSupported: true,
    value: '',
    selectedText: null,
    selectedRange: { location: 0, length: 0 },
    ...over
  };
}

class FakeAx implements AccessibilityAdapter {
  inserted: string[] = [];
  clicks: Array<{ title?: string; path?: string }> = [];
  treeNodes: AxTreeNode[] = [
    { path: '0/0', role: 'AXWindow', title: 'Untitled', value: null, enabled: true, focused: true, secure: false },
    { path: '0/0/1', role: 'AXTextArea', title: null, value: '', enabled: true, focused: true, secure: false }
  ];
  secureOnInsert = false;
  denyCopySecure = false;

  async inspectFocusedTarget(): Promise<FocusedTargetSnapshot> {
    return editableSnap({ secure: this.secureOnInsert });
  }
  async insertText(text: string): Promise<'ax'> {
    if (this.secureOnInsert) throw new SecureFieldDeniedError();
    this.inserted.push(text);
    return 'ax';
  }
  async tree(): Promise<readonly AxTreeNode[]> {
    return this.treeNodes;
  }
  async click(target: { path?: string; title?: string }): Promise<void> {
    this.clicks.push(target);
  }
  async press(target: { path?: string; title?: string }): Promise<void> {
    this.clicks.push(target);
  }
  async hotkey(): Promise<void> {}
  async selectMenu(): Promise<void> {}
  async copySelection(): Promise<string> {
    if (this.denyCopySecure) throw new SecureFieldDeniedError();
    return 'texto selecionado';
  }
  async getSelectedText(): Promise<string> {
    return this.copySelection();
  }
}

describe('parseDesktopAction / extractActionFromModelText', () => {
  it('aceita schema fechado e rejeita lixo', () => {
    assert.deepEqual(parseDesktopAction({ type: 'open_app', name: 'Safari' }), {
      type: 'open_app',
      name: 'Safari'
    });
    assert.equal(parseDesktopAction({ type: 'weird' }), null);
    assert.equal(parseDesktopAction(null), null);
  });

  it('extrai JSON de resposta com fence', () => {
    const a = extractActionFromModelText('```json\n{"type":"done","summary":"ok"}\n```');
    assert.deepEqual(a, { type: 'done', summary: 'ok' });
  });
});

describe('kill switch phrase', () => {
  it('reconhece parar/cancela automação', () => {
    assert.equal(isAutomationKillPhrase('parar automação'), true);
    assert.equal(isAutomationKillPhrase('cancela a automacao agora'), true);
    assert.equal(isAutomationKillPhrase('abre o Safari'), false);
  });
});

describe('RODRIGO_AUTO_DESKTOP flag (fail-closed)', () => {
  it('padrão off; inválido aborta', () => {
    assert.equal(parsePrivacyConfig({}).autoDesktop, false);
    assert.equal(parsePrivacyConfig({ RODRIGO_AUTO_DESKTOP: '1' }).autoDesktop, true);
    assert.throws(() => parsePrivacyConfig({ RODRIGO_AUTO_DESKTOP: 'talvez' }), /RODRIGO_AUTO_DESKTOP/);
  });

  it('só efetiva com desktop control ligado', () => {
    const cfg = parsePrivacyConfig({ RODRIGO_AUTO_DESKTOP: '1' });
    assert.equal(autoDesktopEffective(cfg, true), true);
    assert.equal(autoDesktopEffective(cfg, false), false);
    const st = effectivePrivacy({ RODRIGO_AUTO_DESKTOP: '1', RODRIGO_DESKTOP_CONTROL: '0' });
    assert.equal(st.autoDesktop.enabled, false);
    assert.equal(st.autoDesktop.reason, 'desktop-control-off');
  });
});

describe('H3 — secure e empty_trash fora do loop livre', () => {
  it('lista crítica inclui empty_trash / lock / sleep', () => {
    assert.ok(CRITICAL_DESKTOP_ACTIONS.has('empty_trash'));
    assert.ok(CRITICAL_DESKTOP_ACTIONS.has('lock_screen'));
    assert.ok(CRITICAL_DESKTOP_ACTIONS.has('system_sleep'));
  });

  it('desktop_comando crítico recusa sem executar', async () => {
    const ax = new FakeAx();
    const opened: string[] = [];
    const desktop = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      exec: async (file, args) => {
        opened.push(`${file} ${args.join(' ')}`);
        return { stdout: '', stderr: '' };
      }
    });
    const planQueue: DesktopAction[] = [
      { type: 'desktop_comando', content: 'empty_trash' }
    ];
    const agent = new DesktopAutomationAgent({
      ax,
      desktop,
      plan: async () => planQueue.shift() ?? { type: 'fail', reason: 'fim' },
      decisionLog: DecisionLog.inMemory(),
      turnId: 't1'
    });
    const r = await agent.run('esvazia a lixeira', new AbortController().signal);
    assert.equal(r.refusedCritical, true);
    assert.equal(opened.length, 0);
  });

  it('campo secure recusa insert', async () => {
    const ax = new FakeAx();
    ax.secureOnInsert = true;
    const desktop = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      exec: async () => ({ stdout: '', stderr: '' })
    });
    const planQueue: DesktopAction[] = [
      { type: 'ax_insert', text: 'segredo' },
      { type: 'done', summary: 'não deveria chegar' }
    ];
    const agent = new DesktopAutomationAgent({
      ax,
      desktop,
      plan: async () => planQueue.shift()!,
      decisionLog: DecisionLog.inMemory(),
      turnId: 't2'
    });
    const r = await agent.run('digita senha', new AbortController().signal);
    assert.equal(r.refusedSecure, true);
    assert.equal(ax.inserted.length, 0);
  });
});

describe('H1 — loop fake AX cumpre goal sem SIM por passo', () => {
  it('abre Safari (allowlist), foca, digita e conclui', async () => {
    const ax = new FakeAx();
    const calls: string[] = [];
    const desktop = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      exec: async (file, args) => {
        calls.push(`${file}|${args.join('|')}`);
        return { stdout: '', stderr: '' };
      },
      resolveAppTargetSync: (name) =>
        name.toLowerCase().includes('safari')
          ? {
              displayName: 'Safari',
              openArgs: ['-b', 'com.apple.Safari'],
              quitMode: 'bundleId',
              quitValue: 'com.apple.Safari'
            }
          : null
    });

    const planQueue: DesktopAction[] = [
      { type: 'open_app', name: 'Safari' },
      { type: 'ax_tree' },
      { type: 'ax_insert', text: 'olá mundo' },
      { type: 'ax_copy_selection' },
      { type: 'done', summary: 'Safari aberto e texto digitado.' }
    ];

    const agent = new DesktopAutomationAgent({
      ax,
      desktop,
      plan: async () => planQueue.shift()!,
      decisionLog: DecisionLog.inMemory(),
      turnId: 'h1'
    });

    const r = await agent.run('abre o Safari e digita olá mundo', new AbortController().signal);
    assert.equal(r.ok, true);
    assert.ok(r.steps >= 4);
    assert.deepEqual(ax.inserted, ['olá mundo']);
    assert.ok(calls.some((c) => c.includes('com.apple.Safari') || c.includes('/usr/bin/open')));
  });
});

describe('H2 — kill switch via AbortSignal', () => {
  it('interrompe em menos de 1s', async () => {
    const ax = new FakeAx();
    const desktop = new DesktopTool({
      env: { RODRIGO_DESKTOP_CONTROL: '1' },
      exec: async () => ({ stdout: '', stderr: '' })
    });
    const ac = new AbortController();
    let step = 0;
    const agent = new DesktopAutomationAgent({
      ax,
      desktop,
      plan: async () => {
        step += 1;
        if (step === 1) {
          // Abort após o primeiro plano — simula "parar automação".
          ac.abort();
          return { type: 'ax_tree' };
        }
        await new Promise((r) => setTimeout(r, 5000));
        return { type: 'done', summary: 'tarde' };
      },
      decisionLog: DecisionLog.inMemory(),
      turnId: 'h2'
    });

    const t0 = Date.now();
    const r = await agent.run('objetivo longo', ac.signal);
    const elapsed = Date.now() - t0;
    assert.equal(r.aborted, true);
    assert.ok(elapsed < 1000, `kill switch demorou ${elapsed}ms`);
  });
});
