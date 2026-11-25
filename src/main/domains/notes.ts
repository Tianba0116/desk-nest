// 随手记（R06）。删除为软删除，回收站保留 7 天；恢复和彻底删除都是明确的用户命令。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import {
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  RECYCLE_RETENTION_MS,
  type NoteDto,
} from '../../shared/contracts/notebook';
import { CommandError, defineCommand, requireRevision } from '../application/commands';
import type { Database } from '../storage/database';
import { likeConditions, normalizeForSearch, searchTerms } from './text-search';

interface NoteRow {
  id: string;
  title: string;
  body: string;
  revision: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, title, body, revision, deleted_at, created_at, updated_at';

export function toNoteDto(row: NoteRow): NoteDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function findNote(db: Database, id: string): NoteRow | undefined {
  return db.get<NoteRow>(`SELECT ${COLUMNS} FROM notes WHERE id = ?`, id);
}

function mustLoad(db: Database, id: string): NoteDto {
  const row = findNote(db, id);
  if (!row) throw new CommandError(CommandErrorCodes.notFound);
  return toNoteDto(row);
}

const Title = z.string().trim().max(NOTE_TITLE_MAX);
const Body = z.string().max(NOTE_BODY_MAX);
const Id = z.string().min(1).max(100);

const NoteContent = z
  .object({ title: Title.default(''), body: Body })
  .refine((v) => v.title.length > 0 || v.body.trim().length > 0, { message: '标题和内容不能都为空' });

export const createNote = defineCommand({
  name: 'notes.create',
  input: NoteContent,
  invalidates: ['notes'],
  execute({ db, now, newId }, input): NoteDto {
    const id = newId();
    db.run(
      `INSERT INTO notes (id, title, body, search_text, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      id,
      input.title,
      input.body,
      normalizeForSearch(`${input.title}\n${input.body}`),
      now,
      now,
    );
    return mustLoad(db, id);
  },
});

export const updateNote = defineCommand({
  name: 'notes.update',
  input: z
    .object({ id: Id, revision: z.number().int().positive(), title: Title, body: Body })
    .refine((v) => v.title.length > 0 || v.body.trim().length > 0, { message: '标题和内容不能都为空' }),
  invalidates: ['notes'],
  execute({ db, now }, input): NoteDto {
    requireRevision(findNote(db, input.id), input.revision);
    db.run(
      `UPDATE notes SET title = ?, body = ?, search_text = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      input.title,
      input.body,
      normalizeForSearch(`${input.title}\n${input.body}`),
      now,
      input.id,
    );
    return mustLoad(db, input.id);
  },
});

export const deleteNote = defineCommand({
  name: 'notes.delete',
  input: z.object({ id: Id, revision: z.number().int().positive().optional() }),
  invalidates: ['notes'],
  execute({ db, now }, input): NoteDto {
    requireRevision(findNote(db, input.id), input.revision);
    db.run('UPDATE notes SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?', now, now, input.id);
    return mustLoad(db, input.id);
  },
});

export const restoreNote = defineCommand({
  name: 'notes.restore',
  input: z.object({ id: Id }),
  invalidates: ['notes'],
  execute({ db, now }, input): NoteDto {
    const row = findNote(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    if (row.deleted_at === null) return toNoteDto(row);
    if (now - row.deleted_at > RECYCLE_RETENTION_MS) throw new CommandError(CommandErrorCodes.expired);
    db.run('UPDATE notes SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?', now, input.id);
    return mustLoad(db, input.id);
  },
});

/** 从回收站彻底删除；只能删除已在回收站中的笔记 */
export const purgeNote = defineCommand({
  name: 'notes.purge',
  input: z.object({ id: Id }),
  invalidates: ['notes'],
  execute({ db }, input): { id: string } {
    const row = findNote(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    if (row.deleted_at === null) throw new CommandError(CommandErrorCodes.invalidState, '只能彻底删除回收站中的笔记');
    db.run('DELETE FROM notes WHERE id = ?', input.id);
    return { id: input.id };
  },
});

export const noteCommands = [createNote, updateNote, deleteNote, restoreNote, purgeNote];

// ---------- 查询 ----------

export function listNotes(db: Database, limit = 500): NoteDto[] {
  return db
    .all<NoteRow>(`SELECT ${COLUMNS} FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`, limit)
    .map(toNoteDto);
}

export function searchNotes(db: Database, query: string, limit = 100): NoteDto[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const where = likeConditions('search_text', terms);
  return db
    .all<NoteRow>(
      `SELECT ${COLUMNS} FROM notes WHERE deleted_at IS NULL AND ${where.sql} ORDER BY updated_at DESC LIMIT ?`,
      ...where.params,
      limit,
    )
    .map(toNoteDto);
}

export function listDeletedNotes(db: Database, now: number): NoteDto[] {
  return db
    .all<NoteRow>(
      `SELECT ${COLUMNS} FROM notes WHERE deleted_at IS NOT NULL AND deleted_at >= ? ORDER BY deleted_at DESC`,
      now - RECYCLE_RETENTION_MS,
    )
    .map(toNoteDto);
}

/** 清理超过保留期的回收站内容；返回删除条数 */
export function purgeExpiredNotes(db: Database, now: number): number {
  return db.run('DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?', now - RECYCLE_RETENTION_MS)
    .changes;
}
