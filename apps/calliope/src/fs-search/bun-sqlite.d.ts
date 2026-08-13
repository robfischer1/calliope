/**
 * Minimal ambient typing for `bun:sqlite` — the repo typechecks under tsc
 * with @types/node (no bun-types), but the sidecar's runtime IS Bun. Only
 * the surface sqlite-compat.ts touches is declared.
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, opts?: { create?: boolean });
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): { lastInsertRowid: number | bigint };
      all(...args: unknown[]): unknown[];
      get(...args: unknown[]): unknown;
    };
    close(): void;
  }
}
