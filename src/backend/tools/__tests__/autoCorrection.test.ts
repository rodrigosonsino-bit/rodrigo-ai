import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AutoCorrecaoTool, ToolPreviewRefusedError } from '../desktopControlTool.js';
import { DEFAULT_PRIVACY, type PrivacyConfig } from '../../privacy.js';

const PRIVACY_WITH_CLAUDE: PrivacyConfig = {
  ...DEFAULT_PRIVACY,
  cloud: true,
  claudeCode: true
};

describe('Pilar 4 — AutoCorrecaoTool (AUTO_CORRECAO em worktree isolada)', () => {
  it('recusa no preview() se RODRIGO_CLAUDE_CODE=0', () => {
    const tool = new AutoCorrecaoTool({
      rootDir: '/tmp/repo-falso',
      privacy: { ...DEFAULT_PRIVACY, claudeCode: false }
    });
    assert.throws(
      () => tool.preview('AUTO_CORRECAO', 'Corrigir texto do botão'),
      (err) => err instanceof ToolPreviewRefusedError && /RODRIGO_CLAUDE_CODE=1/.test(err.message)
    );
  });

  it('bloqueia prompt contendo segredo pelo outboundGuard antes de invocar o Claude CLI', async () => {
    let claudeSpawned = false;
    const tool = new AutoCorrecaoTool({
      rootDir: '/tmp/repo-falso',
      privacy: PRIVACY_WITH_CLAUDE,
      exec: async (file) => {
        if (file === 'claude') claudeSpawned = true;
        return { stdout: '', stderr: '' };
      }
    });

    const fakeKey = 'AIzaSyD-CHAVE-SECRETA-VAZANDO-1234567890';
    assert.throws(
      () => tool.preview('AUTO_CORRECAO', `Usar chave ${fakeKey} no arquivo`),
      (err) => err instanceof ToolPreviewRefusedError && /segurança de saída/.test(err.message)
    );
    assert.equal(claudeSpawned, false);
  });

  it('executa em git worktree isolada com --permission-mode acceptEdits e --tools Read,Write,Edit,Glob,Grep, verifica ausência de deleção de testes e roda typecheck + test', async () => {
    const commands: Array<{ file: string; args: readonly string[]; cwd?: string; input?: string }> = [];

    const tool = new AutoCorrecaoTool({
      rootDir: '/repo/rodrigo-ai',
      privacy: PRIVACY_WITH_CLAUDE,
      idGenerator: () => 'deadbeef',
      exec: async (file, args, options) => {
        commands.push({ file, args, cwd: options?.cwd, input: options?.input });
        return { stdout: '', stderr: '' };
      }
    });

    const preview = tool.preview('AUTO_CORRECAO', 'Ajustar rótulo do botão de voz');
    assert.match(preview, /Vou criar uma branch isolada para implementar e testar: Ajustar rótulo do botão de voz/);

    const result = await tool.execute('AUTO_CORRECAO', 'Ajustar rótulo do botão de voz');
    assert.match(result, /Auto-correção concluída e validada pelos testes na branch isolada auto-fix\/auto-fix-deadbeef/);

    const expectedWorktree = '/repo/rodrigo-ai/.runtime/worktrees/auto-fix-deadbeef';
    assert.deepEqual(commands[0], {
      file: 'git',
      args: ['worktree', 'add', '-b', 'auto-fix/auto-fix-deadbeef', expectedWorktree, 'HEAD'],
      cwd: '/repo/rodrigo-ai',
      input: undefined
    });
    assert.equal(commands[1].file, 'claude');
    assert.equal(commands[1].cwd, expectedWorktree);
    assert.equal(commands[1].input, 'Ajustar rótulo do botão de voz');
    assert.equal(commands[1].args.includes('acceptEdits'), true);
    assert.equal(commands[1].args.includes('Read,Write,Edit,Glob,Grep'), true);
    assert.equal(commands[1].args.includes('bypassPermissions'), false);

    assert.deepEqual(commands[2], {
      file: 'git',
      args: ['diff', '--diff-filter=D', '--name-only', '--', 'src/**/__tests__'],
      cwd: expectedWorktree,
      input: undefined
    });
    assert.equal(commands[3].file, 'npm');
    assert.deepEqual(commands[3].args, ['run', 'typecheck']);
    assert.equal(commands[4].file, 'npm');
    assert.deepEqual(commands[4].args, ['test']);
  });

  it('aborta e limpa worktree + branch se o subagente tentar deletar arquivos de teste em src/**/__tests__', async () => {
    const commands: Array<{ file: string; args: readonly string[] }> = [];

    const tool = new AutoCorrecaoTool({
      rootDir: '/repo/rodrigo-ai',
      privacy: PRIVACY_WITH_CLAUDE,
      idGenerator: () => 'bad12345',
      exec: async (file, args) => {
        commands.push({ file, args });
        if (args[0] === 'diff' && args.includes('--diff-filter=D')) {
          return { stdout: 'src/backend/__tests__/privacy.test.ts\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    });

    const result = await tool.execute('AUTO_CORRECAO', 'Fazer limpeza nos testes');
    assert.match(result, /Auto-correção abortada e revertida: o subagente tentou remover arquivos de teste/);
    const removedWorktree = commands.some((c) => c.file === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove');
    const deletedBranch = commands.some((c) => c.file === 'git' && c.args[0] === 'branch' && c.args[1] === '-D');
    assert.equal(removedWorktree, true, 'deve remover a worktree descartável');
    assert.equal(deletedBranch, true, 'deve remover a branch descartável');
  });
});
