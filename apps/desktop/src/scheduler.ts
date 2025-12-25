import { fork, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { 
  JobEvent, 
  WorkerControl, 
  PersistedJob,
  JobStatus,
  AppError,
  JobCreateRequest
} from '@vtot/shared';
import { 
  WorkerEventSchema,
  WorkerControlSchema,
} from '@vtot/shared';
import * as db from './db';

/**
 * 任务执行上下文。
 */
interface JobContext {
  jobId: string;
  jobRootPath: string;
  request: JobCreateRequest;
}

/**
 * JobScheduler: 负责协调任务队列与 Worker 进程。
 */
export class JobScheduler {
  private queue: JobContext[] = [];
  private activeJobs = new Map<string, {
    process: ChildProcess;
    context: JobContext;
    isReady: boolean;
  }>();

  private maxConcurrent = 1;

  constructor(
    private readonly workerEntry: string,
    private readonly onEvent: (event: JobEvent) => void
  ) {}

  /**
   * 将任务加入队列。
   */
  public enqueue(context: JobContext) {
    this.queue.push(context);
    this.processQueue();
  }

  /**
   * 处理队列。
   */
  private processQueue() {
    if (this.activeJobs.size >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const context = this.queue.shift();
    if (!context) return;

    this.startWorker(context);
  }

  /**
   * 启动 Worker。
   */
  private startWorker(context: JobContext) {
    const { jobId, jobRootPath, request } = context;

    const cp = fork(this.workerEntry, [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        VTOT_JOB_ID: jobId,
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });

    this.activeJobs.set(jobId, {
      process: cp,
      context,
      isReady: false,
    });

    cp.on('message', (raw: unknown) => {
      const parsed = WorkerEventSchema.safeParse(raw);
      if (!parsed.success) return;

      const event = parsed.data;

      if (event.type === 'worker.ready') {
        const active = this.activeJobs.get(jobId);
        if (active) {
          active.isReady = true;
          // 发送启动指令
          this.sendControl(jobId, {
            type: 'job.start',
            data: {
              jobId,
              sourceFilePath: request.sourceFilePath,
              jobRootPath,
              options: request.options,
              ts: Date.now()
            }
          });
        }
      }

      // 同步更新数据库状态
      if (event.type === 'job.status') {
        db.updateJobStatus(
          event.data.jobId,
          event.data.status,
          event.data.step,
          event.data.error
        );
      }

      // 转发事件到 Renderer
      if (
        event.type === 'job.progress' || 
        event.type === 'job.log' || 
        event.type === 'job.status'
      ) {
        this.onEvent(event);
      }
    });

    cp.on('exit', (code, signal) => {
      console.log(`[scheduler] worker for ${jobId} exited code=${code} signal=${signal}`);
      this.activeJobs.delete(jobId);
      this.processQueue();
    });

    cp.on('error', (err) => {
      console.error(`[scheduler] worker for ${jobId} error`, err);
    });
  }

  private sendControl(jobId: string, control: WorkerControl) {
    const active = this.activeJobs.get(jobId);
    if (active && active.process.connected) {
      active.process.send(WorkerControlSchema.parse(control));
    }
  }

  /**
   * 取消任务。
   */
  public async cancelJob(jobId: string) {
    // 1. 如果在队列中，直接移除
    const queueIdx = this.queue.findIndex(q => q.jobId === jobId);
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1);
      db.updateJobStatus(jobId, 'canceled');
      this.onEvent({
        type: 'job.status',
        data: { jobId, status: 'canceled', step: 'queue', ts: Date.now() }
      });
      return;
    }

    // 2. 如果正在运行，发送指令并设置 cancel.flag (保持与之前逻辑同步)
    const active = this.activeJobs.get(jobId);
    if (active) {
      const cancelFlagPath = path.join(active.context.jobRootPath, 'cancel.flag');
      try {
        await fs.writeFile(cancelFlagPath, `${Date.now()}\n`, 'utf-8');
      } catch (err) {
        console.warn(`[scheduler] failed to write cancel.flag for ${jobId}`, err);
      }

      this.sendControl(jobId, {
        type: 'job.cancel',
        data: { jobId, ts: Date.now() }
      });
    }
  }

  /**
   * 更新最大并发数。
   */
  public updateMaxConcurrent(newMax: number): void {
    this.maxConcurrent = newMax;
    // 尝试调度新任务
    this.processQueue();
  }
}
