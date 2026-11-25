import { useCallback, useState } from 'react';
import type { CommandResult } from '../../shared/contracts/command';
import { UNDO_WINDOW_MS } from '../../shared/contracts/notebook';
import { describeError, runCommand } from './api';
import { useToast } from './toast';

/**
 * 执行命令；失败时提示真实原因。返回结果供调用方更新界面。
 * busy 期间按钮应禁用，避免用户在等待时触发第二次操作。
 */
export function useAction(): {
  busy: boolean;
  run: <T>(name: string, input: unknown) => Promise<CommandResult<T>>;
} {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T>(name: string, input: unknown): Promise<CommandResult<T>> => {
      setBusy(true);
      try {
        const result = await runCommand<T>(name, input);
        if (!result.ok) toast.error(describeError(result));
        return result;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

/** 删除后显示 10 秒“撤销”（R06.AC-2） */
export function useDeleteWithUndo(): (kind: 'notes' | 'tasks', id: string, label: string) => Promise<void> {
  const toast = useToast();
  const { run } = useAction();
  return useCallback(
    async (kind, id, label) => {
      const result = await run(`${kind}.delete`, { id });
      if (!result.ok) return;
      toast.show({
        message: `已删除“${label}”，可在回收站保留 7 天`,
        durationMs: UNDO_WINDOW_MS,
        action: { label: '撤销', run: () => void run(`${kind}.restore`, { id }) },
      });
    },
    [run, toast],
  );
}
