// Next replaces this expression at production build time. next.config.ts computes
// it from the exact executor/guard/connect sources; no runtime Git/env assertion.
export const BUILT_GUARD_REVISION = process.env.LINKI_BUILT_GUARD_REVISION || "";

type ExecutorEvidence = { revision: string };
const state = globalThis as typeof globalThis & { __linkiReadinessExecutor?: ExecutorEvidence };

// Called only by the existing executor loop, never by the readiness route.
export function recordExecutorStarted(loadedGuardRevision: string): void {
  if (loadedGuardRevision !== BUILT_GUARD_REVISION) { recordExecutorStopped(); return; }
  state.__linkiReadinessExecutor = { revision: loadedGuardRevision };
}

export function recordExecutorStopped(): void { delete state.__linkiReadinessExecutor; }

export function runningGuardRevision(): string | null {
  const evidence = state.__linkiReadinessExecutor;
  if (!/^sha256:[a-f0-9]{64}$/.test(BUILT_GUARD_REVISION) ||
      evidence?.revision !== BUILT_GUARD_REVISION) return null;
  return evidence.revision;
}
