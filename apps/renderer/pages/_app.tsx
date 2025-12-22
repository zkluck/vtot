import type { AppProps } from 'next/app';

import '../styles/globals.css';

/**
 * Next.js 自定义 App。
 *
 * 用途：
 * - 注入全局 CSS。
 * - 未来如果需要全局状态（例如 jotai Provider）、全局错误边界，也放在这里。
 */
export default function VtotApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
