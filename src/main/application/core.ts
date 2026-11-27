// 组合本地服务：数据库、命令注册表、查询注册表（TD §4、§14）。
// 不依赖 Electron，便于在测试中用临时数据库构造。

import { join } from 'node:path';
import { chatCommands } from '../conversation/conversation-store';
import { notebookQueries } from '../domains/notebook-queries';
import { noteCommands, purgeExpiredNotes } from '../domains/notes';
import { reminderCommands, reminderQueries } from '../domains/reminders';
import { preferenceCommands, preferenceQueries } from '../domains/preferences';
import { purgeExpiredTasks, taskCommands } from '../domains/tasks';
import { AppSettings } from '../storage/app-settings';
import { Database } from '../storage/database';
import { systemClock, type Clock } from './clock';
import { CommandService } from './commands';
import { QueryService } from './queries';

export interface AppCore {
  db: Database;
  clock: Clock;
  settings: AppSettings;
  commands: CommandService;
  queries: QueryService;
  /** 启动和每天执行一次的维护：清理过期回收站 */
  maintain(): void;
  close(): void;
}

export function openDatabase(dataDir: string, clock: Clock = systemClock): Database {
  return Database.open(join(dataDir, 'desk-nest.db'), {
    backupPath: (fromVersion) =>
      join(dataDir, 'backups', `desk-nest-v${fromVersion}-${new Date(clock.now()).toISOString().replace(/[:.]/g, '-')}.db`),
  });
}

export function createAppCore(db: Database, clock: Clock = systemClock, newId?: () => string): AppCore {
  const commands = new CommandService(db, clock, newId);
  commands.register(...noteCommands, ...taskCommands, ...reminderCommands, ...preferenceCommands, ...chatCommands);

  const queries = new QueryService(db, clock);
  queries.register(...notebookQueries, ...reminderQueries, ...preferenceQueries);

  return {
    db,
    clock,
    settings: new AppSettings(db, () => clock.now()),
    commands,
    queries,
    maintain() {
      const now = clock.now();
      db.transaction(() => {
        purgeExpiredNotes(db, now);
        purgeExpiredTasks(db, now);
      });
    },
    close: () => db.close(),
  };
}
