// 显式偏好（R10）：称呼和表达方式。用户在小窝里直接设置，或在对话中明确说出（“叫我小林”“说话简短一点”）。
// 显式偏好是这些值的唯一来源；模型推测的内容不能写入这里（R10.AC-5）。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import { NICKNAME_MAX, STYLE_LABELS, STYLES, type PreferencesDto, type Style } from '../../shared/contracts/preferences';
import { CommandError, defineCommand, sourceMessageId } from '../application/commands';
import { bumpContext } from '../application/context-state';
import { defineQuery } from '../application/queries';
import type { Database } from '../storage/database';

interface PreferenceRow {
  key: string;
  value_json: string;
  revision: number;
  updated_at: number;
}

const NICKNAME_KEY = 'nickname';
const STYLE_KEY = 'style';

const Nickname = z
  .string()
  .trim()
  .min(1, '称呼不能为空')
  .max(NICKNAME_MAX, `称呼最多 ${NICKNAME_MAX} 个字`)
  .refine((v) => !/[\r\n]/.test(v), '称呼不能换行');

function readRow(db: Database, key: string): PreferenceRow | undefined {
  return db.get<PreferenceRow>('SELECT key, value_json, revision, updated_at FROM preferences WHERE key = ?', key);
}

function readValue<S extends z.ZodType>(db: Database, key: string, schema: S): z.output<S> | null {
  const row = readRow(db, key);
  if (!row) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readPreferences(db: Database): PreferencesDto {
  return {
    nickname: readValue(db, NICKNAME_KEY, Nickname),
    style: readValue(db, STYLE_KEY, z.enum(STYLES)),
    revision: readRow(db, NICKNAME_KEY)?.revision ?? 0,
  };
}

function writeValue(db: Database, key: string, value: unknown, sourceMessage: string | null, now: number): void {
  db.run(
    `INSERT INTO preferences (key, value_json, source_message_id, revision, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, source_message_id = excluded.source_message_id,
       revision = preferences.revision + 1, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    sourceMessage,
    now,
  );
}

export const setNickname = defineCommand({
  name: 'preferences.setNickname',
  input: z.object({
    /** null：清除称呼 */
    nickname: Nickname.nullable(),
    /** 小窝表单带上看到的版本，防止覆盖别处的修改；对话不带 */
    revision: z.number().int().min(0).optional(),
  }),
  // 改称呼是一次纠正：旧称呼不再通过聊天历史出现（R10.AC-3、TD §9.4）
  invalidates: ['settings', 'context'],
  tool: {
    description:
      '设置用户希望被怎样称呼。只有用户明确要求时调用，例如“叫我小林”“以后别叫我小林了”（清除时 nickname 填 null）。不要根据聊天内容自己猜。',
    parameters: z.object({
      nickname: z.string().trim().min(1).max(NICKNAME_MAX).nullable().describe('用户要求的称呼，按原话填；清除称呼填 null'),
    }),
    risk: 'undoable',
    summarize(result) {
      const r = result as PreferencesDto;
      return r.nickname ? `之后称呼用户为“${r.nickname}”` : '已清除称呼';
    },
    card(_db, result) {
      return { nickname: (result as PreferencesDto).nickname };
    },
  },
  execute({ db, now, meta }, input): PreferencesDto {
    const current = readRow(db, NICKNAME_KEY);
    if (input.revision !== undefined && (current?.revision ?? 0) !== input.revision) {
      throw new CommandError(CommandErrorCodes.revisionConflict, '称呼已在别处修改，请刷新后重试');
    }
    const before = readPreferences(db).nickname;
    if (input.nickname === null) db.run('DELETE FROM preferences WHERE key = ?', NICKNAME_KEY);
    else writeValue(db, NICKNAME_KEY, input.nickname, sourceMessageId(db, meta), now);
    if (before !== input.nickname) bumpContext(db, now, 'nickname');
    return readPreferences(db);
  },
});

export const setStyle = defineCommand({
  name: 'preferences.setStyle',
  input: z.object({ style: z.enum(STYLES).nullable() }),
  invalidates: ['settings'],
  tool: {
    description:
      '设置你说话的方式。只有用户明确要求时调用：“说话简短一点”填 brief，“活泼一点”填 lively，“温柔一点”填 gentle，“恢复默认”填 null。',
    parameters: z.object({ style: z.enum(STYLES).nullable().describe('brief 简短、lively 活泼、gentle 温柔；恢复默认填 null') }),
    risk: 'undoable',
    summarize(result) {
      const style = (result as PreferencesDto).style;
      return style ? `之后说话${STYLE_LABELS[style]}一些` : '说话方式恢复默认';
    },
    card(_db, result) {
      return { style: (result as PreferencesDto).style };
    },
  },
  execute({ db, now, meta }, input): PreferencesDto {
    if (input.style === null) db.run('DELETE FROM preferences WHERE key = ?', STYLE_KEY);
    else writeValue(db, STYLE_KEY, input.style, sourceMessageId(db, meta), now);
    return readPreferences(db);
  },
});

/** 表达方式在系统提示里的说明 */
export function styleInstruction(style: Style | null): string | null {
  switch (style) {
    case 'brief':
      return '用户希望你说话简短：每次回复一两句话，不要寒暄。';
    case 'lively':
      return '用户希望你说话活泼一些：语气轻快，可以偶尔用语气词。';
    case 'gentle':
      return '用户希望你说话温柔一些：语气柔和、耐心，多一点体贴。';
    default:
      return null;
  }
}

export const preferenceCommands = [setNickname, setStyle];

export const preferenceQueries = [
  defineQuery({ name: 'preferences.get', input: z.object({}).strict(), run: ({ db }) => readPreferences(db) }),
];
