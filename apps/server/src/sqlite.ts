// Loads node:sqlite while dropping only its "SQLite is an experimental feature" warning (Node 22).
// A static `import 'node:sqlite'` is linked before any code runs, so the module is required after the filter is set.
import { createRequire } from 'node:module';

type Sqlite = typeof import('node:sqlite');

const original = process.emitWarning;
process.emitWarning = function emitWarning(this: NodeJS.Process, warning: string | Error, ...rest: unknown[]): void {
  const message = typeof warning === 'string' ? warning : warning.message;
  const first = rest[0];
  const type =
    typeof first === 'string'
      ? first
      : ((first as { type?: string } | undefined)?.type ?? (typeof warning === 'string' ? undefined : warning.name));
  if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
  return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
} as typeof process.emitWarning;

export const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as Sqlite;
export type DatabaseSync = InstanceType<Sqlite['DatabaseSync']>;
