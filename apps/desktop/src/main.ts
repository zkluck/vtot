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
  JobOptions,
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
 * Worker 子进程引用（骨架阶段：只启动 1 个 Worker）。
 *
 * 说明：
 * - 后续演进目标：每个 job 一个 Worker，按调度策略启动/退出。
 * - 当前仅用于验证：Main 能拉起 Worker，并能完成 ready/ping/shutdown 的最小协议闭环。
 */
let workerProcess: ChildProcess | null = null;

/**
 * Worker 对应的 jobId（骨架阶段使用固定值）。
 */
let workerJobId: string | null = null;

/**
 * Worker ready 握手超时定时器。
 */
let workerReadyTimer: NodeJS.Timeout | null = null;

/**
 * Worker shutdown 强杀兜底定时器。
 */
let workerShutdownTimer: NodeJS.Timeout | null = null;

/**
 * Worker 是否正在退出。
 */
let workerIsStopping = false;

/**
 * Worker 是否已经完成 ready 握手。
 *
 * 用途：
 * - 避免在握手完成前就下发 `job.start` 之类的控制消息。
 */
let workerIsReady = false;

/**
 * 记录 jobId -> JobRoot 的映射，便于写入 cancel.flag 等。
 */
const jobRootMap = new Map<string, string>();

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

type PersistedJob = {
  schemaVersion: '1.0';
  jobId: string;
  source: {
    originalPath: string;
    importStrategy: string;
    fingerprint?: {
      sizeBytes?: number | null;
      mtimeMs?: number | null;
    };
  };
  options: JobOptions;
  meta: {
    createdAt: number;
    createdByAppVersion: string;
  };
};

/**
 * 组装 job.json 内容（目前只包含 MVP 必需字段）。
 */
const buildJobJson = (
  jobId: string,
  request: JobCreateRequest
): PersistedJob => {
  return {
    schemaVersion: '1.0',
    jobId,
    source: {
      originalPath: request.sourceFilePath,
      importStrategy: request.importStrategy ?? 'reference',
    },
    options: request.options,
    meta: {
      createdAt: Date.now(),
      createdByAppVersion: app.getVersion(),
    },
  };
};

/**
 * 创建 JobRoot 目录结构并写入 job.json。
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

  const jobJsonPath = path.join(jobRoot, 'job.json');
  await writeJsonAtomic(jobJsonPath, buildJobJson(jobId, request));

  jobRootMap.set(jobId, jobRoot);
  return jobRoot;
};

/**
 * 在 JobRoot 写入 cancel.flag（幂等）。
 */
const writeCancelFlag = async (jobId: string): Promise<void> => {
  const jobRoot = jobRootMap.get(jobId);

  if (!jobRoot) {
    return;
  }

  const cancelFlagPath = path.join(jobRoot, 'cancel.flag');
  await fs.writeFile(cancelFlagPath, `${Date.now()}\n`, 'utf-8');
};

/**
 * 发送 WorkerControl 到 Worker。
 *
 * 说明：
 * - 这里统一对 control 做 zod 校验，避免主进程发送错误 payload。
 * - ChildProcess#send 的类型定义存在 `any`，这里保持我们自己的边界为类型安全。
 */
const sendWorkerControl = (control: WorkerControl): void => {
  if (!workerProcess || !workerJobId) {
    return;
  }

  if (!workerProcess.connected) {
    return;
  }

  const parsed = WorkerControlSchema.parse(control);

  try {
    workerProcess.send(parsed);
  } catch (err) {
    console.error('[main] failed to send worker control', err);
  }
};

/**
 * 判断 Worker 是否可用（可以接收 job 控制消息）。
 */
const isWorkerAvailable = (): boolean => {
  return Boolean(
    workerProcess &&
      workerProcess.connected &&
      workerJobId &&
      workerIsReady &&
      !workerIsStopping &&
      !workerProcess.killed
  );
};

