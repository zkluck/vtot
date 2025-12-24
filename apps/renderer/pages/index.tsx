import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  IpcInvokeResult,
  JobCreateRequest,
  JobEvent,
  JobStatus,
  PingResponse,
} from '@vtot/shared';

import styles from '../styles/Home.module.css';

/**
 * 页面状态：用于展示 ping 过程与结果。
 *
 * 说明：
 * - 这里只做最小状态机，便于后续扩展到 job 列表/详情。
 */
type PingState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

/**
 * 页面状态：用于展示任务创建/取消与事件联通性。
 */
type JobUiState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

/**
 * JobViewModel：用于 UI 展示的任务视图模型。
 *
 * 说明：
 * - 权威数据后续会来自 DB；本阶段先用事件流在 Renderer 内构建最小可视化。
 */
type JobViewModel = {
  /** 任务 ID */
  jobId: string;
  /** 当前状态 */
  status?: JobStatus;
  /** 当前 step */
  step?: string;
  /** 0-100 */
  percent?: number;
  /** 面向用户的提示 */
  message?: string;
  /** 最近更新时间（ms） */
  updatedAt?: number;
  /** 日志行（已格式化） */
  logs: string[];
  /** 已完成步骤列表（按接收顺序去重） */
  finishedSteps: string[];
};

/**
 * stub 的默认 JobCreateRequest。
 *
 * 说明：
 * - 真实版本会由 UI 表单产生；本阶段只要能跑通闭环即可。
 */
const createDefaultJobCreateRequest = (
  sourceFilePath: string
): JobCreateRequest => {
  return {
    sourceFilePath,
    importStrategy: 'reference',
    options: {
      language: 'zh',
      modelSize: 'medium',
      diarization: {
        enabled: false,
      },
      export: {
        formats: ['srt'],
        speakerStyle: 'none',
      },
    },
  };
};

/**
 * 把 Worker/Main 发来的结构化 JobEvent 格式化成 UI 可读的日志行。
 */
const formatJobEventToLogLine = (event: JobEvent): string => {
  const time = new Date(event.data.ts).toLocaleTimeString();

  if (event.type === 'job.log') {
    const stepText = event.data.step ? `(${event.data.step}) ` : '';
    return `${time} [${event.data.level}] ${stepText}${event.data.message}`;
  }

  if (event.type === 'job.progress') {
    return `${time} [progress] ${event.data.step} ${event.data.percent}% ${event.data.message}`;
  }

  const stepText = event.data.step ? `(${event.data.step}) ` : '';
  return `${time} [status] ${stepText}${event.data.status}`;
};

/**
 * 首页（基础框架演示）。
 *
 * 用途：
 * - 验证 Renderer(Next.js) 是否能通过 preload 暴露的 API 调用 Main IPC。
 * - 后续可以把这里替换成任务列表/导入入口。
 */
