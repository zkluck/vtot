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
 * Window 类型扩展。
 *
 * 用途：
 * - 让 Renderer 侧能拿到 preload 注入的 API 的类型提示。
 * - 避免在业务代码里写任何 `any`。
 *
 * 注意：
 * - 该字段由 `apps/desktop/src/preload.ts` 通过 contextBridge 注入。
 */
declare global {
  interface Window {
    /**
     * vtot：由 Electron preload 注入。
     *
     * 说明：
     * - 这里声明为可选（optional），因为你也可能直接在浏览器里启动 Next dev server。
     * - 在非 Electron 环境下该字段不存在，业务代码需要做兜底处理。
     */
    vtot?: {
      /**
       * ping：验证 Renderer <-> Main 的最小联通性。
       */
      ping: () => Promise<IpcInvokeResult<PingResponse>>;

      /**
       * job：任务相关 API。
       */
      job: {
        /**
         * create：创建任务并触发执行（MVP stub）。
         */
        create: (
          request: JobCreateRequest
        ) => Promise<IpcInvokeResult<JobCreateResponse>>;

        /**
         * cancel：取消任务。
         */
        cancel: (
          request: JobCancelRequest
        ) => Promise<IpcInvokeResult<JobCancelResponse>>;

        /**
         * onEvent：订阅任务事件。
         */
        onEvent: (handler: (event: JobEvent) => void) => () => void;
      };
    };
  }
}

export {};
