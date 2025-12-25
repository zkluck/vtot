import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { PersistedJob } from '@vtot/shared';
import { JobList } from '../components/JobList';
import { JobCreateModal } from '../components/JobCreateModal';
import styles from '../styles/Index.module.css';

/**
 * 首页：任务列表管理。
 */
export default function IndexPage() {
  const [jobs, setJobs] = useState<PersistedJob[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [loading, setLoading] = useState(true);

  /**
   * 刷新任务列表
   */
  const refreshJobs = useCallback(async () => {
    const vtot = window.vtot;
    if (!vtot?.job?.list) return;
    
    const result = await vtot.job.list();
    if (result.ok) {
      setJobs(result.data);
    }
    setLoading(false);
  }, []);

  /**
   * 处理任务取消
   */
  const onCancelJob = useCallback(async (jobId: string) => {
    const vtot = window.vtot;
    if (!vtot?.job?.cancel) return;
    
    const result = await vtot.job.cancel({ jobId });
    if (result.ok) {
      // 这里的状态更新会由于事件订阅而自动刷新，但为了体验可以立即手动刷新一次
      refreshJobs();
    }
  }, [refreshJobs]);

  /**
   * 订阅实时事件
   */
  useEffect(() => {
    const vtot = window.vtot;
    if (!vtot?.job?.onEvent) return;

    refreshJobs();

    const off = vtot.job.onEvent((event) => {
      // 只要有任何任务事件，就刷新列表以确保状态同步
      // 后续如果性能考量，可以只更新对应的 job 项
      refreshJobs();
    });

    return () => off();
  }, [refreshJobs]);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles['header__content']}>
          <h1 className={styles['header__title']}>VTOT 任务管理</h1>
          <div className={styles['header__actions']}>
            <Link href="/settings" className={styles['header__link']}>
              应用设置
            </Link>
            <button 
              className={styles['header__btn']}
              onClick={() => setShowCreateModal(true)}
            >
              新建任务
            </button>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        {loading ? (
          <div className={styles.loading}>加载中...</div>
        ) : (
          <JobList jobs={jobs} onCancel={onCancelJob} />
        )}
      </main>

      {showCreateModal && (
        <JobCreateModal 
          onClose={() => setShowCreateModal(false)} 
          onCreated={(jobId) => {
            console.log('Job created:', jobId);
            refreshJobs();
          }}
        />
      )}
    </div>
  );
}
