// 设置页“数据”的系统操作（R19.AC-3、AC-8）：导出、从导出文件恢复、清除所有数据、打开数据文件夹。
// 恢复和清除都在重启后、打开数据库之前执行（storage/data-management.ts）。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import type { DataRequest, DataResponse } from '../../shared/contracts/nest-ipc';
import type { AppCore } from '../application/core';
import { DataError, EXPORT_MAX_BYTES, exportSnapshot, stageClear, stageRestore } from '../storage/data-management';

function stampDate(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * 仅用于自动化验证（与 PET_OPEN_NEST 相同）：设置 PET_AUTOMATION_FILE 后，导出和恢复直接使用这个文件、
 * 确认框自动选“继续”，不弹出系统对话框。日常使用不会设置这个变量。
 */
const AUTOMATION_FILE = process.env['PET_AUTOMATION_FILE'] ?? null;

async function confirmBox(options: Electron.MessageBoxOptions): Promise<number> {
  if (AUTOMATION_FILE) return 0;
  return (await dialog.showMessageBox(options)).response;
}

function relaunch(): void {
  app.relaunch();
  app.exit(0);
}

export function createDataActions(core: () => AppCore, userData: string): (request: DataRequest) => Promise<DataResponse> {
  return async (request) => {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined;
    const now = core().clock.now();
    try {
      if (request.action === 'openFolder') {
        await shell.openPath(userData);
        return { ok: true, message: userData };
      }

      if (request.action === 'export') {
        const options = {
          title: '导出全部数据',
          defaultPath: join(app.getPath('documents'), `DeskNest-数据-${stampDate(now)}.json`),
          filters: [{ name: 'DeskNest 导出文件', extensions: ['json'] }],
        };
        const result = AUTOMATION_FILE
          ? { canceled: false, filePath: AUTOMATION_FILE }
          : parent
            ? await dialog.showSaveDialog(parent, options)
            : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { ok: false, message: '已取消' };
        const snapshot = exportSnapshot(core().db, app.getVersion(), now);
        writeFileSync(result.filePath, JSON.stringify(snapshot, null, 1), 'utf8');
        return { ok: true, message: `已导出到 ${result.filePath}（不包含密钥）` };
      }

      if (request.action === 'restore') {
        const options = {
          title: '从导出文件恢复',
          properties: ['openFile' as const],
          filters: [{ name: 'DeskNest 导出文件', extensions: ['json'] }],
        };
        const result = AUTOMATION_FILE
          ? { canceled: false, filePaths: [AUTOMATION_FILE] }
          : parent
            ? await dialog.showOpenDialog(parent, options)
            : await dialog.showOpenDialog(options);
        const file = result.filePaths[0];
        if (result.canceled || !file) return { ok: false, message: '已取消' };
        const text = readFileSync(file, 'utf8');
        if (Buffer.byteLength(text) > EXPORT_MAX_BYTES) return { ok: false, message: '导出文件太大' };
        const summary = stageRestore(userData, text, now);
        const counts = Object.entries(summary.counts)
          .map(([label, n]) => `${label} ${n}`)
          .join('、');
        const confirm = await confirmBox({
          type: 'warning',
          title: '从导出文件恢复',
          message: '用导出文件里的数据替换现在的全部数据？',
          detail: `导出时间：${summary.exportedAt}\n内容：${counts}\n\n现在的数据会先备份到数据文件夹的 backups 里。应用会重启；密钥不在导出文件中，需要重新填写。`,
          buttons: ['恢复并重启', '取消'],
          defaultId: 1,
          cancelId: 1,
        });
        if (confirm !== 0) {
          (await import('../storage/data-management')).cancelStaged(userData);
          return { ok: false, message: '已取消，现有数据没有变化' };
        }
        setTimeout(relaunch, 100);
        return { ok: true, message: '正在重启以完成恢复…' };
      }

      // 清除所有数据（R19.AC-8）：二次确认
      const first = await confirmBox({
        type: 'warning',
        title: '清除所有数据',
        message: '删除本机的全部数据？',
        detail: `笔记、待办、事项、记忆、提醒、聊天记录、设置、密钥和备份都会被删除，不能恢复。\n数据位置：${userData}\n\n建议先“导出全部数据”。`,
        buttons: ['继续', '取消'],
        defaultId: 1,
        cancelId: 1,
      });
      if (first !== 0) return { ok: false, message: '已取消' };
      const second = await confirmBox({
        type: 'warning',
        title: '再确认一次',
        message: '真的要清除所有数据吗？',
        buttons: ['清除并重启', '取消'],
        defaultId: 1,
        cancelId: 1,
      });
      if (second !== 0) return { ok: false, message: '已取消' };
      stageClear(userData, now);
      setTimeout(relaunch, 100);
      return { ok: true, message: '正在重启…' };
    } catch (error) {
      if (error instanceof DataError) return { ok: false, message: error.message };
      console.error('[data] failed:', error instanceof Error ? error.name : 'unknown');
      return { ok: false, message: '操作没有成功，现有数据没有变化' };
    }
  };
}
