import { spawn } from 'node:child_process';
import type { ISubAgent, SubAgentTaskRequest, SubAgentTaskResult } from './subAgent.js';
import type { Capability } from './capabilityPolicy.js';
import { guardText } from '../privacy/outboundGuard.js';
import { claudeCodeWriteEffective, DEFAULT_PRIVACY, type PrivacyConfig } from '../privacy.js';
import type { SubAgentCoordinator } from './subAgent.js';
import { CLAUDE_CHILD_STDIO, passNonceFd, claudeChildEnv, defaultProxyAuth, ensureSandboxDirs, isolationReadiness, sweepSurvivors, wrapSandbox, writeRootReadiness, type IsolationDeps, type SandboxPaths } from './claudeCode.js';
import type { ProxyAuth } from './claudeProxy.js';
import type { DelegationObserver, DelegationStatus } from './delegationNotice.js';

/** Timeout padrão: 10 minutos (configurável via RODRIGO_CLAUDE_TIMEOUT_MS). */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Fase 17 — ClaudeCodeSubAgent: spawna `claude -p` como processo filho para delegar
 * tarefas que exigem acesso à máquina (arquivos, shell, apps, Drive via MCP).
 *
 * Segurança:
 * - Exige confirmationToken em TODA chamada (toda tarefa é potencialmente mutante).
 * - Ambiente sanitizado: nenhuma chave de nuvem ou var RODRIGO_* passa ao filho.
 * - Prompt e saída passam pelo outboundGuard (T1) como dado não-confiável.
 * - Grupo de processos (detached) morto no abort/timeout: SIGTERM → SIGKILL após 5s (M5).
 *
 * Opção C (F17, 2026-10-24): com `isolation` (produção), o processo roda NUM WORKTREE LIMPO (sem docs/research),
 * dentro do perfil sandbox-exec que nega leitura e escrita no HOME e libera escrita só nessa raiz, com ambiente em
 * lista de permissão e só depois da prova de isolamento (selftest). Sem `isolation` é o caminho legado (só testes).
 */
export class ClaudeCodeSubAgent implements ISubAgent {
  readonly id = 'claude_code';
  readonly name = 'Claude Code';
  /** Uma capability-string por agente (usada no manifesto); as grants são as reais permissões T3. */
  readonly capabilities: readonly string[] = ['claude_code'];
  /** T3: todas as capacidades físicas que o claude -p com Bash pode exercer. */
  readonly grants: readonly Capability[] = ['shell', 'read_file', 'write_file', 'network', 'browser'];
  readonly requiresConfirmation = true;

  private readonly timeoutMs: number;