type SelectSourceFileResponse = { filePath: string | null };

/**
 * 构造一个“Worker 未就绪”的标准错误对象。
 *
 * 用途：
 * - 供 `ipcMain.handle` 返回 IpcInvokeResult 的失败分支。
 */
const createWorkerNotReadyError = (): AppError => {
  return {
    code: 'E_WORKER_START_FAILED',
    message: 'Worker 未就绪，请稍后重试。',
    retryable: true,
    step: 'worker',
  };
};

/**
 * 向 Renderer 广播 Job 事件。
 *
 * 说明：
 * - 使用 `webContents.send` 推送到 Renderer。
 * - Renderer 侧通过 preload 暴露的订阅 API 接收。
 */
const sendJobEventToRenderer = (event: JobEvent): void => {
  if (!mainWindow) {
    return;
  }

  /**
   * 在跨进程边界上做一次运行时校验，避免 Main 发送脏数据到 UI。
   */
  const parsed = JobEventSchema.parse(event);
  mainWindow.webContents.send('vtot.job.event', parsed);
};

/**
 * 停止 Worker。
 *
 * 说明：
 * - 先尝试发送 `worker.shutdown`，让 Worker 自己退出。
 * - 若超时未退出，则强杀（兜底避免孤儿进程）。
 */
const stopWorker = (reason: string): void => {
  if (!workerProcess || !workerJobId) {
    return;
  }

  if (workerIsStopping) {
    return;
  }

  workerIsStopping = true;
  workerIsReady = false;

  console.log(`[main] stopping worker (reason=${reason})`);

  if (workerReadyTimer) {
    clearTimeout(workerReadyTimer);
    workerReadyTimer = null;
  }

  sendWorkerControl({
    type: 'worker.shutdown',
    data: { jobId: workerJobId, ts: Date.now() },
  });

  workerShutdownTimer = setTimeout(() => {
    if (!workerProcess) {
      return;
    }

    console.warn('[main] worker shutdown timeout, force killing');
    workerProcess.kill();
  }, 2000);
};

/**
 * 启动 Worker（骨架阶段：应用启动即启动）。
 *
 * 说明：
 * - Worker 入口文件来自 `apps/worker/dist/main.js`。
 * - 在 Electron 主进程里，fork 的 execPath 是 electron.exe，需要设置 `ELECTRON_RUN_AS_NODE=1`
 *   才能让子进程以 Node 模式运行脚本。
 */
