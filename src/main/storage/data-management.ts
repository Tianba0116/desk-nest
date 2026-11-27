// 数据导出、恢复、清除与恢复界面（R19.AC-3～5、AC-8、TD §13.2）。不依赖 Electron，便于测试。
//
// 恢复：校验导出文件 → 在临时数据库里按导出时的版本重建、写入、再迁移到当前版本并检查 →
// 写入“待处理”标记 → 应用重启后、打开数据库之前：备份当前数据库，再整体替换。任何一步失败，现有数据保持不变。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from './database';
import { MIGRATIONS } from './migrations';

export const DB_FILE = 'desk-nest.db';
const RESTORE_FILE = 'desk-nest.restore.db';
const PENDING_FILE = 'pending-data-op.json';
export const EXPORT_FORMAT = 'desk-nest-export';
export const EXPORT_FORMAT_VERSION = 1;
/** 导出文件大小上限 */
export const EXPORT_MAX_BYTES = 200 * 1024 * 1024;

/** 不导出：命令收据只用于防重复，恢复后重新开始；密钥只在本机加密保存（R19.AC-3） */
const SKIP_TABLES = new Set(['command_receipts']);
const SECRET_SETTING_KEYS = new Set(['model.secret']);

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

export class DataError extends Error {}

function userTables(db: Database): string[] {
  return db
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .map((t) => t.name);
}

