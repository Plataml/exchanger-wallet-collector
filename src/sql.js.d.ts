declare module 'sql.js' {
  interface SqlJsStatic {
    Database: typeof Database;
  }

  class Database {
    constructor(data?: ArrayLike<number>);
    run(sql: string, params?: any[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  interface Statement {
    bind(params?: any[]): boolean;
    step(): boolean;
    getAsObject(params?: any): Record<string, any>;
    free(): boolean;
    run(params?: any[]): void;
  }

  interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
  export { Database, Statement, SqlJsStatic };
}