  constructor(
    private readonly privacy: PrivacyConfig,
    private readonly verifyMutationToken: ((turnId: string, token: string) => boolean) | undefined,
    /** OBRIGATÓRIO (A3 do Code): sem isolamento este agente não existe. Não há caminho legado nem fallback. */
    private readonly isolation: IsolationDeps,
    private readonly observer?: DelegationObserver
  ) {
    this.timeoutMs = parseInt(process.env.RODRIGO_CLAUDE_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
  }

  async runTask(req: SubAgentTaskRequest, signal: AbortSignal): Promise<SubAgentTaskResult> {
    if (signal.aborted) {
      return { success: false, output: '', error: 'Tarefa cancelada.', kind: 'final' };
    }

    // H17.1: token de confirmação obrigatório (toda chamada é potencialmente mutante).
    if (!req.confirmationToken) {
      return {
        success: false, output: '',
        error: 'ClaudeCodeSubAgent bloqueado: confirmationToken ausente.',
        kind: 'final'
      };
    }
    if (!req.confirmationToken.startsWith(`${req.turnId}:`)) {
      return {
        success: false, output: '',
        error: 'ClaudeCodeSubAgent bloqueado: confirmationToken não corresponde ao turno atual.',
        kind: 'final'
      };
    }
    if (this.verifyMutationToken && !this.verifyMutationToken(req.turnId, req.confirmationToken)) {
      return {
        success: false, output: '',
        error: 'ClaudeCodeSubAgent bloqueado: confirmationToken não emitido pelo gatekeeper ou já consumido.',
        kind: 'final'
      };
    }

    // T1: guarda de saída sobre o prompt antes de passar ao processo filho.
    const promptGuard = guardText(req.prompt, this.privacy.outboundGuard);
    if (promptGuard.blocked) {
      return {
        success: false, output: '',
        error: 'Prompt bloqueado pelo guarda de saída (dado sensível detectado).',
        kind: 'final'
      };
    }
    const safePrompt = promptGuard.text;

    const ready = isolationReadiness(this.isolation);
    if (!ready.ready) {
      return {
        success: false, output: '',
        error: `A delegação ao Claude não está pronta: ${ready.reason}.`,
        kind: 'final'
      };
    }
    // A3: o modo escrita roda na raiz de ESCRITA (separada); o perfil dele não reabre a raiz de leitura.
    const wr = writeRootReadiness(this.isolation, ready.root);
    if (!wr.ok) {
      return { success: false, output: '', error: `O modo escrita do Claude não está pronto: ${wr.reason}.`, kind: 'final' };
    }
    const wpaths = this.isolation.writePaths as SandboxPaths;
    const auth = (this.isolation.proxyAuth ?? defaultProxyAuth)(this.isolation.home, 'escrita');
    if (!auth) {
      return { success: false, output: '', error: 'O proxy do Claude não está pronto (token dedicado ausente ou porta ocupada).', kind: 'final' };
    }
    // B1: binário do spawn é o que a prova conferiu; a raiz é a de escrita provada no mesmo selftest (hash inclui as duas).
    const spec = { command: ready.bin, cwd: wr.root, env: claudeChildEnv(process.env, wpaths, auth), paths: wpaths, auth };
    // Ajuste 1 (F17): aviso à Ogra no início e no fim (modo escrita). Nunca derruba a tarefa.
    const noticeId = req.taskId ?? crypto.randomUUID();
    const emit = (status: DelegationStatus, conclusion?: string): void => {
      try {
        this.observer?.onEvent({ id: noticeId, mode: 'escrita', order: req.prompt, status, at: new Date().toISOString(), ...(conclusion !== undefined ? { conclusion } : {}) });
      } catch {
        /* ignora */
      }
    };
    emit('started');
    const result = await this._runProcess(safePrompt, noticeId, signal, spec);
    const cancelled = !result.success && /cancelad/i.test(result.error ?? '');
    const timedOut = !result.success && /Tempo esgotado/i.test(result.error ?? '');
    emit(result.success ? 'done' : cancelled ? 'cancelled' : timedOut ? 'timeout' : 'failed', result.success ? result.output : result.error);
    return result;
  }

  private _runProcess(
    prompt: string,
    _taskId: string,
    signal: AbortSignal,
    spec: { command: string; cwd: string; env: NodeJS.ProcessEnv; paths: SandboxPaths; auth: ProxyAuth }
  ): Promise<SubAgentTaskResult> {
    return new Promise<SubAgentTaskResult>((resolve) => {
      const childEnv = spec.env;

      // H17.2: vetor de args fixo; prompt chega por stdin, nunca no argv.
      // D1 = escrita desde o início: Bash, Read, Write, Edit, Glob, Grep (sem MCP herdado).
      const args = [
        '-p',
        '--output-format', 'json',
        '--permission-mode', 'bypassPermissions',
        '--tools', 'Bash,Read,Write,Edit,Glob,Grep',
        '--no-session-persistence',
      ];

      let proc: ReturnType<typeof spawn>;
      try {
        ensureSandboxDirs(spec.paths);
        const iso = wrapSandbox(spec.command, args, spec.cwd, this.isolation.home, { writable: true, paths: spec.paths, proxyPort: spec.auth.port });
        proc = spawn(iso.command, iso.args, {
          cwd: spec.cwd,
          env: childEnv,
          stdio: [...CLAUDE_CHILD_STDIO],
          // M5 do Code: grupo de processos próprio, para que o kill alcance os filhos do Bash (servidores, npm, sleep).
          detached: true
        });
      } catch (err) {
        spec.auth.revoke();
        return resolve({
          success: false, output: '',
          error: `Falha ao iniciar claude: ${err instanceof Error ? err.message : String(err)}`,
          kind: 'final'
        });
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let finished = false;

      const finish = (result: SubAgentTaskResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // P2: nonce do job revogado; grupo encerrado e sobreviventes (setsid) varridos.
        spec.auth.revoke();
        killProcessGroup(proc, 0);
        try {
          (this.isolation.sweep ?? sweepSurvivors)([spec.cwd, spec.paths.configDir, spec.paths.tmpDir]);
        } catch {
          /* melhor esforço */
        }
        signal.removeEventListener('abort', abortHandler);
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc);
      }, this.timeoutMs);

      const abortHandler = (): void => {
        killProcessGroup(proc);
        finish({ success: false, output: '', error: 'Tarefa cancelada pelo usuário.', kind: 'final' });
      };
      signal.addEventListener('abort', abortHandler, { once: true });

      proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('error', (err) => {
        finish({
          success: false, output: '',
          error: `Erro no processo claude: ${err.message}`,
          kind: 'final'
        });
      });

      proc.on('close', (code) => {
        if (finished) return;

        if (timedOut) {
          return finish({
            success: false, output: '',
            error: `Tempo esgotado (${Math.round(this.timeoutMs / 60_000)} min).`,
            kind: 'final'
          });
        }

        // Parse da saída JSON do --output-format json
        let rawOutput = '';
        try {
          const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
          rawOutput = typeof parsed['result'] === 'string' ? parsed['result']
            : typeof parsed['output'] === 'string' ? parsed['output']
            : stdout.trim();
        } catch {
          rawOutput = stdout.trim();
        }

        // T1: saída do claude -p é DADO NÃO CONFIÁVEL — passa pelo guarda.
        const outGuard = guardText(rawOutput, this.privacy.outboundGuard);
        const safeOutput = outGuard.text;

        if (code !== 0 && !safeOutput.trim()) {
          return finish({
            success: false, output: '',
            error: `claude -p saiu com código ${code ?? '?'}. ${stderr.slice(0, 300)}`,
            kind: 'final'
          });
        }

        finish({ success: true, output: safeOutput, kind: 'final' });
      });

      // H17.2: prompt por stdin, entrada fechada (sem injeção via arg ou shell).
      // F2: nonce do job pelo fd 3 (fora do env); sem o pipe, falha fechada.
      if (!passNonceFd(proc, spec.auth)) {
        killProcessGroup(proc);
        return finish({ success: false, output: '', error: 'Não consegui entregar a credencial do job ao Claude.', kind: 'final' });
      }
      proc.stdin!.write(prompt);
      proc.stdin!.end();
    });
  }
}

