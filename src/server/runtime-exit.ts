type RuntimeExit = { code: number | null; signal: string | null; stderrTail?: string };

function orderlyExit(code: number | null, signal: string | null): boolean {
  return signal !== null ? signal === 'SIGTERM' || signal === 'SIGHUP' : code === 0 || code === 129 || code === 143;
}

export function exitError(code: number | null, signal: string | null, stderrTail = ''): Error {
  const status = signal && code !== null ? `${signal}; code ${code}` : signal ?? code;
  const tail = stderrTail.trim();
  return new Error(`Pi process exited (${status})${tail ? `:\n${tail}` : ''}`);
}

export function exitNotice(code: number | null, signal: string | null, host: string | null): string | null {
  return orderlyExit(code, signal) ? `This agent was closed${host ? ` in ${host}` : ''}.` : null;
}

/** Parent cleanup can succeed even when the worker itself failed. */
export function workerExitReport(exit?: RuntimeExit | null): { message: string; notice: boolean } | undefined {
  if (!exit) return undefined;
  if (!orderlyExit(exit.code, exit.signal)) return { message: exitError(exit.code, exit.signal, exit.stderrTail).message, notice: false };
  const tail = exit.stderrTail?.trim();
  return { message: `This worker was closed.${tail ? `\n${tail}` : ''}`, notice: true };
}
