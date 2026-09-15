/**
 * Central stdout logger. No dependencies.
 *
 * [2026-09-15T06:04:14.994Z] [INFO]  [Auth]        ✅ user logged in → DEV
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

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
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else if (level === 'DEBUG') console.debug(line);
  else console.log(line);
}

export function createLogger(module = 'App'): Logger {
  return {
    info: (...args: unknown[]) => emit('INFO', module, args),
    warn: (...args: unknown[]) => emit('WARN', module, args),
    error: (...args: unknown[]) => emit('ERROR', module, args),
    debug: (...args: unknown[]) => emit('DEBUG', module, args),
  };
}
