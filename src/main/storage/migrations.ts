// 数据库迁移。按里程碑逐步追加，已发布的迁移不能修改，只能追加新版本（TD §5.2、§13.1）。

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'M3：设置、命令收据、笔记、待办',
    sql: `
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      -- 仅保存已提交命令的结果；同 operation_id 重试返回原结果（TD §6.2）
      CREATE TABLE command_receipts (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX notes_live ON notes (deleted_at, updated_at);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'done')),
        due_at INTEGER,
        progress_note TEXT NOT NULL DEFAULT '',
        progress_updated_at INTEGER,
        completed_at INTEGER,
        search_text TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX tasks_live ON tasks (deleted_at, status, updated_at);
    `,
  },
  {
    version: 2,
    name: 'M4：时间计划与信箱',
    sql: `
      -- 一次性提醒（M7 起增加 follow_up）。数据库记录是提醒的唯一真相（TD §8.2）
      CREATE TABLE scheduled_actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('reminder', 'follow_up')),
        content TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        time_zone TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'materialized', 'cancelled')),
        cancel_reason TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        source_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX scheduled_due ON scheduled_actions (status, due_at);
      CREATE INDEX scheduled_target ON scheduled_actions (target_type, target_id, status);

      -- 信箱：用户可以回看的事项；内容存在不等于弹过气泡（TD §11）
      CREATE TABLE inbox_items (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('unread', 'read', 'dismissed', 'invalidated')),
        due_at INTEGER,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        invalidated_at INTEGER,
        shown_at INTEGER,
        popup_skipped_at INTEGER,
        UNIQUE (source_type, source_id, source_revision, category)
      );
      CREATE INDEX inbox_status ON inbox_items (status, created_at);
    `,
  },
  {
    version: 3,
    name: 'M5：对话轮次与消息',
    sql: `
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('requesting', 'responding', 'completed', 'failed', 'cancelled', 'interrupted')),
        error_code TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX turns_conversation ON turns (conversation_id, created_at);
      -- 同一对话同一时间最多一个进行中的轮次（TD §7.2）
      CREATE UNIQUE INDEX turns_one_active ON turns (conversation_id) WHERE state IN ('requesting', 'responding');

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'pending_retry', 'complete', 'streaming', 'cancelled', 'failed', 'interrupted')),
        context_excluded_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX messages_conversation ON messages (conversation_id, created_at);
    `,
  },
  {
    version: 4,
    name: 'M6：显式偏好、模型动作账本',
    sql: `
      -- 显式偏好（R10）：用户直接设置或在对话中明确说出的值
      CREATE TABLE preferences (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        source_message_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      -- 模型动作账本（TD §5.2、§6.3）：先记录再执行；重试和重启时据此恢复，不重新执行
      CREATE TABLE turn_actions (
        operation_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        args_json TEXT NOT NULL,
        args_hash TEXT,
        state TEXT NOT NULL CHECK (state IN ('awaiting_input', 'ready', 'committed', 'failed', 'cancelled', 'resolved')),
        missing_json TEXT,
        question TEXT,
        suggestion_json TEXT,
        error_code TEXT,
        error_detail TEXT,
        result_json TEXT,
        resolved_by TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX turn_actions_turn ON turn_actions (turn_id, ordinal);
      CREATE INDEX turn_actions_message ON turn_actions (user_message_id, state);
      CREATE INDEX turn_actions_state ON turn_actions (state);

      -- 对比流式方案用的计时与计数（D-06）
      ALTER TABLE turns ADD COLUMN strategy TEXT;
      ALTER TABLE turns ADD COLUMN metrics_json TEXT;
      ALTER TABLE notes ADD COLUMN source_message_id TEXT;
    `,
  },
];
