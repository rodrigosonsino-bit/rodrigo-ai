/**
 * Automação desktop (computer-use): loop local AX → plano JSON fechado → executor.
 * Com RODRIGO_AUTO_DESKTOP=1 + RODRIGO_DESKTOP_CONTROL=1, executa sem SIM por passo.
 * Kill switch: AbortSignal (voz "parar automação" / preemptação de sessão).
 */
import crypto from 'node:crypto';
import { DecisionLog, normalizeName, withAudit } from '../audit/decisionLog.js';
import type { DesktopTool } from '../tools/desktopControlTool.js';
import {
  SecureFieldDeniedError,
  type AccessibilityAdapter,
  type AccessibilityInsertMode,
  type AxTreeNode
} from '../tools/macosAccessibility.js';

export const AUTO_DESKTOP_MAX_STEPS = 40;
export const AUTO_DESKTOP_TIMEOUT_MS = 10 * 60_000;

/** Ações críticas de SO — nunca entram no loop livre (continuam em DESKTOP_CRITICO + SIM). */
export const CRITICAL_DESKTOP_ACTIONS = new Set([
  'empty_trash',
  'lixeira',
  'lock_screen',
  'bloquear',
  'system_sleep',
  'repouso',
  'dormir',
  'system_restart',
  'reiniciar',
  'reboot',
  'system_shutdown',
  'desligar',
  'shutdown',
  'app_quit',
  'fechar',
  'quit'
]);

export type DesktopAction =
  | { type: 'open_app'; name: string }
  | { type: 'focus_app'; name: string }
  | { type: 'ax_tree' }
  | { type: 'ax_click'; path?: string; title?: string; role?: string }
  | { type: 'ax_press'; path?: string; title?: string; role?: string }
  | { type: 'ax_hotkey'; key: string; modifiers?: string[] }
  | { type: 'ax_insert'; text: string; mode?: AccessibilityInsertMode }
  | { type: 'ax_copy_selection' }
  | { type: 'ax_select_menu'; menuPath: string }
  | { type: 'desktop_comando'; content: string }
  | { type: 'code_task'; prompt: string }
  | { type: 'process_text'; text: string; instruction: string }
  | { type: 'done'; summary: string }
  | { type: 'fail'; reason: string };

export interface PlanContext {
  goal: string;
  step: number;
  lastObservation: string;
  history: readonly string[];
}

export type DesktopActionPlanner = (ctx: PlanContext) => Promise<DesktopAction>;

export interface DesktopAutomationResult {
  ok: boolean;
  summary: string;
  steps: number;
  aborted: boolean;
  refusedCritical?: boolean;
  refusedSecure?: boolean;
}

export interface DesktopAutomationAgentDeps {
  ax: AccessibilityAdapter;
  desktop: DesktopTool;
  plan: DesktopActionPlanner;
  decisionLog: DecisionLog;
  /** Claude Code / shell-files arm — só com token interno de sessão (auto-desktop on). */
  runCodeTask?: (prompt: string, signal: AbortSignal) => Promise<string>;
  /** process_text: Gemini local ao objetivo (texto só, sem screenshot). */
  processText?: (text: string, instruction: string, signal: AbortSignal) => Promise<string>;
  maxSteps?: number;
  timeoutMs?: number;
  turnId?: string;
}

const KILL_PHRASE_RE =
  /\b(parar\s+automa[cç][aã]o|cancela(?:r)?\s+(?:a\s+)?automa[cç][aã]o|para\s+(?:a\s+)?automa[cç][aã]o|stop\s+automation)\b/i;

export function isAutomationKillPhrase(transcript: string): boolean {
  return KILL_PHRASE_RE.test(transcript.trim());
}