export default function HomePage() {
  const [pingState, setPingState] = useState<PingState>({ status: 'idle' });

  /**
   * Job UI：
   * - `sourceFilePath`：模拟导入文件路径。
   * - `jobs`：按 jobId 缓存任务的最新视图模型。
   * - `currentJobId`：当前在页面上展示的任务。
   */
  const [jobUiState, setJobUiState] = useState<JobUiState>({ status: 'idle' });
  const [sourceFilePath, setSourceFilePath] =
    useState<string>('C:\\path\\demo.mp4');
  const [sourceFileError, setSourceFileError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobViewModel>>({});
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  /**
   * 触发一次 ping。
   *
   * 注意：
   * - 只有在 Electron 环境中（preload 注入 window.vtot）才会成功。
   */
  const onPing = useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!window.vtot) {
      setPingState({
        status: 'error',
        message:
          'vtot preload API 未注入：请用 Electron 启动 Desktop，或检查 preload 配置。',
      });
      return;
    }

    setPingState({ status: 'loading' });

    const result: IpcInvokeResult<PingResponse> = await window.vtot.ping();

    if (result.ok) {
      setPingState({ status: 'success', message: result.data.message });
      return;
    }

    setPingState({
      status: 'error',
      message: `${result.error.code}: ${result.error.message}`,
    });
  }, []);

  /**
   * 订阅任务事件。
   *
   * 说明：
   * - 这里在页面加载时就订阅一次。
   * - 事件可能会早于 `job.create` 的 promise resolve（例如 Main 先发 queued 状态），因此需要先缓存。
   */
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!window.vtot) {
      return;
    }

    const off = window.vtot.job.onEvent((event) => {
      setCurrentJobId((prev) => prev ?? event.data.jobId);

      setJobs((prev) => {
        const existing: JobViewModel = prev[event.data.jobId] ?? {
          jobId: event.data.jobId,
          logs: [],
          finishedSteps: [],
        };

        const logLine = formatJobEventToLogLine(event);
        const nextFinishedSteps =
          event.type === 'job.progress' || event.type === 'job.status'
            ? Array.from(
                new Set(
                  [
                    ...existing.finishedSteps,
                    event.data.step ?? existing.step ?? '',
                  ].filter(Boolean)
                )
              )
            : existing.finishedSteps;

        if (event.type === 'job.progress') {
          return {
            ...prev,
            [event.data.jobId]: {
              ...existing,
              status: event.data.status,
              step: event.data.step,
              percent: event.data.percent,
              message: event.data.message,
              updatedAt: event.data.ts,
              finishedSteps: nextFinishedSteps,
              logs: [...existing.logs, logLine],
            },
          };
        }

        if (event.type === 'job.status') {
          return {
            ...prev,
            [event.data.jobId]: {
              ...existing,
              status: event.data.status,
              step: event.data.step,
              updatedAt: event.data.ts,
              finishedSteps: nextFinishedSteps,
              logs: [...existing.logs, logLine],
            },
          };
        }

        return {
          ...prev,
          [event.data.jobId]: {
            ...existing,
            updatedAt: event.data.ts,
            finishedSteps: nextFinishedSteps,
            logs: [...existing.logs, logLine],
          },
        };
      });
    });

    return () => {
      off();
    };
  }, []);

  /**
   * 创建一个 stub 任务。
   */
  const onCreateJob = useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!window.vtot) {
      setJobUiState({
        status: 'error',
        message:
          'vtot preload API 未注入：请用 Electron 启动 Desktop，或检查 preload 配置。',
      });
      return;
    }

    setJobUiState({ status: 'loading' });

    const request = createDefaultJobCreateRequest(sourceFilePath);
    const result = await window.vtot.job.create(request);

    if (!result.ok) {
      setJobUiState({
        status: 'error',
        message: `${result.error.code}: ${result.error.message}`,
      });
      return;
    }

    setCurrentJobId(result.data.jobId);
    setJobs((prev) => {
      const existing = prev[result.data.jobId];

      if (existing) {
        return prev;
      }

      return {
        ...prev,
        [result.data.jobId]: {
          jobId: result.data.jobId,
          status: 'queued',
          step: 'queued',
          finishedSteps: [],
          logs: [],
        },
      };
    });

    setJobUiState({
      status: 'success',
      message: `job created: ${result.data.jobId}`,
    });
  }, [sourceFilePath]);

  /**
   * 选择本地源文件。
   */
  const onPickSourceFile = useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!window.vtot?.dialog?.selectSourceFile) {
      setSourceFileError('当前环境无法打开文件选择器，请在 Electron 内使用。');
      return;
    }

    setSourceFileError(null);

    const result = await window.vtot.dialog.selectSourceFile();

    if (!result.ok) {
      setSourceFileError(`${result.error.code}: ${result.error.message}`);
      return;
    }

    if (!result.data.filePath) {
      setSourceFileError('未选择任何文件。');
      return;
    }

    setSourceFilePath(result.data.filePath);
  }, []);

  /**
   * 取消当前任务。
   */
  const onCancelJob = useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!window.vtot) {
      setJobUiState({
        status: 'error',
        message:
          'vtot preload API 未注入：请用 Electron 启动 Desktop，或检查 preload 配置。',
      });
      return;
    }

    if (!currentJobId) {
      setJobUiState({ status: 'error', message: '当前没有可取消的任务。' });
      return;
    }

    setJobUiState({ status: 'loading' });

    const result = await window.vtot.job.cancel({ jobId: currentJobId });

    if (!result.ok) {
      setJobUiState({
        status: 'error',
        message: `${result.error.code}: ${result.error.message}`,
      });
      return;
    }

    setJobUiState({
      status: 'success',
      message: `job canceled: ${result.data.jobId}`,
    });
  }, [currentJobId]);

  /**
   * 根据状态生成 UI 文案。
   *
   * 说明：
   * - 避免在 JSX 里写过多条件分支，保持结构清晰。
   */
  const resultText = useMemo((): string => {
    if (pingState.status === 'idle') {
      return '点击按钮测试 Renderer <-> Main IPC。';
    }

    if (pingState.status === 'loading') {
      return '请求中...';
    }

    if (pingState.status === 'success') {
      return `成功：${pingState.message}`;
    }

    return `失败：${pingState.message}`;
  }, [pingState]);

  /**
   * 任务区域展示文案。
   */
  const jobResultText = useMemo((): string => {
    if (jobUiState.status === 'idle') {
      return '创建一个 stub 任务，观察 progress/log/status 事件是否能从 Worker 透传到 UI。';
    }

    if (jobUiState.status === 'loading') {
      return '请求中...';
    }

    if (jobUiState.status === 'success') {
      // 仅当存在 message 时展示，避免类型告警
      return jobUiState.message ? `成功：${jobUiState.message}` : '成功';
    }

    return jobUiState.message ? `失败：${jobUiState.message}` : '失败';
  }, [jobUiState]);

  /**
   * 当前任务的视图模型。
   */
  const currentJob = useMemo((): JobViewModel | null => {
    if (!currentJobId) {
      return null;
    }

    return jobs[currentJobId] ?? null;
  }, [currentJobId, jobs]);

  return (
    <div className={styles.home}>
      <div className={styles['home__panel']}>
        <h1 className={styles['home__title']}>VTOT</h1>
        <p className={styles['home__desc']}>
          基础框架：Renderer(Next.js) + Main(Electron) + shared(zod/types)
        </p>

        <button
          className={styles['home__button']}
          type="button"
          onClick={onPing}
        >
          Ping Main
        </button>

        <div className={styles['home__result']}>{resultText}</div>

        <div className={styles['home__section']}>
          <h2 className={styles['home__subtitle']}>Job Stub</h2>

          <label className={styles['home__label']} htmlFor="sourceFilePath">
            源文件路径（stub）
          </label>
          <input
            id="sourceFilePath"
            className={styles['home__input']}
            value={sourceFilePath}
            onChange={(e) => setSourceFilePath(e.target.value)}
          />
          <button
            className={styles['home__pickerButton']}
            type="button"
            onClick={onPickSourceFile}
          >
            选择文件
          </button>

          <div className={styles['home__buttons']}>
            <button
              className={styles['home__button']}
              type="button"
              onClick={onCreateJob}
            >
              Create Job
            </button>

            <button
              className={styles['home__buttonSecondary']}
              type="button"
              onClick={onCancelJob}
              disabled={!currentJobId}
            >
              Cancel Job
            </button>
          </div>

          <div className={styles['home__result']}>{jobResultText}</div>

          <div className={styles['home__meta']}>
            <div>当前任务：{currentJobId ?? '-'}</div>
            <div>状态：{currentJob?.status ?? '-'}</div>
            <div>
              进度：
              {typeof currentJob?.percent === 'number'
                ? `${currentJob.percent}%`
                : '-'}
            </div>
            <div>提示：{currentJob?.message ?? '-'}</div>
            <div>
              已完成步骤：
              {currentJob?.finishedSteps?.length
                ? currentJob.finishedSteps.join(' / ')
                : '-'}
            </div>
          </div>

          <div className={styles['home__log']}>
            {(currentJob?.logs ?? []).join('\n')}
          </div>
        </div>
      </div>
    </div>
  );
}
