import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

import type { IpcInvokeResult, PingResponse } from '@vtot/shared';
import { PingResponseSchema } from '@vtot/shared';

/**
 * Electron Main 进程入口。
 *
 * 用途：
 * - 创建窗口并加载 Renderer（Next.js）。
 * - 注册 IPC handler（Renderer 通过 preload -> ipcRenderer.invoke 调用）。
 *
 * 注意：
 * - Main 进程是“权威状态”的所在地（任务调度、DB 等后续都放这里）。
 * - 这里先实现最小可运行骨架：一个窗口 + 一个 ping IPC。
 */

/**
 * 记录主窗口引用，避免被 GC。
 */
let mainWindow: BrowserWindow | null = null;

/**
 * 创建主窗口并加载 Renderer。
 *
 * 说明：
 * - 开发阶段用 `VTOT_RENDERER_URL` 指向 Next dev server。
 * - 生产阶段后续会改成加载打包后的资源（本轮先不做）。
 */
const createMainWindow = async (): Promise<void> => {
  const rendererUrl = process.env.VTOT_RENDERER_URL ?? 'http://localhost:3000';

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: '#0b0f1a',
    webPreferences: {
      /**
       * preload：只暴露我们允许的最小 API 给 Renderer。
       */
      preload: path.join(__dirname, 'preload.js'),

      /**
       * 安全基线：保持 contextIsolation，避免直接暴露 Node 能力。
       */
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(rendererUrl);

  /**
   * 开发阶段默认打开 DevTools，便于联调。
   *
   * 说明：
   * - 后续可用环境变量控制是否打开。
   */
  mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

/**
 * 注册 IPC handlers。
 *
 * 说明：
 * - 这里使用 `ipcMain.handle` 对应 `ipcRenderer.invoke`。
 * - 返回值统一使用 IpcInvokeResult 结构，便于 Renderer 侧稳定处理。
 */
const registerIpcHandlers = (): void => {
  ipcMain.handle(
    'vtot.ping',
    async (): Promise<IpcInvokeResult<PingResponse>> => {
      const data: PingResponse = {
        message: `pong from main @ ${new Date().toISOString()}`,
      };

      /**
       * 这里用 zod 做一次运行时校验，示范 shared schema 的使用方式。
       *
       * 目的：
       * - 后续 job 系列 IPC 会更复杂，用 schema 校验可以减少线上脏数据。
       */
      const parsed = PingResponseSchema.parse(data);

      return { ok: true, data: parsed };
    }
  );
};

/**
 * 应用 ready 后启动。
 */
app.whenReady().then(async () => {
  registerIpcHandlers();
  await createMainWindow();

  /**
   * macOS：点击 Dock 图标时若无窗口，则重新创建。
   */
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

/**
 * Windows/Linux：所有窗口关闭后退出。
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
