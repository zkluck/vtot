import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import type { PersistedJob, JobEvent } from '@vtot/shared';
import styles from '../../styles/JobDetail.module.css';
import { translateStep, translateStatus } from '../../utils/i18n';

/**
 * JobDetailPage：任务详情页。
 */
export default function JobDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const [job, setJob] = useState<PersistedJob | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * 加载任务详情
   */
  const loadJob = useCallback(async () => {
    const vtot = window.vtot;
    if (!id || typeof id !== 'string' || !vtot?.job?.get) return;
    
    const result = await vtot.job.get(id);
    if (result.ok && result.data) {
      setJob(result.data);
    }
    setLoading(false);
  }, [id]);

  /**
   * 订阅该任务的事件
   */
  useEffect(() => {
    const vtot = window.vtot;
    if (!id || typeof id !== 'string' || !vtot?.job?.onEvent) return;

    loadJob();

    const off = vtot.job.onEvent((event) => {
      if (event.data.jobId !== id) return;

      // 更新任务状态
      if (event.type === 'job.status' || event.type === 'job.progress') {
        setJob((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            status: event.data.status,
            step: event.data.step || prev.step,
          };
        });
      }

      // 添加日志
      const time = new Date(event.data.ts).toLocaleTimeString();
      let logLine = '';
      if (event.type === 'job.log') {
        logLine = `[${time}] [${event.data.level}] ${event.data.message}`;
      } else if (event.type === 'job.progress') {
        logLine = `[${time}] [PROGRESS] ${translateStep(event.data.step)} ${event.data.percent}% - ${event.data.message}`;
      } else if (event.type === 'job.status') {
        logLine = `[${time}] [STATUS] 状态变更: ${translateStatus(event.data.status)}`;
      }

      if (logLine) {
        setLogs((prev) => [...prev, logLine]);
      }
    });

    return () => off();
  }, [id, loadJob]);

  if (loading) {
    return <div className={styles.container}>加载中...</div>;
  }

  if (!job) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          <h1>未找到任务</h1>
          <p>该任务 ID ({id}) 不存在或已被删除。</p>
          <Link href="/" className={styles['error__link']}>返回首页</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles['header__content']}>
          <Link href="/" className={styles['header__back']}>← 返回列表</Link>
          <h1 className={styles['header__title']}>任务详情</h1>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.card}>
          <div className={styles['card__header']}>
            <h2 className={styles['card__title']}>基本信息</h2>
            <span className={`${styles['status-tag']} ${styles[`status-tag--${job.status}`]}`}>
              {translateStatus(job.status)}
            </span>
          </div>
          <div className={styles['card__body']}>
            <div className={styles['info-row']}>
              <span className={styles['info-row__label']}>任务 ID:</span>
              <span className={styles['info-row__value']}>{job.jobId}</span>
            </div>
            <div className={styles['info-row']}>
              <span className={styles['info-row__label']}>源文件:</span>
              <span className={styles['info-row__value']}>{job.source.originalPath}</span>
            </div>
            <div className={styles['info-row']}>
              <span className={styles['info-row__label']}>创建时间:</span>
              <span className={styles['info-row__value']}>{new Date(job.meta.createdAt).toLocaleString()}</span>
            </div>
            {job.step && (
              <div className={styles['info-row']}>
                <span className={styles['info-row__label']}>当前步骤:</span>
                <span className={styles['info-row__value']}>{translateStep(job.step)}</span>
              </div>
            )}
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles['card__header']}>
            <h2 className={styles['card__title']}>实时日志</h2>
          </div>
          <div className={styles.logs}>
            {logs.length === 0 ? (
              <div className={styles['logs--empty']}>暂无实时日志...</div>
            ) : (
              logs.map((log, idx) => (
                <div key={idx} className={styles['log-line']}>{log}</div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
