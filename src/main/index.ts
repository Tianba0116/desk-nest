import { join } from 'node:path';
import { app, dialog, net, Notification, powerMonitor, safeStorage, type Tray } from 'electron';
import { formatTime } from '../shared/format-time';
import type { BubbleItem } from '../shared/contracts/reminders';
import { AppPrefs } from './application/app-prefs';
import { createAppCore, openDatabase, type AppCore } from './application/core';
import { ReminderPresenter, type PopupGate } from './application/presenter';
import { Scheduler } from './application/scheduler';
import { interruptUnfinishedTurns } from './conversation/conversation-store';
import { ModelSettings, ModelSettingsError } from './conversation/model-settings';
import { testConnection } from './conversation/test-connection';
import { BubbleHost } from './desktop/bubble-window';
import { ChatHost } from './desktop/chat-window';
import { CompanionHost } from './desktop/companion-window';
import { createDesktopContext } from './desktop/context/registry';
import { FullscreenGuard } from './desktop/fullscreen-guard';
import { PetHost } from './desktop/pet-host';
import { petContextMenu } from './desktop/pet-menu';
import { AppPetSettings, PetSettingsFile, PetSettingsService } from './desktop/pet-settings';
import { PlacementStore, SettingsPlacementStore } from './desktop/placement-store';
import { createStartupSetting } from './desktop/startup';
import { createPetTray } from './desktop/tray';
import { countUpcoming, reminderJob } from './domains/reminders';
import { importLegacyJson } from './storage/app-settings';

const APP_USER_MODEL_ID = 'dev.desktoppet.app';
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// 开发和自动化验证用：指定独立的数据目录，不影响日常使用的数据。必须在单实例锁之前设置
const userDataOverride = process.env['PET_USER_DATA_DIR'];
if (userDataOverride) app.setPath('userData', userDataOverride);

