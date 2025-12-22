import { useCallback, useMemo, useState } from 'react';

import type { IpcInvokeResult, PingResponse } from '@vtot/shared';

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
 * 首页（基础框架演示）。
 *
 * 用途：
 * - 验证 Renderer(Next.js) 是否能通过 preload 暴露的 API 调用 Main IPC。
 * - 后续可以把这里替换成任务列表/导入入口。
 */
export default function HomePage() {
  const [pingState, setPingState] = useState<PingState>({ status: 'idle' });

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
      </div>
    </div>
  );
}
