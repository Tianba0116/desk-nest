// 上下文版本与历史下限（TD §9.4）。纠正或忘记时在同一事务里：
// 递增 contextEpoch、把历史下限设为此刻（之后只带此刻以后的聊天历史），并排除可识别的来源消息。

import type { Database } from '../storage/database';

const EPOCH_KEY = 'context.epoch';
const FLOOR_KEY = 'context.historyFloor';

export interface ContextState {
  epoch: number;
  /** 只携带 created_at 晚于这个时刻的聊天历史；0 表示不限 */
  historyFloor: number;
}

function readNumber(db: Database, key: string): number {
  const row = db.get<{ value_json: string }>('SELECT value_json FROM app_settings WHERE key = ?', key);
  if (!row) return 0;
  const value = Number(JSON.parse(row.value_json));
  return Number.isFinite(value) ? value : 0;
}

function writeNumber(db: Database, key: string, value: number, now: number): void {
  db.run(
    `INSERT INTO app_settings (key, value_json, schema_version, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    now,
  );
}

export function readContextState(db: Database): ContextState {
  return { epoch: readNumber(db, EPOCH_KEY), historyFloor: readNumber(db, FLOOR_KEY) };
}

/**
 * 纠正或忘记：在调用方的事务里执行。
 * excludeMessageIds：可以识别的来源消息（例如“记住我对花生过敏”那一句），以后不会再被读取。
 */
export function bumpContext(db: Database, now: number, reason: string, excludeMessageIds: Array<string | null> = []): ContextState {
  const state = readContextState(db);
  const next = { epoch: state.epoch + 1, historyFloor: Math.max(state.historyFloor, now) };
  writeNumber(db, EPOCH_KEY, next.epoch, now);
  writeNumber(db, FLOOR_KEY, next.historyFloor, now);
  for (const id of excludeMessageIds) {
    if (!id) continue;
    db.run(
      `INSERT OR IGNORE INTO context_exclusions (source_type, source_id, reason, created_at) VALUES ('message', ?, ?, ?)`,
      id,
      reason,
      now,
    );
  }
  return next;
}
