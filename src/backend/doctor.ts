import fs from 'node:fs';
import path from 'node:path';
import { parsePrivacyConfig, ttsCloudEffective, ttsDictatedViaCloud, webSearchEffective } from './privacy.js';
import { validateHost, validatePort } from './config.js';
import { SENSITIVE_LIST_APPROVED } from './fileAccessRegistry.js';

/**
 * T5a (docs/plans/openjarvis-voz-desktop-v2.md §3.5): diagnóstico de prontidão e de fronteira.
 *
 * Regras de projeto, todas testadas em __tests__/doctor.test.ts:
 *  - Só olha CONFIGURAÇÃO DECLARADA: variáveis de ambiente deste processo e a EXISTÊNCIA de três caminhos fixos
 *    do runtime de voz. Nunca abre o .env, notas, memórias, histórico nem docs/research/ (isso é a T5b, depois da T2).
 *  - O relatório contém só nomes de variáveis, booleanos e enumerações. Nunca o valor de uma variável, nem a chave,
 *    nem texto do usuário (as mensagens de erro de configuração são reduzidas ao NOME da variável).
 *  - O doctor NÃO detecta tráfego de rede: ele avisa sobre canais DECLARADOS como ligados. Egress medido é da T1.
 */

export type DoctorSeverity = 'ok' | 'info' | 'warn' | 'error';

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly severity: DoctorSeverity;
  readonly detail: string;
}

export interface DoctorReport {
  readonly version: 1;
  readonly generatedAt: string;
  readonly summary: Readonly<Record<DoctorSeverity, number>>;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Raiz do projeto (onde fica .runtime). */
  readonly rootDir: string;
  /** Só para existência de caminhos FIXOS do runtime; injetável para teste. */
  readonly exists?: (p: string) => boolean;
  readonly now?: () => Date;
}

/** Caminhos fixos do runtime de voz (os mesmos de voiceRuntime.ts). Só existência, nunca conteúdo. */
export function voiceRuntimePaths(rootDir: string): Readonly<Record<string, string>> {
  return {
    'venv-python': path.join(rootDir, '.runtime', '.venv', 'bin', 'python3'),
    'worker-script': path.join(rootDir, 'scripts', 'worker', 'worker.py'),
    'models-manifest': path.join(rootDir, '.runtime', 'models-manifest.json')
  };
}

/** Reduz uma mensagem de erro de configuração ao NOME da variável: o valor recebido nunca entra no relatório. */
export function variableNameOnly(message: string): string {
  const m = /\b([A-Z][A-Z0-9_]{2,})\b/.exec(message);
  return m ? m[1] : 'variável desconhecida';
}

function check(id: string, title: string, severity: DoctorSeverity, detail: string): DoctorCheck {
  return { id, title, severity, detail };
}

