import { contextBridge, ipcRenderer } from 'electron';

import type {
  IpcInvokeResult,
  JobCancelRequest,
  JobCancelResponse,
  JobCreateRequest,
  JobCreateResponse,
  JobEvent,
  PingResponse,
} from '@vtot/shared';

/**
 * Electron Preload 脚本。
 *
 * 用途：
 * - 作为 Renderer 与 Main 之间的“安全桥梁”。
 * - 在 `contextIsolation=true` 的前提下，只暴露最小、可审计的 API。
 *
 * 注意：
 * - 不要把 `ipcRenderer` 或任何 Node API 直接挂到 window 上。
 * - 所有暴露出去的函数都应该是“纯输入 -> 纯输出”，不要透传可执行对象。
 */

/**
 * 暴露给 Renderer 的 API。
 */
const api = {
  /**
   * ping：验证 Renderer <-> Main 的最小联通性。
   */
  ping: async (): Promise<IpcInvokeResult<PingResponse>> => {
    const result = (await ipcRenderer.invoke(
      'vtot.ping'
    )) as IpcInvokeResult<PingResponse>;

    /**
     * 这里不做深度校验（避免重复校验 + 保持最小实现）。
     *
     * 后续如果你希望 Renderer 侧也做运行时校验：
     * - 可以在 shared 增加 `createIpcInvokeResultSchema(PingResponseSchema)` 并在这里 parse。
     */
    return result;
  },

  /**
   * job：任务相关 API。
   *
   * 说明：
   * - 所有 API 都通过 `ipcRenderer.invoke` 走 Main 进程的 handler。
   * - preload 只暴露“有限、可审计”的能力，避免 Renderer 直接操控任意 IPC 通道。
   */
  job: {
    /**
     * create：创建任务并触发执行（MVP stub）。
     */
    create: async (
      request: JobCreateRequest
    ): Promise<IpcInvokeResult<JobCreateResponse>> => {
      const result = (await ipcRenderer.invoke(
        'vtot.job.create',
        request
      )) as IpcInvokeResult<JobCreateResponse>;

      return result;
    },

    /**
     * cancel：取消任务。
     */
    cancel: async (
      request: JobCancelRequest
    ): Promise<IpcInvokeResult<JobCancelResponse>> => {
      const result = (await ipcRenderer.invoke(
        'vtot.job.cancel',
        request
      )) as IpcInvokeResult<JobCancelResponse>;

      return result;
    },

    /**
     * onEvent：订阅 Main 转发的任务事件（来自 Worker 的 job.*）。
     *
     * 注意：
     * - 返回的函数用于取消订阅，避免热更新/页面切换导致 listener 泄漏。
     * - Main 进程在转发前已做 zod 校验，preload 不再重复校验，避免引入运行时依赖。
     */
    onEvent: (handler: (event: JobEvent) => void): (() => void) => {
      const listener = (_event: unknown, rawEvent: unknown): void => {
        handler(rawEvent as JobEvent);
      };

      ipcRenderer.on('vtot.job.event', listener);

      return () => {
        ipcRenderer.removeListener('vtot.job.event', listener);
      };
    },
  },
} as const;

/**
 * 把 api 注入到 Renderer 的 `window.vtot`。
 */
contextBridge.exposeInMainWorld('vtot', api);
