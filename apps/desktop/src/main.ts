import 'dotenv/config';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OpenDialogOptions } from 'electron';

import type {
  AppError,
  IpcInvokeResult,
  JobCancelRequest,
  JobCancelResponse,
  JobCreateRequest,
  JobCreateResponse,
  JobEvent,
  PingResponse,
  WorkerControl,
} from '@vtot/shared';
import {
  JobCancelRequestSchema,
  JobCancelResponseSchema,
  JobCreateRequestSchema,
  JobCreateResponseSchema,
  JobEventSchema,
  PingResponseSchema,
  WorkerControlSchema,
  WorkerEventSchema,
} from '@vtot/shared';

import * as db from './db';
import type { PersistedJob, AppSettings, EnvCheckResult } from '@vtot/shared';
import { JobScheduler } from './scheduler';
import { SettingsManager } from './settings';
import { checkEnvironment } from './env';

/**
 * Electron Main 进程入口。
 */

let mainWindow: BrowserWindow | null = null;
let scheduler: JobScheduler | null = null;
let settingsManager: SettingsManager | null = null;

/**
 * JobRoot 根目录：`${appData}/jobs`
 */
const getJobsRoot = (): string => {
  return path.join(app.getPath('userData'), 'jobs');
};

/**
 * 创建目录（若不存在则递归创建）。
 */
const ensureDir = async (targetDir: string): Promise<void> => {
  await fs.mkdir(targetDir, { recursive: true });
};

/**
 * 原子写入 JSON：先写临时文件，再 rename。
 */
