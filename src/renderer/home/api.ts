// 小窝访问主进程的唯一途径：命名命令 + 只读查询 + 失效通知（TD §4.2、§6）。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandErrorCode, CommandResult, DataTopic } from '../../shared/contracts/command';
import type { NestQueries, QueryName } from '../../shared/contracts/nest-ipc';

function newOperationId(): string {
  return `ui-${crypto.randomUUID()}`;
}

/**
 * 执行一次用户操作。operationId 在点击时生成；IPC 调用本身失败（回复丢失）时
 * 用同一个 ID 重试一次，主进程会返回已提交的原结果，不会重复创建（TD §6.3）。
 */
export async function runCommand<T>(name: string, input: unknown): Promise<CommandResult<T>> {
  const operationId = newOperationId();
  try {
    return await window.nest.command<T>(name, input, operationId);
  } catch {
    try {
      return await window.nest.command<T>(name, input, operationId);
    } catch {
      return { ok: false, operationId, errorCode: 'INTERNAL', detail: '与主进程通信失败' };
    }
  }
}

const ERROR_TEXT: Record<CommandErrorCode, string> = {
  INVALID_INPUT: '内容不符合要求',
  UNKNOWN_COMMAND: '不支持的操作',
  NOT_ALLOWED: '没有权限执行这个操作',
  NOT_FOUND: '找不到这条记录，可能已被删除',
  REVISION_CONFLICT: '内容已在别处修改，请查看最新内容后再试',
  IDEMPOTENCY_CONFLICT: '操作冲突，请重试',
  EXPIRED: '已超过可恢复的期限',
  INVALID_STATE: '当前状态下不能这样操作',
  PAST_TIME: '这个时间已经过去了，请选择以后的时间',
  INTERNAL: '保存失败，请稍后重试',
};

export function describeError(result: Extract<CommandResult, { ok: false }>): string {
  const base = ERROR_TEXT[result.errorCode] ?? '操作失败';
  return result.errorCode === 'INVALID_INPUT' && result.detail ? `${base}：${firstLine(result.detail)}` : base;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() && !line.startsWith('✖ Invalid'))?.replace(/^✖\s*/, '') ?? text;
}

/**
 * 查询并在相关数据变化时重新查询。先订阅再查询，查询期间收到变化再查一次（TD §4.2）。
 */
export function useQuery<K extends QueryName>(
  name: K,
  input: NestQueries[K]['input'],
  topics: readonly DataTopic[],
): { data: NestQueries[K]['output'] | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<NestQueries[K]['output']>();
  const [error, setError] = useState<string | null>(null);
  const inputKey = JSON.stringify(input);
  const latest = useRef(0);
  const topicKey = topics.join(',');

  const load = useCallback(() => {
    const ticket = ++latest.current;
    window.nest
      .query(name, JSON.parse(inputKey) as NestQueries[K]['input'])
      .then((result) => {
        if (ticket !== latest.current) return;
        setData(result);
        setError(null);
      })
      .catch(() => {
        if (ticket === latest.current) setError('读取失败');
      });
  }, [name, inputKey]);

  useEffect(() => {
    const watched = topicKey.split(',');
    const unsubscribe = window.nest.onChanged((changed) => {
      if (changed.some((topic) => watched.includes(topic))) load();
    });
    load();
    return unsubscribe;
  }, [load, topicKey]);

  return { data, error, reload: load };
}

export { formatTime, fromLocalInputValue, toLocalInputValue } from '../../shared/format-time';