export function parseDesktopAction(raw: unknown): DesktopAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string') return null;

  switch (type) {
    case 'open_app':
    case 'focus_app':
      return typeof o.name === 'string' && o.name.trim()
        ? { type, name: o.name.trim() }
        : null;
    case 'ax_tree':
      return { type: 'ax_tree' };
    case 'ax_click':
    case 'ax_press':
      return {
        type,
        path: typeof o.path === 'string' ? o.path : undefined,
        title: typeof o.title === 'string' ? o.title : undefined,
        role: typeof o.role === 'string' ? o.role : undefined
      };
    case 'ax_hotkey':
      return typeof o.key === 'string' && o.key.trim()
        ? {
            type: 'ax_hotkey',
            key: o.key.trim(),
            modifiers: Array.isArray(o.modifiers)
              ? o.modifiers.filter((m): m is string => typeof m === 'string')
              : undefined
          }
        : null;
    case 'ax_insert':
      return typeof o.text === 'string'
        ? {
            type: 'ax_insert',
            text: o.text,
            mode:
              o.mode === 'append' || o.mode === 'replaceSelection' || o.mode === 'insert'
                ? o.mode
                : 'insert'
          }
        : null;
    case 'ax_copy_selection':
      return { type: 'ax_copy_selection' };
    case 'ax_select_menu':
      return typeof o.menuPath === 'string' && o.menuPath.trim()
        ? { type: 'ax_select_menu', menuPath: o.menuPath.trim() }
        : null;
    case 'desktop_comando':
      return typeof o.content === 'string' && o.content.trim()
        ? { type: 'desktop_comando', content: o.content.trim() }
        : null;
    case 'code_task':
      return typeof o.prompt === 'string' && o.prompt.trim()
        ? { type: 'code_task', prompt: o.prompt.trim() }
        : null;
    case 'process_text':
      return typeof o.text === 'string' && typeof o.instruction === 'string'
        ? { type: 'process_text', text: o.text, instruction: o.instruction }
        : null;
    case 'done':
      return { type: 'done', summary: typeof o.summary === 'string' ? o.summary : 'Concluído.' };
    case 'fail':
      return { type: 'fail', reason: typeof o.reason === 'string' ? o.reason : 'falha' };
    default:
      return null;
  }
}

