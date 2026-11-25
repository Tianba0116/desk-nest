import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SavedPlacementSchema, SettingsPlacementStore } from '../../src/main/desktop/placement-store';
import { AppSettings, importLegacyJson } from '../../src/main/storage/app-settings';
import { Database } from '../../src/main/storage/database';
import { MIGRATIONS, type Migration } from '../../src/main/storage/migrations';

describe('Database 迁移', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-nest-db-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const file = (): string => join(dir, 'test.db');
  const backup = (v: number): string => join(dir, 'backups', `v${v}.db`);

  it('新库执行全部迁移，版本号等于最新迁移', () => {
    const db = Database.open(file());
    expect(db.schemaVersion).toBe(MIGRATIONS.at(-1)?.version);
    db.close();
  });

  it('升级已有数据库前先备份；新库不备份', () => {
    const v1: Migration[] = [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x INTEGER)' }];
    const db1 = Database.open(file(), { migrations: v1, backupPath: backup });
    db1.run('INSERT INTO a VALUES (1)');
    db1.close();
    expect(existsSync(join(dir, 'backups'))).toBe(false);

    const v2 = [...v1, { version: 2, name: 'b', sql: 'ALTER TABLE a ADD COLUMN y TEXT' }];
    const db2 = Database.open(file(), { migrations: v2, backupPath: backup });
    expect(db2.schemaVersion).toBe(2);
    db2.close();
    expect(readdirSync(join(dir, 'backups'))).toEqual(['v1.db']);
    const old = Database.open(backup(1), { migrations: [] });
    expect(old.schemaVersion).toBe(1);
    expect(old.all('SELECT x FROM a')).toEqual([{ x: 1 }]);
    old.close();
  });

  it('迁移失败时回滚，原有数据和版本不变', () => {
    const v1: Migration[] = [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x INTEGER)' }];
    Database.open(file(), { migrations: v1 }).close();
    const broken = [...v1, { version: 2, name: 'bad', sql: 'CREATE TABLE b (x); SELECT * FROM missing_table;' }];
    expect(() => Database.open(file(), { migrations: broken, backupPath: backup })).toThrow();
    const db = Database.open(file(), { migrations: v1 });
    expect(db.schemaVersion).toBe(1);
    expect(db.get("SELECT 1 FROM sqlite_master WHERE name = 'b'")).toBeUndefined();
    db.close();
  });

  it('事务内抛错整体回滚；嵌套事务并入外层', () => {
    const db = Database.open(file(), { migrations: [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x)' }] });
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO a VALUES (1)');
        db.transaction(() => db.run('INSERT INTO a VALUES (2)'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.all('SELECT x FROM a')).toEqual([]);
    db.close();
  });

  it('事务内不能返回 Promise', () => {
    const db = Database.open(file(), { migrations: [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x)' }] });
    expect(() => db.transaction(() => Promise.resolve(1))).toThrow('异步');
    db.close();
  });
});

describe('app_settings 与旧 JSON 导入', () => {
  let dir: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-nest-settings-'));
    db = Database.open(join(dir, 'x.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const placement = { displayId: 1, displayBounds: { x: 0, y: 0, width: 100, height: 100 }, relX: 0.5, relY: 1 };

  it('读写设置，无效内容返回 null', () => {
    const settings = new AppSettings(db);
    settings.set('k', placement);
    expect(settings.get('k', SavedPlacementSchema)).toEqual(placement);
    settings.set('k', { bad: true });
    expect(settings.get('k', SavedPlacementSchema)).toBeNull();
  });

  it('首次启动导入旧 JSON，并把旧文件改名', () => {
    const settings = new AppSettings(db);
    const legacy = join(dir, 'pet-placement.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, placement }));
    importLegacyJson(settings, SettingsPlacementStore.key, legacy, () => placement);
    expect(new SettingsPlacementStore(settings).load()).toEqual(placement);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.imported`)).toBe(true);
  });

  it('数据库里已有值时不覆盖', () => {
    const settings = new AppSettings(db);
    const store = new SettingsPlacementStore(settings);
    store.save({ ...placement, relX: 0.1 });
    const legacy = join(dir, 'pet-placement.json');
    writeFileSync(legacy, '{}');
    importLegacyJson(settings, SettingsPlacementStore.key, legacy, () => placement);
    expect(store.load()?.relX).toBe(0.1);
    expect(existsSync(legacy)).toBe(true);
  });
});
