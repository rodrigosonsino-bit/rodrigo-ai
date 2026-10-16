# Auditoria Adversarial — Controle Desktop, DitadoLocal, Troca de Voz e Auto-Correção (v5)

- **Data:** 2026-10-16
- **Auditor:** `cursor-agent` (modo read-only / `--trust`)
- **Artefatos Auditados:**
  - `docs/plans/desktop-control-automation.md` (v5)
  - `src/backend/tools/desktopControlTool.ts`
  - `src/backend/voice/ttsProviders.ts`
  - `src/backend/voice/sessionManager.ts`
  - `src/backend/voice/voiceRuntime.ts`
  - `src/backend/tools/mutatingTools.ts`
  - `src/backend/voice/confirmationClassifier.ts`
  - `src/shared/voiceProtocol.ts`
  - `scripts/worker/worker.py`
  - `desktop/build.sh`
  - `src/backend/doctor.ts`

---

## 1. Síntese da Auditoria de Código (`cursor-agent`)

O auditor externo `cursor-agent` inspecionou estaticamente todos os módulos implementados para os 4 pilares e confirmou que:
1. **`R1–R5` (Invariantes de Segurança, Privacidade e Governança):** 100% atendidos no código implementado (`pendingPostSpeechAction` disparando apenas em `markPlayed()`, `DITADO_LOCAL` isento de injeção de teclas, `DIGITAR_TEXTO` com bloqueio de `DENIED_TYPING_BUNDLE_IDS`, pin de `targetBundleId` no `preview()` e restauração condicional do clipboard por `changeCount`).
2. **`AutoCorrecaoTool` (Pilar 4):** Spawn dedicado de `claude -p --permission-mode acceptEdits --tools Read,Write,Edit,Glob,Grep` (sem `Bash` e sem `bypassPermissions`) em `git worktree` descartável (`.runtime/worktrees/auto-fix-<id>`), verificação de não-deleção de testes em `src/**/__tests__` e validação via `execFile('npm', ['run', 'typecheck'])` + `execFile('npm', ['test'])`.
3. **Auditoria de `pendingDelegation` (`DELEGAR_CODIGO`):** Envolvido por `withAudit(this.decisionLog, ...)` + consumo one-shot de `confirmationToken` via `consumeMutationToken`.
4. **Disposição de `A3` (SLI de Latência):** Explicitada formalmente no plano.

### Observação Documental Apontada e Sanada
- **Apontamento:** Os trechos ilustrativos das seções 3.1, 3.2 e 4.4 de `docs/plans/desktop-control-automation.md` ainda exibiam assinaturas da revisão anterior em vez dos nomes de campos literais de `src/backend/voice/sessionManager.ts` (`run` e `this.runSubAgentDelegation`) e a lista completa de `TOOL_NAMES`/`MUTATION_NAMES` de `src/shared/voiceProtocol.ts`.
- **Resolução:** Os blocos das seções 3.1, 3.2 e 4.4 em `docs/plans/desktop-control-automation.md` foram sincronizados literalmente com `src/backend/voice/sessionManager.ts` e `src/shared/voiceProtocol.ts`.

---

## 2. Verificação de Testes Automatizados e Build

- `npm run typecheck`: **PASS (0 erros)**
- `npm run build`: **PASS (0 erros)**
- `node --test --import tsx src/backend/tools/__tests__/desktopControl.test.ts src/backend/voice/__tests__/voiceSwitching.test.ts src/backend/tools/__tests__/autoCorrection.test.ts`: **PASS (22/22 testes)**
- `python3 -m unittest scripts/worker/test_intent_parser.py scripts/worker/test_mutation_parser.py`: **PASS (67/67 testes)**
- Suíte global `npm test`: **PASS (895/895 testes)**

## 3. Veredito Final Consolidado
**APROVADO (Código + Plano v5 sincronizados e 100% dos testes verdes)**
