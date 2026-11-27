// 小本子的查询：笔记、待办、搜索、回收站。

import { z } from 'zod';
import type { RecycledItem, SearchHit } from '../../shared/contracts/notebook';
import { defineQuery } from '../application/queries';
import { listDeletedNotes, listNotes, searchNotes } from './notes';
import { listDeletedTasks, listTasks, searchTasks } from './tasks';
import { likeConditions, searchTerms } from './text-search';
import { searchTopics } from './topics';

const Empty = z.object({}).strict();

export const notebookQueries = [
  defineQuery({ name: 'notebook.notes', input: Empty, run: ({ db }) => listNotes(db) }),
  defineQuery({ name: 'notebook.tasks', input: Empty, run: ({ db }) => listTasks(db) }),
  defineQuery({
    name: 'notebook.search',
    input: z.object({ query: z.string().max(200) }),
    run: ({ db }, input): SearchHit[] => [
      ...(searchTerms(input.query).length
        ? searchTopics(db, likeConditions('search_text', searchTerms(input.query))).map((item) => ({ type: 'topic' as const, item }))
        : []),
      ...searchTasks(db, input.query).map((item) => ({ type: 'task' as const, item })),
      ...searchNotes(db, input.query).map((item) => ({ type: 'note' as const, item })),
    ],
  }),
  defineQuery({
    name: 'notebook.recycleBin',
    input: Empty,
    run: ({ db, now }): RecycledItem[] =>
      [
        ...listDeletedNotes(db, now).map((item) => ({ type: 'note' as const, item })),
        ...listDeletedTasks(db, now).map((item) => ({ type: 'task' as const, item })),
      ].sort((a, b) => (b.item.deletedAt ?? 0) - (a.item.deletedAt ?? 0)),
  }),
];
