declare module 'sql.js' {
  interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }
  interface Database {
    exec(sql: string): QueryExecResult[];
    close(): void;
  }
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }
  interface InitSqlJsOptions {
    locateFile?: (file: string) => string;
  }
  export default function initSqlJs(options?: InitSqlJsOptions): Promise<SqlJsStatic>;
}
