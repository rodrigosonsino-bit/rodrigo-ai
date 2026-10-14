/**
 * T3 (docs/plans/openjarvis-voz-desktop-v2.md §3.3): permissões por capacidade, NEGAR POR PADRÃO.
 *
 * Duas fontes que precisam concordar (teste de coerência):
 *  - a DECLARAÇÃO do agente (`ISubAgent.grants`), no registro;
 *  - a POLÍTICA EFETIVA (`EFFECTIVE_GRANTS`), uma tabela independente aqui.
 * O que vale em tempo de execução é a INTERSEÇÃO: declarar uma capacidade que a política não concede não a ativa, e uma
 * concedida que o agente não declarou também não. Agente desconhecido não recebe nada.
 *
 * O ponto único de aplicação fica em `SessionManager.delegateToSubAgent`, imediatamente antes de `runTask`: se faltar
 * qualquer capacidade exigida pela operação, o agente NEM É INVOCADO.
 */
export const CAPABILITIES = ['read_file', 'write_file', 'shell', 'browser', 'network', 'sensitive_data'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);
}

export type GrantTable = Readonly<Record<string, readonly Capability[]>>;

/** Política efetiva: o que cada agente PODE usar. Fora desta tabela = nada. `sensitive_data` nunca é concedida por padrão. */
export const EFFECTIVE_GRANTS: GrantTable = {
  openclaw_web: ['network'],
  openclaw_drive: ['network', 'read_file'],
  openclaw_social: ['network'],
  // Ferramentas locais que MUTAM (gravam nos stores de dados do app): exigem e recebem `write_file`.
  tool_lembrete: ['write_file'],
  tool_nota: ['write_file'],
  tool_memoria: ['write_file'],
  // Fase 17: delegação ao Claude Code — processo (`shell`) que lê arquivos (`read_file`) e grava o registro da tarefa no store do app.
  // NÃO concede `network` ao app (a rede é do processo filho, sob o canal RODRIGO_CLAUDE_CODE) nem `sensitive_data`.
  tool_claude: ['write_file', 'shell', 'read_file']
};

/** Capacidades que a simples existência da operação já exige (ex.: o agente web sempre usa a rede). */
export const IMPLIED_NEEDS: GrantTable = {
  openclaw_web: ['network'],
  openclaw_drive: ['network', 'read_file'],
  openclaw_social: ['network']
};

export interface PolicySubject {
  readonly id: string;
  readonly grants?: readonly Capability[];
}

export type CapabilityVerdict = { allowed: true } | { allowed: false; missing: Capability[] };

export class CapabilityPolicy {
  constructor(
    private readonly effective: GrantTable = EFFECTIVE_GRANTS,
    private readonly implied: GrantTable = IMPLIED_NEEDS
  ) {}

  /** Interseção entre o declarado e o efetivo; agente sem declaração ou fora da tabela => conjunto vazio. */
  granted(agent: PolicySubject): Set<Capability> {
    const allowedByPolicy = new Set(this.effective[agent.id] ?? []);
    return new Set((agent.grants ?? []).filter((c) => allowedByPolicy.has(c)));
  }

  /** O que a operação exige: o pedido explícito + o implícito do agente + dado sensível declarado no contexto. */
  needsFor(agent: PolicySubject, req: { needs?: readonly Capability[]; context?: Record<string, unknown>; isMutation?: boolean }): Capability[] {
    const out = new Set<Capability>(req.needs ?? []);
    // Achado da auditoria do Codex: TODA mutação grava dados, então exige `write_file` mesmo que o chamador esqueça de declarar.
    if (req.isMutation) out.add('write_file');
    for (const c of this.implied[agent.id] ?? []) out.add(c);
    if (req.context && req.context.dataClass === 'sensitive') out.add('sensitive_data');
    return [...out];
  }

  check(agent: PolicySubject, needs: readonly Capability[]): CapabilityVerdict {
    const have = this.granted(agent);
    const missing = needs.filter((c) => !have.has(c));
    return missing.length === 0 ? { allowed: true } : { allowed: false, missing };
  }

  /** Coerência declaração x política efetiva: devolve as divergências (lista vazia = coerente). */
  coherenceErrors(agents: readonly PolicySubject[]): string[] {
    const errors: string[] = [];
    for (const a of agents) {
      const declared = new Set(a.grants ?? []);
      const effective = new Set(this.effective[a.id] ?? []);
      for (const c of declared) if (!effective.has(c)) errors.push(`${a.id} declara '${c}' sem política efetiva`);
      for (const c of effective) if (!declared.has(c)) errors.push(`${a.id} tem '${c}' na política efetiva mas não declara`);
    }
    return errors;
  }
}

export const DEFAULT_CAPABILITY_POLICY = new CapabilityPolicy();