const startWorker = (): void => {
  if (workerProcess) {
    return;
  }

  const jobId = 'dev-job';
  workerJobId = jobId;

  const workerEntry = path.join(__dirname, '../../worker/dist/main.js');

  workerProcess = fork(workerEntry, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      VTOT_JOB_ID: jobId,
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  const currentWorker = workerProcess;

  /**
   * 每次 spawn 之后默认未 ready。
   */
  workerIsReady = false;

  console.log(`[main] worker spawned pid=${currentWorker.pid ?? -1}`);

  workerReadyTimer = setTimeout(() => {
    console.error('[main] worker ready timeout');
    stopWorker('ready-timeout');
  }, 5000);

  /**
   * 订阅 Worker -> Main 消息。
   *
   * 注意：
   * - Node/Electron 的类型定义里 message 参数是 `any`，这里用 `unknown` 接住并交给 zod 校验。
   */
  currentWorker.on('message', ((rawMessage: unknown) => {
    const parsed = WorkerEventSchema.safeParse(rawMessage);

    if (!parsed.success) {
      console.error('[main] invalid worker event', parsed.error);
      return;
    }

    const event = parsed.data;

    if (event.type === 'worker.ready') {
      if (workerReadyTimer) {
        clearTimeout(workerReadyTimer);
        workerReadyTimer = null;
      }

      workerIsReady = true;

      console.log(
        `[main] worker ready jobId=${event.data.jobId} pid=${event.data.pid}`
      );

      /**
       * ready 之后发一个 ping，验证主进程 -> Worker -> 主进程的最小闭环。
       */
      sendWorkerControl({
        type: 'worker.ping',
        data: {
          jobId: event.data.jobId,
          nonce: randomUUID(),
          ts: Date.now(),
        },
      });

      return;
    }

    if (event.type === 'worker.pong') {
      console.log(
        `[main] worker pong jobId=${event.data.jobId} pid=${event.data.pid} nonce=${event.data.nonce}`
      );
      return;
    }

    if (event.type === 'worker.shutdown.ack') {
      console.log(
        `[main] worker shutdown ack jobId=${event.data.jobId} pid=${event.data.pid}`
      );

      return;
    }

    if (
      event.type === 'job.progress' ||
      event.type === 'job.log' ||
      event.type === 'job.status'
    ) {
      sendJobEventToRenderer(event);
      return;
    }
  }) as (message: unknown, sendHandle: unknown) => void);

  currentWorker.on(
    'exit',
    (code: number | null, signal: NodeJS.Signals | null) => {
      console.log(
        `[main] worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`
      );

      if (workerReadyTimer) {
        clearTimeout(workerReadyTimer);
        workerReadyTimer = null;
      }

      if (workerShutdownTimer) {
        clearTimeout(workerShutdownTimer);
        workerShutdownTimer = null;
      }

      workerProcess = null;
      workerJobId = null;
      workerIsReady = false;
      workerIsStopping = false;
    }
  );

  currentWorker.on('error', (err: Error) => {
    console.error('[main] worker process error', err);
  });
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

      if (!isWorkerAvailable()) {
        return { ok: false, error: createWorkerNotReadyError() };
      }

      const jobId = randomUUID();
      let jobRootPath: string;
      try {
        jobRootPath = await prepareJobRoot(jobId, request);
      } catch (err) {
        console.error('[main] failed to prepare job root', err);

        return {
          ok: false,
          error: {
            code: 'E_ENVIRONMENT_ERROR',
            message: '创建 JobRoot 目录失败，请重试。',
            retryable: true,
            step: 'job.create',
            detail: {
              reason: err instanceof Error ? err.message : String(err),
            },
          },
        };
      }

      /**
       * 先给 UI 一个 queued 状态，提升交互反馈。
       */
      sendJobEventToRenderer({
        type: 'job.status',
        data: {
          jobId,
          status: 'queued',
          step: 'queued',
          ts: Date.now(),
        },
      });

      sendWorkerControl({
        type: 'job.start',
        data: {
          jobId,
          sourceFilePath: request.sourceFilePath,
          jobRootPath,
          options: request.options,
          ts: Date.now(),
        },
      });

      const data = JobCreateResponseSchema.parse({ jobId });
      return { ok: true, data };
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

      const request: JobCancelRequest = parsedRequest.data;

      if (!isWorkerAvailable()) {
        return { ok: false, error: createWorkerNotReadyError() };
      }

      await writeCancelFlag(request.jobId);

      sendWorkerControl({
        type: 'job.cancel',
        data: {
          jobId: request.jobId,
          ts: Date.now(),
        },
      });

      const data = JobCancelResponseSchema.parse({ jobId: request.jobId });
      return { ok: true, data };
    }
  );

  ipcMain.handle(
    'vtot.dialog.selectSourceFile',
    async (): Promise<IpcInvokeResult<SelectSourceFileResponse>> => {
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
};

/**
 * 应用 ready 后启动。
 */
app.whenReady().then(async () => {
  registerIpcHandlers();

  /**
   * 启动 Worker（骨架验证：启动后应在控制台看到 worker.ready / worker.pong 日志）。
   */
  startWorker();
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

/**
 * 应用退出前尝试优雅关闭 Worker。
 */
app.on('before-quit', () => {
  stopWorker('app-before-quit');
});
