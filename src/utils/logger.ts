/**
 * Central stdout logger. No dependencies.
 *
 * [2026-09-15T06:04:14.994Z] [INFO]  [Auth]        ✅ user logged in → DEV
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'HALT';

const LEVEL_COL = 8;
const MODULE_COL = 14;

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

function padCol(text: string, width: number): string {
  const padded = text.padEnd(width);
  return padded.endsWith(' ') ? padded : `${padded} `;
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseModule(
  args: unknown[],
  fallback: string,
): { module: string; parts: unknown[] } {
  const first = args[0];
  if (typeof first === 'string') {
    const match = first.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    if (match) {
      const rest = match[2];
      const parts = rest.length > 0 ? [rest, ...args.slice(1)] : args.slice(1);
      return { module: match[1], parts: parts.length > 0 ? parts : [''] };
    }
  }
  return { module: fallback, parts: args };
}

function emit(level: LogLevel, fallbackModule: string, args: unknown[]): void {
  const { module, parts } = parseModule(args, fallbackModule);
  const ts = new Date().toISOString();
  const line = `[${ts}] ${padCol(`[${level}]`, LEVEL_COL)}${padCol(`[${module}]`, MODULE_COL)}${parts.map(stringify).join(' ')}`;
  if (level === 'ERROR' || level === 'HALT') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else if (level === 'DEBUG') console.debug(line);
  else console.log(line);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const e = error as { message?: string; code?: string; details?: string; hint?: string };
    return [e.message, e.code, e.details, e.hint].filter(Boolean).join(' ');
  }
  return error == null ? '' : String(error);
}

export function isMissingTableError(error: unknown): boolean {
  const t = errorText(error).toLowerCase();
  return (
    t.includes('could not find the table') ||
    t.includes('schema cache') ||
    t.includes('pgrst205') ||
    t.includes('42p01') ||
    (t.includes('relation') && t.includes('does not exist'))
  );
}

export function isSupabaseConnectionError(error: unknown): boolean {
  const t = errorText(error).toLowerCase();
  const code = String((error as { code?: string } | null)?.code || '').toUpperCase();
  return (
    ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'].includes(code) ||
    t.includes('invalid api key') ||
    t.includes('jwt expired') ||
    t.includes('not authorized') ||
    t.includes('fetch failed') ||
    t.includes('enotfound') ||
    t.includes('econnrefused') ||
    t.includes('etimedout') ||
    t.includes('credentials missing') ||
    t.includes('empty key')
  );
}

export function isApplyWizzUnreachableError(error: unknown): boolean {
  const e = error as { response?: { status?: number }; status?: number; code?: string };
  const status = e?.response?.status ?? e?.status;
  if (typeof status === 'number' && status >= 500) return true;
  const code = String(e?.code || '').toUpperCase();
  if (['ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) return true;
  const t = errorText(error).toLowerCase();
  return t.includes('timeout') || t.includes('timed out') || t.includes('network error');
}

/**
 * Logs a systemic halt and stops the process. Recoverable (single job / CAPTCHA / OTP) errors must not call this.
 */
export function haltWithDevAlert(module: string, message: string, error?: unknown): never {
  const cleaned = message.replace(/\s*Stopping pipeline\.?\s*$/i, '').replace(/\.\s*$/, '');
  let line = `🚨 DEV ACTION REQUIRED: ${cleaned}`;
  if (error != null) {
    const extra = errorText(error);
    if (extra && !cleaned.includes(extra)) {
      line += ` (${extra})`;
    }
  }
  emit('HALT', module, [`${line}. Stopping pipeline.`]);
  process.exit(1);
}

export function createLogger(module = 'App'): Logger {
  return {
    info: (...args: unknown[]) => emit('INFO', module, args),
    warn: (...args: unknown[]) => emit('WARN', module, args),
    error: (...args: unknown[]) => emit('ERROR', module, args),
    debug: (...args: unknown[]) => emit('DEBUG', module, args),
  };
}
