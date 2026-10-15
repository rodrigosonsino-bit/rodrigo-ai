import { spawn } from 'node:child_process';
import type { ISubAgent, SubAgentTaskRequest, SubAgentTaskResult } from './subAgent.js';
import type { Capability } from './capabilityPolicy.js';
import { guardText } from '../privacy/outboundGuard.js';
import { claudeCodeEffective, DEFAULT_PRIVACY, type PrivacyConfig } from '../privacy.js';
import type { SubAgentCoordinator } from './subAgent.js';

/** Timeout padrão: 10 minutos (configurável via RODRIGO_CLAUDE_TIMEOUT_MS). */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Variáveis que nunca passam ao processo filho.
 * Segredos de nuvem e env vars do app que poderiam revelar configuração interna.
 */
const ENV_DENY_LIST: readonly string[] = [
  'GEMINI_API_KEY',
  'TYPESAFE_API_KEY',
  'GROK_WEBHOOK_URL',
  'GROK_WEBHOOK_KEY',
  'MIMO_API_KEY',
];
const RODRIGO_ENV_PREFIX = 'RODRIGO_';

function buildChildEnv(): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (ENV_DENY_LIST.includes(k)) continue;
    if (k.startsWith(RODRIGO_ENV_PREFIX)) continue;
    child[k] = v;
  }
  return child;
}

/**
 * Fase 17 — ClaudeCodeSubAgent: spawna `claude -p` como processo filho para delegar
 * tarefas que exigem acesso à máquina (arquivos, shell, apps, Drive via MCP).
 *
 * Segurança:
 * - Exige confirmationToken em TODA chamada (toda tarefa é potencialmente mutante).
 * - Ambiente sanitizado: nenhuma chave de nuvem ou var RODRIGO_* passa ao filho.
 * - Prompt e saída passam pelo outboundGuard (T1) como dado não-confiável.
 * - Processo filho morto no abort/timeout (SIGTERM → SIGKILL após 5s).
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
    private readonly privacy: PrivacyConfig = DEFAULT_PRIVACY,
    private readonly rootDir: string = process.cwd()
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

    return this._runProcess(safePrompt, req.taskId ?? crypto.randomUUID(), signal);
  }

  private _runProcess(
    prompt: string,
    _taskId: string,
    signal: AbortSignal
  ): Promise<SubAgentTaskResult> {
    return new Promise<SubAgentTaskResult>((resolve) => {
      const childEnv = buildChildEnv();

      // H17.2: vetor de args fixo; prompt chega por stdin, nunca no argv.
      // D1 = escrita desde o início: Bash, Read, Write, Edit, Glob, Grep (sem MCP herdado).
      const args = [
        '-p',
        '--output-format', 'json',
        '--permission-mode', 'bypass-permissions',
        '--tools', 'Bash,Read,Write,Edit,Glob,Grep',
        '--no-session-persistence',
      ];

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn('claude', args, {
          cwd: this.rootDir,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (err) {
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
        signal.removeEventListener('abort', abortHandler);
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* já morto */ } }, 5000);
      }, this.timeoutMs);

      const abortHandler = (): void => {
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* já morto */ } }, 5000);
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
      proc.stdin!.write(prompt);
      proc.stdin!.end();
    });
  }
}

/**
 * Registra o ClaudeCodeSubAgent no coordenador se o canal estiver EFETIVO
 * (RODRIGO_CLOUD=1 e RODRIGO_CLAUDE_CODE=1). Canal desligado = não registrado = some do manifesto.
 */
export function registerClaudeCodeAgent(
  coordinator: SubAgentCoordinator,
  privacy: PrivacyConfig,
  rootDir: string
): ClaudeCodeSubAgent | null {
  if (!claudeCodeEffective(privacy)) return null;
  const agent = new ClaudeCodeSubAgent(privacy, rootDir);
  coordinator.register(agent);
  console.log('[Rodrigo AI] ClaudeCodeSubAgent registrado (RODRIGO_CLAUDE_CODE efetivo).');
  return agent;
}