export function exportSnapshot(db: Database, appVersion: string, now: number): ExportFile {
  const tables: ExportFile['tables'] = {};
  for (const name of userTables(db)) {
    if (SKIP_TABLES.has(name)) continue;
    let rows = db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`);
    if (name === 'app_settings') rows = rows.filter((r) => !SECRET_SETTING_KEYS.has(String(r['key'])));
    tables[name] = rows;
  }
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: db.schemaVersion,
    appVersion,
    exportedAt: new Date(now).toISOString(),
    tables,
  };
}

export interface RestoreSummary {
  exportedAt: string;
  appVersion: string;
  counts: Record<string, number>;
}

const SUMMARY_TABLES: Record<string, string> = {
  notes: '笔记',
  tasks: '待办',
  topics: '事项',
  memories: '记忆',
  scheduled_actions: '提醒和跟进',
  messages: '聊天消息',
  focus_sessions: '专注记录',
};

function parseExport(text: string): ExportFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DataError('文件不是有效的导出文件');
  }
  const file = data as Partial<ExportFile>;
  if (file?.format !== EXPORT_FORMAT || typeof file.schemaVersion !== 'number' || typeof file.tables !== 'object' || !file.tables) {
    throw new DataError('文件不是 DeskNest 的导出文件');
  }
  if ((file.formatVersion ?? 0) > EXPORT_FORMAT_VERSION) throw new DataError('导出文件来自更新的版本，请先升级应用');
  const latest = MIGRATIONS.at(-1)?.version ?? 0;
  if (file.schemaVersion > latest) throw new DataError('导出文件来自更新的版本，请先升级应用');
  if (file.schemaVersion < 1) throw new DataError('导出文件的版本不正确');
  return file as ExportFile;
}

/**
 * 在临时数据库里重建导出的数据：先建到导出时的版本并写入，再迁移到当前版本，最后做完整性检查。
 * 成功后 targetPath 是一份可以直接替换的数据库文件；失败时删除它并抛出 DataError。
 */
export function buildRestoreDatabase(text: string, targetPath: string): RestoreSummary {
  const file = parseExport(text);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${targetPath}${suffix}`, { force: true });
  let db: Database | null = null;
  try {
    db = Database.open(targetPath, { migrations: MIGRATIONS.filter((m) => m.version <= file.schemaVersion) });
    const tables = new Set(userTables(db));
    db.transaction(() => {
      for (const [name, rows] of Object.entries(file.tables)) {
        if (!tables.has(name)) throw new DataError(`导出文件里有未知的数据表：${name}`);
        if (!Array.isArray(rows)) throw new DataError(`数据表 ${name} 的格式不正确`);
        const columns = new Set((db as Database).all<{ name: string }>(`PRAGMA table_info("${name}")`).map((c) => c.name));
        for (const row of rows) {
          const keys = Object.keys(row ?? {});
          for (const key of keys) if (!columns.has(key)) throw new DataError(`数据表 ${name} 里有未知的字段：${key}`);
          if (keys.length === 0) continue;
          (db as Database).run(
            `INSERT INTO "${name}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
            ...keys.map((k) => {
              const v = (row as Record<string, unknown>)[k];
              if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
              throw new DataError(`数据表 ${name} 的字段 ${k} 格式不正确`);
            }),
          );
        }
      }
    });
    db.close();
    // 迁移到当前版本
    db = Database.open(targetPath);
    const integrity = db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check;
    if (integrity !== 'ok') throw new DataError('重建后的数据没有通过完整性检查');
    const counts: Record<string, number> = {};
    for (const [table, label] of Object.entries(SUMMARY_TABLES)) {
      counts[label] = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`)?.n ?? 0;
    }
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
    return { exportedAt: file.exportedAt, appVersion: file.appVersion, counts };
  } catch (error) {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${targetPath}${suffix}`, { force: true });
    if (error instanceof DataError) throw error;
    throw new DataError(`导出文件无法恢复：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 准备恢复：重建成功后写入标记，等应用重启时替换 */
export function stageRestore(dataDir: string, text: string, now: number): RestoreSummary {
  if (Buffer.byteLength(text) > EXPORT_MAX_BYTES) throw new DataError('导出文件太大');
  const summary = buildRestoreDatabase(text, join(dataDir, RESTORE_FILE));
  writeFileSync(join(dataDir, PENDING_FILE), JSON.stringify({ op: 'restore', at: now }));
  return summary;
}

/** 准备清除所有数据（R19.AC-8）：应用重启时执行 */
export function stageClear(dataDir: string, now: number): void {
  writeFileSync(join(dataDir, PENDING_FILE), JSON.stringify({ op: 'clear', at: now }));
}

export function cancelStaged(dataDir: string): void {
  rmSync(join(dataDir, PENDING_FILE), { force: true });
  rmSync(join(dataDir, RESTORE_FILE), { force: true });
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

function moveDbFiles(from: string, to: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${from}${suffix}`)) renameSync(`${from}${suffix}`, `${to}${suffix}`);
  }
}

function removeDbFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

export type PendingResult =
  | { op: 'none' }
  | { op: 'restore'; backupPath: string | null }
  | { op: 'clear' }
  | { op: 'failed'; message: string };

/**
 * 应用启动、打开数据库之前调用：执行上次准备好的恢复或清除。
 * 恢复前把当前数据库移到 backups/；替换失败时放回原处。
 */
export function applyPendingDataOp(dataDir: string, now: number): PendingResult {
  const pendingPath = join(dataDir, PENDING_FILE);
  if (!existsSync(pendingPath)) return { op: 'none' };
  let op: string;
  try {
    op = (JSON.parse(readFileSync(pendingPath, 'utf8')) as { op?: string }).op ?? '';
  } catch {
    op = '';
  }
  rmSync(pendingPath, { force: true });
  const dbPath = join(dataDir, DB_FILE);
  if (op === 'clear') {
    removeDbFiles(dbPath);
    removeDbFiles(join(dataDir, RESTORE_FILE));
    rmSync(join(dataDir, 'backups'), { recursive: true, force: true });
    return { op: 'clear' };
  }
  if (op !== 'restore') return { op: 'none' };
  const restorePath = join(dataDir, RESTORE_FILE);
  if (!existsSync(restorePath)) return { op: 'failed', message: '找不到准备好的恢复数据' };
  let backupPath: string | null = null;
  try {
    if (existsSync(dbPath)) {
      mkdirSync(join(dataDir, 'backups'), { recursive: true });
      backupPath = join(dataDir, 'backups', `desk-nest-before-restore-${stamp(now)}.db`);
      moveDbFiles(dbPath, backupPath);
    }
    renameSync(restorePath, dbPath);
    return { op: 'restore', backupPath };
  } catch (error) {
    // 替换失败：把原来的数据放回去
    if (backupPath && !existsSync(dbPath)) moveDbFiles(backupPath, dbPath);
    return { op: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** 数据库打不开时（R19.AC-5）：最近的一份备份 */
export function latestBackup(dataDir: string): string | null {
  const dir = join(dataDir, 'backups');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path ?? null;
}

/** 从备份恢复：打不开的数据库移到一边保留（不删除），再复制备份 */
export function restoreFromBackup(dataDir: string, backupPath: string, now: number): string {
  const dbPath = join(dataDir, DB_FILE);
  const brokenPath = join(dataDir, `desk-nest.unreadable-${stamp(now)}.db`);
  moveDbFiles(dbPath, brokenPath);
  copyFileSync(backupPath, dbPath);
  return brokenPath;
}