// 单实例：再次启动时唤出已有实例（R01.AC-1）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let core: AppCore | null = null;
  let host: PetHost | null = null;
  let companion: CompanionHost | null = null;
  let bubble: BubbleHost | null = null;
  let chat: ChatHost | null = null;
  let guard: FullscreenGuard | null = null;
  let scheduler: Scheduler | null = null;
  let maintenanceTimer: NodeJS.Timeout | null = null;
  // 保持引用，避免托盘图标被回收
  let tray: Tray | null = null;

  app.setAppUserModelId(APP_USER_MODEL_ID);

  app.on('second-instance', () => host?.summon());

  // 常驻托盘：窗口隐藏或关闭都不退出，只有托盘“退出”才结束进程（R01.AC-3）
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    scheduler?.stop();
    guard?.stop();
    host?.dispose();
    companion?.dispose();
    bubble?.dispose();
    chat?.dispose();
  });

  app.on('will-quit', () => {
    tray?.destroy();
    tray = null;
    core?.close();
    core = null;
  });

  void app.whenReady().then(() => {
    const userData = app.getPath('userData');

    // 启动顺序（TD §13.1）：数据库与迁移 → 窗口/托盘 → 扫描到期事项 → 恢复展示
    let appCore: AppCore;
    try {
      appCore = createAppCore(openDatabase(userData));
    } catch (error) {
      // 迁移失败时保留旧数据，不删库重建（R19.AC-5）；完整的恢复界面在 M8
      console.error('[startup] database failed:', error);
      dialog.showErrorBox(
        '无法打开数据',
        `数据库打开或升级失败，原有数据没有被修改。\n数据位置：${userData}\n\n${String(error)}`,
      );
      app.exit(1);
      return;
    }
    core = appCore;
    // 上次运行中未完成的对话轮次标为中断，不自动重发（TD §7.4）
    interruptUnfinishedTurns(appCore.db, appCore.clock.now());
    appCore.maintain();
    maintenanceTimer = setInterval(() => appCore.maintain(), MAINTENANCE_INTERVAL_MS);

    importLegacyJson(appCore.settings, SettingsPlacementStore.key, join(userData, 'pet-placement.json'), (path) =>
      new PlacementStore(path).load(),
    );
    importLegacyJson(appCore.settings, AppPetSettings.key, join(userData, 'pet-settings.json'), (path) =>
      new PetSettingsFile(path).load(),
    );

    const settings = new PetSettingsService(new AppPetSettings(appCore.settings));
    const prefs = new AppPrefs(appCore.settings);
    const startup = createStartupSetting();
    const models = new ModelSettings(appCore.settings, {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (data) => safeStorage.decryptString(data),
    });

    // ---------- 宠物 ----------
    const petHost = new PetHost(new SettingsPlacementStore(appCore.settings), settings);
    host = petHost;
    petHost.start();

    // ---------- 小窝 ----------
    const companionHost = new CompanionHost(
      appCore.commands,
      appCore.queries,
      (request) => {
        if (request.action === 'setOpenAtLogin') startup.set(request.value);
        if (request.action === 'dismissStartupPrompt') prefs.update({ startupPromptDismissed: true });
        return {
          supported: startup.supported,
          openAtLogin: startup.openAtLogin(),
          promptDismissed: prefs.value.startupPromptDismissed,
        };
      },
      async (request) => {
        try {
          if (request.action === 'save') return { ok: true, settings: models.save(request.input) };
          if (request.action === 'test') {
            const adapter = models.createForTest(request.input, (url, init) => net.fetch(url, init));
            return { ok: true, settings: models.get(), test: await testConnection(adapter) };
          }
          return { ok: true, settings: models.get() };
        } catch (error) {
          if (error instanceof ModelSettingsError) return { ok: false, error: error.message, settings: models.get() };
          console.error('[model-settings] failed:', error instanceof Error ? error.name : 'unknown');
          return { ok: false, error: '保存失败', settings: models.get() };
        }
      },
    );
    companion = companionHost;
    companionHost.start();
    const openNest = (view?: 'inbox' | 'reminders' | 'settings'): void => companionHost.open(view);

    // ---------- 对话 ----------
    const chatHost = new ChatHost(appCore.db, appCore.clock, appCore.commands, models, {
      anchor: () => petHost.bounds(),
      openSettings: () => openNest('settings'),
    });
    chat = chatHost;
    chatHost.start();
    const openChat = (): void => chatHost.open();
    petHost.onTouched(() => chatHost.toggle());
    petHost.setContextMenu(() => petContextMenu(petHost, settings, prefs, { openNest, openChat }));

    // ---------- 外部全屏 ----------
    const fullscreenGuard = new FullscreenGuard(
      createDesktopContext(),
      petHost,
      () => !settings.value.keepVisibleInFullscreen,
    );
    guard = fullscreenGuard;
    fullscreenGuard.start();
    settings.onChange((next, previous) => {
      if (next.keepVisibleInFullscreen !== previous.keepVisibleInFullscreen) fullscreenGuard.check();
    });

    // ---------- 提醒：调度 → 信箱 → 气泡 ----------
    let locked = false;
    const gate: PopupGate = {
      check() {
        if (prefs.value.quietMode) return { open: false, reason: 'QUIET_MODE' };
        if (locked) return { open: false, reason: 'LOCKED' };
        if (!petHost.visible) return { open: false, reason: fullscreenGuard.state === true ? 'FULLSCREEN' : 'PET_HIDDEN' };
        return { open: true };
      },
    };
    let presenter: ReminderPresenter | null = null;
    const bubbleHost = new BubbleHost(appCore.commands, {
      anchor: () => petHost.bounds(),
      onShown: (ids) => presenter?.acknowledge(ids),
      openInbox: () => openNest('inbox'),
    });
    bubble = bubbleHost;
    bubbleHost.start();
    presenter = new ReminderPresenter({
      db: appCore.db,
      clock: appCore.clock,
      gate,
      bubble: bubbleHost,
      notifyWhenClosed: () => prefs.value.notifyWhenQuiet,
      systemNotify: showSystemNotification(openNest),
      onUnreadChanged: (count) => petHost.setUnread(count),
    });
    const reminderPresenter = presenter;

    const reminderScheduler = new Scheduler(appCore.db, appCore.clock, () => {
      companionHost.broadcast(['inbox', 'reminders']);
      reminderPresenter.check();
    });
    scheduler = reminderScheduler;
    reminderScheduler.register(reminderJob(() => crypto.randomUUID()));

    appCore.commands.onCommitted((topics) => {
      if (topics.includes('reminders')) reminderScheduler.tick();
      if (topics.includes('inbox') || topics.includes('reminders')) reminderPresenter.onInboxChanged();
    });
    petHost.onMoved(() => bubbleHost.reposition());
    petHost.onVisibilityChange(() => {
      if (!petHost.visible) bubbleHost.hide();
    });

    // 睡眠恢复、解锁后主动扫描（TD §8.3）
    powerMonitor.on('lock-screen', () => {
      locked = true;
    });
    powerMonitor.on('unlock-screen', () => {
      locked = false;
      reminderScheduler.tick();
    });
    powerMonitor.on('resume', () => reminderScheduler.tick());

    reminderScheduler.start();
    reminderPresenter.check();

    // ---------- 托盘 ----------
    tray = createPetTray({
      host: petHost,
      settings,
      prefs,
      startup,
      actions: { openNest, openChat },
      quit: () => confirmQuit(appCore),
    });

    // 开发和自动化验证用：启动后直接打开小窝
    if (process.env['PET_OPEN_NEST'] === '1') openNest();
  });

  /** 有未来的提醒时，退出前确认：退出后不会实时提醒（R01.AC-4） */
  function confirmQuit(appCore: AppCore): void {
    const upcoming = countUpcoming(appCore.db, appCore.clock.now());
    if (upcoming === 0) {
      app.quit();
      return;
    }
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      title: '退出桌面宠物',
      message: `还有 ${upcoming} 个提醒没有到期`,
      detail: '退出后这些提醒不会实时弹出。下次启动时可以在信箱里查看错过的提醒。',
      buttons: ['仍然退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) app.quit();
  }
}

/** 安静、隐藏或全屏时的系统通知（R08.AC-8）；只记录“已请求发送”，不当作用户已看见 */
function showSystemNotification(openNest: (view: 'inbox') => void): (items: BubbleItem[]) => void {
  return (items) => {
    if (!Notification.isSupported() || items.length === 0) return;
    const first = items[0];
    const notification = new Notification({
      title: items.length === 1 ? '提醒' : `${items.length} 个提醒到期`,
      body: items.length === 1 && first ? `${first.content}（${formatTime(first.dueAt)}）` : items.map((i) => i.content).join('、'),
      silent: false,
    });
    notification.on('click', () => openNest('inbox'));
    notification.show();
  };
}
