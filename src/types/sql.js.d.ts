declare module 'sql.js' {
    interface SqlJsStatic {
        Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
    }

    interface Database {
        exec(sql: string, params?: unknown[]): QueryExecResult[];
        run(sql: string, params?: unknown[] | Record<string, unknown>): Database;
        prepare(sql: string): Statement;
        export(): Uint8Array;
        close(): void;
    }

    interface Statement {
        run(params?: Record<string, unknown> | unknown[]): void;
        bind(params?: Record<string, unknown> | unknown[]): boolean;
        step(): boolean;
        get(params?: Record<string, unknown> | unknown[]): unknown[];
        free(): boolean;
    }

    interface QueryExecResult {
        columns: string[];
        values: unknown[][];
    }

    interface InitSqlJsOptions {
        locateFile?: (file: string) => string;
    }

    export default function initSqlJs(options?: InitSqlJsOptions): Promise<SqlJsStatic>;
    export { Database, Statement, QueryExecResult, SqlJsStatic, InitSqlJsOptions };
}
