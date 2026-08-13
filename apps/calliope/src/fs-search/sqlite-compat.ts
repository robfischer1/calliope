/**
 * One SQLite handle for two runtimes (Findability F2): the compiled sidecar
 * runs on Bun (`bun:sqlite`), the vitest suite runs on Node
 * (`node:sqlite`). Both bundle SQLite with FTS5 enabled and expose the same
 * prepare/run/all/get surface — verified live on bun 1.3.14, node 22.23,
 * and a `bun build --compile` binary (specs/033-search-verb/research.md).
 * The node specifier is computed so neither bundler tries to resolve the
 * other runtime's module at build time.
 */

export interface CompatStatement {
  run(...args: unknown[]): { lastInsertRowid: number | bigint };
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
}

export interface CompatDatabase {
  exec(sql: string): void;
  prepare(sql: string): CompatStatement;
  close(): void;
}

export async function openDatabase(path: string): Promise<CompatDatabase> {
  if (process.versions.bun !== undefined) {
    const mod = await import("bun:sqlite");
    return new mod.Database(path, { create: true });
  }
  const spec = "node:sqlite";
  const mod = (await import(/* @vite-ignore */ spec)) as {
    DatabaseSync: new (p: string) => unknown;
  };
  return new mod.DatabaseSync(path) as CompatDatabase;
}