/** Extrai o primeiro objeto JSON de uma resposta do modelo. */
export function extractActionFromModelText(text: string): DesktopAction | null {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return parseDesktopAction(JSON.parse(candidate.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function formatTree(nodes: readonly AxTreeNode[]): string {
  return nodes
    .slice(0, 80)
    .map((n) => {
      const bits = [`[${n.path}]`, n.role ?? '?', n.title ? `"${n.title}"` : ''];
      if (n.secure) bits.push('SECURE');
      if (n.value && !n.secure) bits.push(`val=${n.value}`);
      return bits.filter(Boolean).join(' ');
    })
    .join('\n');
}

function desktopComandoIsCritical(content: string): boolean {
  const action = content.split(':')[0]?.trim().toLowerCase() ?? '';
  return CRITICAL_DESKTOP_ACTIONS.has(action);
}

export class DesktopAutomationAgent {
  private readonly ax: AccessibilityAdapter;
  private readonly desktop: DesktopTool;
  private readonly plan: DesktopActionPlanner;
  private readonly decisionLog: DecisionLog;
  private readonly runCodeTask?: DesktopAutomationAgentDeps['runCodeTask'];
  private readonly processText?: DesktopAutomationAgentDeps['processText'];
  private readonly maxSteps: number;
  private readonly timeoutMs: number;
  private readonly turnId: string;

  constructor(deps: DesktopAutomationAgentDeps) {
    this.ax = deps.ax;
    this.desktop = deps.desktop;
    this.plan = deps.plan;
    this.decisionLog = deps.decisionLog;
    this.runCodeTask = deps.runCodeTask;
    this.processText = deps.processText;
    this.maxSteps = deps.maxSteps ?? AUTO_DESKTOP_MAX_STEPS;
    this.timeoutMs = deps.timeoutMs ?? AUTO_DESKTOP_TIMEOUT_MS;
    this.turnId = deps.turnId ?? 'auto-desktop';
  }

  async run(goal: string, signal: AbortSignal): Promise<DesktopAutomationResult> {
    const started = Date.now();
    const history: string[] = [];
    let observation = `Objetivo: ${goal}`;
    let steps = 0;

    while (steps < this.maxSteps) {
      if (signal.aborted) {
        return { ok: false, summary: 'Automação interrompida.', steps, aborted: true };
      }
      if (Date.now() - started > this.timeoutMs) {
        return { ok: false, summary: 'Tempo esgotado na automação.', steps, aborted: false };
      }

      steps += 1;
      let action: DesktopAction;
      try {
        action = await this.plan({
          goal,
          step: steps,
          lastObservation: observation,
          history
        });
      } catch (err) {
        return {
          ok: false,
          summary: `Falha ao planejar: ${err instanceof Error ? err.message : String(err)}`,
          steps,
          aborted: signal.aborted
        };
      }

      if (signal.aborted) {
        return { ok: false, summary: 'Automação interrompida.', steps, aborted: true };
      }

      if (action.type === 'done') {
        return { ok: true, summary: action.summary, steps, aborted: false };
      }
      if (action.type === 'fail') {
        return { ok: false, summary: action.reason, steps, aborted: false };
      }

      if (action.type === 'desktop_comando' && desktopComandoIsCritical(action.content)) {
        return {
          ok: false,
          summary:
            'Essa ação crítica do sistema exige confirmação por voz e não entra na automação livre.',
          steps,
          aborted: false,
          refusedCritical: true
        };
      }

      const mid = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const audited = await withAudit(
        this.decisionLog,
        {
          mid,
          turnId: this.turnId,
          action: normalizeName(action.type),
          tool: 'DesktopAutomation',
          executor: 'auto_desktop',
          dataClass: 'ordinary'
        },
        async () => {
          const obs = await this.executeAction(action, signal);
          history.push(`${action.type}: ${obs.slice(0, 200)}`);
          return obs;
        },
        (obs) => (obs.startsWith('SECURE_DENIED') || obs.startsWith('erro:') ? 'failed' : 'ok')
      );

      if (audited.refused) {
        return {
          ok: false,
          summary: 'Registro de auditoria falhou; automação recusada.',
          steps,
          aborted: false
        };
      }

      observation = audited.result;

      if (observation.startsWith('SECURE_DENIED')) {
        return {
          ok: false,
          summary: 'Campo de senha detectado — automação recusada.',
          steps,
          aborted: false,
          refusedSecure: true
        };
      }
    }

    return {
      ok: false,
      summary: `Limite de ${this.maxSteps} passos atingido sem concluir o objetivo.`,
      steps,
      aborted: false
    };
  }

  private async executeAction(action: DesktopAction, signal: AbortSignal): Promise<string> {
    try {
      switch (action.type) {
        case 'open_app': {
          const msg = await this.desktop.execute('DESKTOP_COMANDO', `open_app:${action.name}`);
          return msg;
        }
        case 'focus_app': {
          // open_app no macOS também foca se já estiver aberto.
          const msg = await this.desktop.execute('DESKTOP_COMANDO', `open_app:${action.name}`);
          return `focus: ${msg}`;
        }
        case 'ax_tree': {
          const tree = await this.ax.tree();
          return formatTree(tree) || '(árvore vazia)';
        }
        case 'ax_click': {
          await this.ax.click({ path: action.path, title: action.title, role: action.role });
          return 'clicked';
        }
        case 'ax_press': {
          await this.ax.press({ path: action.path, title: action.title, role: action.role });
          return 'pressed';
        }
        case 'ax_hotkey': {
          await this.ax.hotkey(action.key, action.modifiers);
          return `hotkey ${action.key}`;
        }
        case 'ax_insert': {
          const focused = await this.ax.inspectFocusedTarget();
          if (focused.secure) {
            return 'SECURE_DENIED';
          }
          await this.ax.insertText(action.text, action.mode ?? 'insert');
          return `inserted ${action.text.length} chars`;
        }
        case 'ax_copy_selection': {
          const text = await this.ax.copySelection();
          return `selection: ${text.slice(0, 500)}`;
        }
        case 'ax_select_menu': {
          await this.ax.selectMenu(action.menuPath);
          return `menu ${action.menuPath}`;
        }
        case 'desktop_comando': {
          return await this.desktop.execute('DESKTOP_COMANDO', action.content);
        }
        case 'code_task': {
          if (!this.runCodeTask) {
            return 'code_task indisponível (Claude Code desligado ou sem braço).';
          }
          if (signal.aborted) return 'cancelado';
          return await this.runCodeTask(action.prompt, signal);
        }
        case 'process_text': {
          if (!this.processText) {
            return 'process_text indisponível.';
          }
          return await this.processText(action.text, action.instruction, signal);
        }
        case 'done':
        case 'fail':
          return action.type;
      }
    } catch (err) {
      if (err instanceof SecureFieldDeniedError) {
        return 'SECURE_DENIED';
      }
      return `erro: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export const DESKTOP_PLANNER_SYSTEM_PROMPT = [
  'Você é o planejador de automação desktop do Orque (macOS).',
  'Recebe um objetivo e uma observação (árvore AX / resultado da última ação).',
  'Responda SOMENTE com um JSON de UMA ação, sem markdown, sem texto extra.',
  'Tipos permitidos: open_app, focus_app, ax_tree, ax_click, ax_press, ax_hotkey,',
  'ax_insert, ax_copy_selection, ax_select_menu, desktop_comando, code_task, process_text, done, fail.',
  'NUNCA use empty_trash, lock_screen, system_sleep, system_restart, system_shutdown, app_quit.',
  'NUNCA manipule campos secure/senha — se vir SECURE, responda {"type":"fail","reason":"campo seguro"}.',
  'Quando o objetivo estiver cumprido: {"type":"done","summary":"..."}.',
  'Uma ação por resposta. Prefira ax_tree se a observação estiver vazia ou desatualizada.'
].join(' ');