/**
 * M5 do Code: encerra o GRUPO inteiro (SIGTERM e, 5 s depois, SIGKILL), não só o PID do sandbox-exec. Exige `detached: true` no spawn.
 * Se o grupo não existir mais (ESRCH), cai no kill do PID.
 */
export function killProcessGroup(proc: { pid?: number; kill: (s: NodeJS.Signals) => boolean }, graceMs = 5000): void {
  const send = (sig: NodeJS.Signals): void => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
      else proc.kill(sig);
    } catch {
      try { proc.kill(sig); } catch { /* já morto */ }
    }
  };
  send('SIGTERM');
  const t = setTimeout(() => send('SIGKILL'), graceMs);
  t.unref?.();
}

/**
 * Registra o ClaudeCodeSubAgent no coordenador se o canal estiver EFETIVO
 * (RODRIGO_CLOUD=1 e RODRIGO_CLAUDE_CODE=1). Canal desligado = não registrado = some do manifesto.
 */
export function registerClaudeCodeAgent(
  coordinator: SubAgentCoordinator,
  privacy: PrivacyConfig,
  /** OBRIGATÓRIO (A3): sem isolamento não há registro. */
  isolation: IsolationDeps,
  verifyMutationToken?: (turnId: string, token: string) => boolean,
  observer?: DelegationObserver
): ClaudeCodeSubAgent | null {
  // Modo escrita DESLIGADO por padrão: exige RODRIGO_CLAUDE_CODE_WRITE=1 além do canal efetivo.
  if (!claudeCodeWriteEffective(privacy)) return null;
  const agent = new ClaudeCodeSubAgent(privacy, verifyMutationToken, isolation, observer);
  coordinator.register(agent);
  console.log('[Rodrigo AI] ClaudeCodeSubAgent registrado (RODRIGO_CLAUDE_CODE efetivo).');
  return agent;
}
