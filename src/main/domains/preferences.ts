// 显式偏好（R10）：M6 只有称呼。用户在小窝里直接设置，或在对话中明确说出（“叫我小林”）。
// 显式偏好是这些值的唯一来源；模型推测的内容不能写入这里（R10.AC-5）。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import { NICKNAME_MAX, type PreferencesDto } from '../../shared/contracts/preferences';
import { CommandError, defineCommand, sourceMessageId } from '../application/commands';
import { defineQuery } from '../application/queries';
import type { Database } from '../storage/database';

interface PreferenceRow {
  key: string;
  value_json: string;
  revision: number;
  updated_at: number;
}

const NICKNAME_KEY = 'nickname';

const Nickname = z
  .string()
  .trim()
  .min(1, '称呼不能为空')
  .max(NICKNAME_MAX, `称呼最多 ${NICKNAME_MAX} 个字`)
  .refine((v) => !/[\r\n]/.test(v), '称呼不能换行');

function readRow(db: Database, key: string): PreferenceRow | undefined {
  return db.get<PreferenceRow>('SELECT key, value_json, revision, updated_at FROM preferences WHERE key = ?', key);
}

export function readPreferences(db: Database): PreferencesDto {
  const row = readRow(db, NICKNAME_KEY);
  let nickname: string | null = null;
  if (row) {
    try {
      const parsed = Nickname.safeParse(JSON.parse(row.value_json));
      nickname = parsed.success ? parsed.data : null;
    } catch {
      nickname = null;
    }
  }
  return { nickname, revision: row?.revision ?? 0 };
}

export const setNickname = defineCommand({
  name: 'preferences.setNickname',
  input: z.object({
    /** null：清除称呼 */
    nickname: Nickname.nullable(),
    /** 小窝表单带上看到的版本，防止覆盖别处的修改；对话不带 */
    revision: z.number().int().min(0).optional(),
  }),
  invalidates: ['settings'],
  tool: {
    description:
      '设置用户希望被怎样称呼。只有用户明确要求时调用，例如“叫我小林”“以后别叫我小林了”（清除时 nickname 填 null）。不要根据聊天内容自己猜。',
    parameters: z.object({
      nickname: z.string().trim().min(1).max(NICKNAME_MAX).nullable().describe('用户要求的称呼，按原话填；清除称呼填 null'),
    }),
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
    if (input.nickname === null) {
      db.run('DELETE FROM preferences WHERE key = ?', NICKNAME_KEY);
      return { nickname: null, revision: 0 };
    }
    db.run(
      `INSERT INTO preferences (key, value_json, source_message_id, revision, updated_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, source_message_id = excluded.source_message_id,
         revision = preferences.revision + 1, updated_at = excluded.updated_at`,
      NICKNAME_KEY,
      JSON.stringify(input.nickname),
      sourceMessageId(db, meta),
      now,
    );
    return readPreferences(db);
  },
});

export const preferenceCommands = [setNickname];

export const preferenceQueries = [
  defineQuery({ name: 'preferences.get', input: z.object({}).strict(), run: ({ db }) => readPreferences(db) }),
];
