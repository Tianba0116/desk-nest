// SQLite 单一写入口（TD §3.2、§4.1）。驱动：Electron 内置 Node 的 node:sqlite（D-05）。
// 所有方法同步执行；事务里不能 await，也不能发网络请求。

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations';

export type SqlValue = SQLInputValue;
export type Row = Record<string, unknown>;

export class Database {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 打开（必要时创建）数据库，执行迁移。backupDir 用于存放升级前备份 */
  static open(
    filePath: string,
    options: { migrations?: readonly Migration[]; backupPath?: (fromVersion: number) => string } = {},
  ): Database {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 2000');
    const database = new Database(db);
    try {
      database.migrate(options.migrations ?? MIGRATIONS, options.backupPath);
    } catch (error) {
      // 释放文件句柄，否则 Windows 上数据库文件会一直被占用
      database.close();
      throw error;
    }
    return database;
  }

  get schemaVersion(): number {
    return Number(this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    const result = this.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  /**
   * 同步事务。嵌套调用并入外层事务。fn 抛错时整体回滚。
   * BEGIN IMMEDIATE：一开始就拿写锁，避免读后写的升级冲突。
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('事务内不能使用异步操作');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  /** 一致性备份（WAL 下不能只复制主文件，TD §13.1） */
  backupTo(targetPath: string): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    this.db.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`);
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * 逐个执行未应用的迁移，每个迁移和版本号在同一事务里提交。
   * 已有数据的库升级前先备份；迁移失败时抛错，旧数据保持不变（不删库重建）。
   */
  private migrate(migrations: readonly Migration[], backupPath?: (fromVersion: number) => string): void {
    const current = this.schemaVersion;
    const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
    if (pending.length === 0) return;
    if (current > 0 && backupPath) {
      const target = backupPath(current);
      if (!existsSync(target)) this.backupTo(target);
    }
    for (const migration of pending) {
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }
}