export function runDoctor(input: DoctorInput): DoctorReport {
  const { env, rootDir } = input;
  const exists = input.exists ?? ((p: string) => fs.existsSync(p));
  const now = input.now ?? (() => new Date());
  const checks: DoctorCheck[] = [];

  // 1. Configuração de privacidade (parse estrito, o mesmo do startup).
  let cfg: ReturnType<typeof parsePrivacyConfig> | null = null;
  try {
    cfg = parsePrivacyConfig(env);
    checks.push(check('privacy-config', 'Configuração de privacidade', 'ok', 'Todas as variáveis RODRIGO_* têm valor válido.'));
  } catch (err) {
    const name = variableNameOnly(err instanceof Error ? err.message : '');
    checks.push(check('privacy-config', 'Configuração de privacidade', 'error', `Valor inválido em ${name}. Corrija a variável; o app recusa iniciar assim.`));
  }

  // 2. Portas e host (mesma validação do startup; só nomes).
  try {
    const port = validatePort(env.PORT, 'PORT', 3000);
    const clientPort = validatePort(env.CLIENT_PORT, 'CLIENT_PORT', 5173);
    validateHost(env.HOST, '127.0.0.1');
    if (port === clientPort) {
      checks.push(check('ports', 'Portas e host', 'error', 'PORT e CLIENT_PORT precisam ser distintas.'));
    } else {
      checks.push(check('ports', 'Portas e host', 'ok', 'PORT, CLIENT_PORT e HOST válidos (loopback).'));
    }
  } catch (err) {
    const name = variableNameOnly(err instanceof Error ? err.message : '');
    checks.push(check('ports', 'Portas e host', 'error', `Valor inválido em ${name}.`));
  }

  // 3. Runtime de voz: só existência de três caminhos fixos.
  if (env.RODRIGO_VOICE_DISABLE === '1') {
    checks.push(check('voice-runtime', 'Runtime de voz', 'info', 'Voz desabilitada explicitamente (RODRIGO_VOICE_DISABLE=1).'));
  } else {
    const missing = Object.entries(voiceRuntimePaths(rootDir))
      .filter(([, p]) => !exists(p))
      .map(([name]) => name);
    if (missing.length === 0) {
      checks.push(check('voice-runtime', 'Runtime de voz', 'ok', 'Python do runtime, worker e manifesto de modelos existem.'));
    } else {
      checks.push(check('voice-runtime', 'Runtime de voz', 'warn', `Faltando: ${missing.join(', ')}. Rode "npm run setup:voice". O resto do app continua funcionando.`));
    }
  }

  // 3b. T5b: política de arquivos sensíveis (só existência do arquivo + o estado declarado da aprovação; não abre o conteúdo).
  if (!exists(path.join(rootDir, 'config', 'sensitive-files.json'))) {
    checks.push(check('file-policy', 'Política de arquivos sensíveis', 'error', 'config/sensitive-files.json não existe: o worker recusa TODA leitura e escrita (falha fechada).'));
  } else if (!SENSITIVE_LIST_APPROVED) {
    checks.push(check('file-policy', 'Política de arquivos sensíveis', 'warn', 'A lista de arquivos sensíveis está em RASCUNHO (decisão 7 pendente de aprovação do Rodrigo). A política já se aplica, mas a lista pode ter lacunas.'));
  } else {
    checks.push(check('file-policy', 'Política de arquivos sensíveis', 'ok', 'Lista de arquivos sensíveis aprovada e presente.'));
  }

  if (cfg !== null) {
    const keyPresent = typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0;

    // 4. Modo de nuvem e chave (presença apenas; o valor nunca é lido para o relatório).
    if (!cfg.cloud) {
      checks.push(check('cloud-master', 'Nuvem (Gemini)', 'ok', 'Mestre RODRIGO_CLOUD=0: nenhuma chamada ao Gemini.'));
    } else if (!keyPresent) {
      checks.push(check('cloud-master', 'Nuvem (Gemini)', 'warn', 'Nuvem ligada, mas GEMINI_API_KEY não está no ambiente deste processo (o doctor T5a não abre o .env).'));
    } else {
      checks.push(check('cloud-master', 'Nuvem (Gemini)', 'info', 'Nuvem ligada e GEMINI_API_KEY presente no ambiente (valor não exibido).'));
    }

    // 5. Canais DECLARADOS como ligados (nomes apenas).
    if (cfg.cloud) {
      const on: string[] = [];
      if (cfg.cloudIntent) on.push('intenção');
      if (cfg.sendHistory) on.push('histórico');
      if (cfg.sendMemories) on.push('memórias');
      if (cfg.sendKnowledge) on.push('conhecimento');
      if (ttsCloudEffective(cfg)) on.push('voz (TTS)');
      if (cfg.cloudVision) on.push('visão');
      if (webSearchEffective(cfg)) on.push('busca web');
      checks.push(check('cloud-channels', 'Canais declarados como ligados', 'info', on.length ? on.join(', ') : 'nenhum além da geração de texto'));
    }

    // 6. Combinações de risco (avisos com gravidade). O app não conhece o nível da chave do Google.
    if (cfg.cloud && cfg.sendHistory && cfg.sendMemories) {
      checks.push(check('risk-history-memories', 'Histórico e memórias seguem ao Gemini', 'warn', 'O app não sabe o nível da chave: no nível gratuito o conteúdo pode ser usado para melhorar produtos. Confira o nível no painel do Google.'));
    }
    if (cfg.cloud && cfg.sendKnowledge) {
      checks.push(check('risk-knowledge', 'Trecho de conhecimento segue ao Gemini', 'warn', 'RODRIGO_SEND_KNOWLEDGE=1: um trecho de docs/research/ (material pessoal) vai ao prompt de geração.'));
    }
    if (cfg.cloud && cfg.cloudVision) {
      checks.push(check('risk-vision', 'Canal de visão ligado', 'warn', 'A imagem da tela pode ir ao Gemini sob autorização falada; nenhum guarda de texto cobre imagem. O canal é opt-in (RODRIGO_CLOUD_VISION=1); desligado por padrão.'));
    }
    if (webSearchEffective(cfg)) {
      checks.push(check('risk-web-search', 'Busca web autônoma ligada', 'warn', 'RODRIGO_WEB_SEARCH=1: leitura externa na nuvem sem autorização por pedido.'));
    }
    if (ttsDictatedViaCloud(cfg)) {
      checks.push(check('risk-tts-dictated', 'Conteúdo ditado vai à voz em nuvem', 'warn', 'Confirmações que repetem conteúdo ditado são enviadas ao TTS em nuvem. Desligue com RODRIGO_TTS_DICTATED=0 ou RODRIGO_SEND_MEMORIES=0.'));
    }
  }

  const summary: Record<DoctorSeverity, number> = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const c of checks) summary[c.severity] += 1;

  return { version: 1, generatedAt: now().toISOString(), summary, checks };
}

const MARK: Record<DoctorSeverity, string> = { ok: '[ok]  ', info: '[info]', warn: '[AVISO]', error: '[ERRO]' };

/** Texto para o terminal (npm run doctor). */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['Rodrigo AI — doctor (T5a: só configuração declarada; não abre .env, notas, memórias nem docs/research/)', ''];
  for (const c of report.checks) lines.push(`${MARK[c.severity]} ${c.title}: ${c.detail}`);
  const s = report.summary;
  lines.push('', `Resumo: ${s.ok} ok, ${s.info} info, ${s.warn} aviso(s), ${s.error} erro(s).`);
  lines.push('Este relatório não mede tráfego de rede: ele avisa sobre canais DECLARADOS como ligados.');
  return lines.join('\n');
}
