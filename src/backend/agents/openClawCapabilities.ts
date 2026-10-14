/**
 * Escopo por capacidade do OpenClaw (docs/phase-15-v3.md §4.4).
 *
 * O coordenador registra UMA instância de OpenClawSubAgent por domínio declarado.
 * `openclaw_web` é o único wired nesta fatia; `openclaw_drive` / `openclaw_social`
 * ficam declaráveis (id, timeout, confirmação) mas sem wiring de cliente/HTTP.
 *
 * HONESTIDADE DE ESCOPO: o limite real do que o agente OpenClaw *faz* (navegar,
 * postar, alterar Drive, etc.) é responsabilidade compartilhada com a configuração
 * do próprio OpenClaw gateway/agente — este processo Node só declara o domínio e
 * aplica timeout/confirmação/privacidade locais. Não prometa isto como garantia
 * local de isolamento de ações no lado OpenClaw.
 */

import type { Capability } from './capabilityPolicy.js';

export type OpenClawCapabilityId = 'openclaw_web' | 'openclaw_drive' | 'openclaw_social';

export interface OpenClawCapabilitySpec {
  readonly id: OpenClawCapabilityId;
  readonly name: string;
  /** Timeout do modo curto (síncrono), em ms. */
  readonly shortTimeoutMs: number;
  /**
   * Se true, a delegação exige confirmationToken (tratada como mutação), mesmo
   * para "ler" — ex.: social, onde postar é irreversível e público.
   */
  readonly requiresConfirmation: boolean;
  /** false = declarável no registro, sem OpenClawHttpClient / sem execução. */
  readonly wired: boolean;
  /** T3: capacidades tipadas que este domínio declara; precisam coincidir com `EFFECTIVE_GRANTS` (teste de coerência). */
  readonly grants: readonly Capability[];
}

export const OPENCLAW_CAPABILITIES: readonly OpenClawCapabilitySpec[] = [
  {
    id: 'openclaw_web',
    name: 'OpenClaw Web',
    shortTimeoutMs: 15_000,
    requiresConfirmation: false,
    wired: true,
    grants: ['network']
  },
  {
    id: 'openclaw_drive',
    name: 'OpenClaw Drive',
    shortTimeoutMs: 15_000,
    requiresConfirmation: true,
    wired: false,
    grants: ['network', 'read_file']
  },
  {
    id: 'openclaw_social',
    name: 'OpenClaw Social',
    shortTimeoutMs: 15_000,
    requiresConfirmation: true,
    wired: false,
    grants: ['network']
  }
];

export function getOpenClawCapability(id: string): OpenClawCapabilitySpec | undefined {
  return OPENCLAW_CAPABILITIES.find((c) => c.id === id);
}
