// 本文件所有改动要求遵循 agent-rules 规范
// better-sqlite3 官方未内置类型声明，仓库也未在 runner 依赖中声明 @types/better-sqlite3；
// runner 仅把 better-sqlite3 作为「被测项目 SQLite 数据库」驱动使用，这里声明所需的最小接口。
declare module 'better-sqlite3' {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement<Result = unknown> {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): Result | undefined;
    all(...params: unknown[]): Result[];
  }

  export interface Database {
    prepare<Result = unknown>(source: string): Statement<Result>;
    exec(source: string): this;
    pragma(source: string): unknown;
    close(): this;
  }

  export interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }

  export default class BetterSqlite3 implements Database {
    constructor(filename: string, options?: Options);
    prepare<Result = unknown>(source: string): Statement<Result>;
    exec(source: string): this;
    pragma(source: string): unknown;
    close(): this;
  }
}
