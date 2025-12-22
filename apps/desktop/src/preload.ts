import { contextBridge, ipcRenderer } from 'electron';

import type { IpcInvokeResult, PingResponse } from '@vtot/shared';

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
} as const;

/**
 * 把 api 注入到 Renderer 的 `window.vtot`。
 */
contextBridge.exposeInMainWorld('vtot', api);