const writeJsonAtomic = async (
  targetPath: string,
  payload: unknown
): Promise<void> => {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(payload, null, 2)}\n`;

  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, targetPath);
};

/**
 * 组装 PersistedJob 内容。
 */
const buildPersistedJob = (
  jobId: string,
  request: JobCreateRequest
): PersistedJob => {
  const now = Date.now();
  return {
    schemaVersion: '1.0',
    jobId,
    status: 'queued',
    source: {
      originalPath: request.sourceFilePath,
      importStrategy: request.importStrategy ?? 'reference',
    },
    options: request.options,
    meta: {
      createdAt: now,
      updatedAt: now,
      createdByAppVersion: app.getVersion(),
    },
  };
};

/**
 * 创建 JobRoot 目录结构并同步写入到 SQLite 与 job.json。
 */
const prepareJobRoot = async (
  jobId: string,
  request: JobCreateRequest
): Promise<string> => {
  const jobsRoot = getJobsRoot();
  await ensureDir(jobsRoot);

  const jobRoot = path.join(jobsRoot, jobId);
  await ensureDir(jobRoot);

  const subDirs = ['artifacts', 'cache', 'engine', 'exports', 'logs'];
  await Promise.all(subDirs.map((dir) => ensureDir(path.join(jobRoot, dir))));

  const persistedJob = buildPersistedJob(jobId, request);

  // 1. 写入 job.json (用于任务自包含/便携)
  const jobJsonPath = path.join(jobRoot, 'job.json');
  await writeJsonAtomic(jobJsonPath, persistedJob);

  // 2. 写入 SQLite (权威状态存储)
  db.upsertJob(persistedJob);

  return jobRoot;
};

// 移除被 JobScheduler 替代的 legacy 函数

/**
 * 向 Renderer 广播 Job 事件。
 */
const sendJobEventToRenderer = (event: JobEvent): void => {
  if (!mainWindow) {
    return;
  }
  const parsed = JobEventSchema.parse(event);
  mainWindow.webContents.send('vtot.job.event', parsed);
};

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

  ipcMain.handle(
    'vtot.job.create',
    async (
      _event: unknown,
      rawRequest: unknown
    ): Promise<IpcInvokeResult<JobCreateResponse>> => {
      const parsedRequest = JobCreateRequestSchema.safeParse(rawRequest);

      if (!parsedRequest.success) {
        return {
          ok: false,
          error: {
            code: 'E_INVALID_INPUT',
            message: 'job.create 入参不合法。',
            retryable: false,
            step: 'job.create',
            detail: {
              issues: parsedRequest.error.issues,
            },
          },
        };
      }

      const request: JobCreateRequest = parsedRequest.data;

      if (!scheduler) {
        return {
          ok: false,
          error: {
            code: 'E_ENVIRONMENT_ERROR',
            message: '调度器未就绪。',
            retryable: true,
            step: 'job.create',
          },
        };
      }

      const jobId = randomUUID();
      try {
        const jobRootPath = await prepareJobRoot(jobId, request);
        
        // 加入调度队列
        scheduler.enqueue({
          jobId,
          jobRootPath,
          request
        });

        // 立即向 UI 发送一个 queued 事件
        sendJobEventToRenderer({
          type: 'job.status',
          data: {
            jobId,
            status: 'queued',
            step: 'queue',
            ts: Date.now(),
          },
        });

        return { ok: true, data: { jobId } };
      } catch (err) {
        console.error('[main] failed to create job', err);
        return {
          ok: false,
          error: {
            code: 'E_ENVIRONMENT_ERROR',
            message: '创建任务失败。',
            retryable: true,
            step: 'job.create',
            detail: { reason: String(err) },
          },
        };
      }
    }
  );

  ipcMain.handle(
    'vtot.job.cancel',
    async (
      _event: unknown,
      rawRequest: unknown
    ): Promise<IpcInvokeResult<JobCancelResponse>> => {
      const parsedRequest = JobCancelRequestSchema.safeParse(rawRequest);

      if (!parsedRequest.success) {
        return {
          ok: false,
          error: {
            code: 'E_INVALID_INPUT',
            message: 'job.cancel 入参不合法。',
            retryable: false,
            step: 'job.cancel',
            detail: {
              issues: parsedRequest.error.issues,
            },
          },
        };
      }

      const { jobId } = parsedRequest.data;
      if (scheduler) {
        await scheduler.cancelJob(jobId);
      }

      return { ok: true, data: { jobId } };
    }
  );

  ipcMain.handle(
    'vtot.job.list',
    async (): Promise<IpcInvokeResult<PersistedJob[]>> => {
      try {
        const jobs = db.listJobs();
        return { ok: true, data: jobs };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'E_ENGINE_RUNTIME_ERROR',
            message: '列出任务失败。',
            retryable: true,
            step: 'job.list',
            detail: { error: String(err) },
          },
        };
      }
    }
  );

  ipcMain.handle(
    'vtot.job.get',
    async (
      _event: unknown,
      jobId: string
    ): Promise<IpcInvokeResult<PersistedJob | null>> => {
      try {
        const job = db.getJob(jobId);
        return { ok: true, data: job };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'E_ENGINE_RUNTIME_ERROR',
            message: '查询任务失败。',
            retryable: true,
            step: 'job.get',
            detail: { error: String(err) },
          },
        };
      }
    }
  );

  ipcMain.handle(
    'vtot.dialog.selectSourceFile',
    async (): Promise<IpcInvokeResult<{ filePath: string | null }>> => {
      const options: OpenDialogOptions = {
        title: '选择媒体文件',
        buttonLabel: '选择',
        properties: ['openFile'],
        filters: [
          {
            name: '媒体文件',
            extensions: [
              'mp3',
              'wav',
              'm4a',
              'flac',
              'aac',
              'mp4',
              'mkv',
              'mov',
              'avi',
            ],
          },
          { name: '所有文件', extensions: ['*'] },
        ],
      };

      try {
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options);

        if (result.canceled || result.filePaths.length === 0) {
          return { ok: true, data: { filePath: null } };
        }

        return { ok: true, data: { filePath: result.filePaths[0] ?? null } };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'E_ENVIRONMENT_ERROR',
            message: '打开文件对话框失败，请重试。',
            retryable: true,
            step: 'dialog.selectSourceFile',
            detail: {
              reason: err instanceof Error ? err.message : String(err),
            },
          },
        };
      }
    }
  );

  ipcMain.handle(
    'vtot.settings.get',
    async (): Promise<IpcInvokeResult<AppSettings>> => {
      if (!settingsManager) return { ok: false, error: { code: 'E_ENVIRONMENT_ERROR', message: '设置管理未就绪', retryable: true } };
      return { ok: true, data: settingsManager.get() };
    }
  );

  ipcMain.handle(
    'vtot.settings.set',
    async (_event, settings: Partial<AppSettings>): Promise<IpcInvokeResult<AppSettings>> => {
      if (!settingsManager) return { ok: false, error: { code: 'E_ENVIRONMENT_ERROR', message: '设置管理未就绪', retryable: true } };
      const updated = await settingsManager.save(settings);
      
      // 同步更新调度器并发数
      if (scheduler && settings.maxConcurrentJobs) {
        scheduler.updateMaxConcurrent(settings.maxConcurrentJobs);
      }

      return { ok: true, data: updated };
    }
  );

  ipcMain.handle(
    'vtot.env.check',
    async (): Promise<IpcInvokeResult<EnvCheckResult>> => {
      const report = await checkEnvironment();
      return { ok: true, data: report };
    }
  );
};

/**
 * 应用 ready 后启动。
 */
app.whenReady().then(async () => {
  // 1. 初始化设置
  settingsManager = new SettingsManager();
  const settings = await settingsManager.load();

  // 2. 注册 IPC
  registerIpcHandlers();

  // 3. 初始化调度器
  const workerEntry = path.join(__dirname, '../../worker/dist/main.js');
  scheduler = new JobScheduler(workerEntry, (event) => {
    sendJobEventToRenderer(event);
  });
  scheduler.updateMaxConcurrent(settings.maxConcurrentJobs);

  // 4. 环境自检 (异步执行，不阻塞启动)
  void checkEnvironment().then((report) => {
    console.log('[main] environment report:', report);
    if (!report.ok) {
      // 后续可以在 UI 上弹窗提示
    }
  });

  await createMainWindow();

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

/**
 * 应用退出前尝试优雅关闭 Worker。
 */
app.on('before-quit', () => {
  // 可以在这里显式关闭所有活跃 Worker，或者依靠进程退出被动关闭
});
