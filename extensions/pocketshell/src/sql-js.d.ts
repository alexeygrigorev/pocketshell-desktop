/**
 * Type declarations for sql.js (pure WASM SQLite).
 *
 * Covers the subset of the API used by PocketShell's host-store.
 */

declare module 'sql.js' {
  export interface Database {
    run(sql: string, params?: (string | number | null | Uint8Array)[]): Database;
    exec(sql: string, params?: (string | number | null | Uint8Array)[]): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface Statement {
    bind(params?: (string | number | null | Uint8Array)[]): boolean;
    step(): boolean;
    get(): (string | number | null | Uint8Array)[];
    getColumnNames(): string[];
    free(): boolean;
  }

  export interface QueryExecResult {
    columns: string[];
    values: (string | number | null | Uint8Array)[][];
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer) => Database;
  }

  export type InitSqlJs = () => Promise<SqlJsStatic>;
  const initSqlJs: InitSqlJs;
  export default initSqlJs;
}
