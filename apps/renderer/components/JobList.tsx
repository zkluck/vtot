import type { PersistedJob } from '@vtot/shared';
import styles from '../styles/JobList.module.css';
import Link from 'next/link';
import { translateStep, translateStatus } from '../utils/i18n';

/**
 * JobList 组件：展示任务列表。
 */
interface JobListProps {
  /** 任务数组 */
  jobs: PersistedJob[];
  /** 取消任务的回调 */
  onCancel: (jobId: string) => void;
}

export const JobList = ({ jobs, onCancel }: JobListProps) => {
  if (jobs.length === 0) {
    return (
      <div className={styles['job-list--empty']}>
        暂无任务，快去创建一个吧！
      </div>
    );
  }

  return (
    <div className={styles['job-list']}>
      {jobs.map((job) => (
        <div key={job.jobId} className={styles['job-item']}>
          <div className={styles['job-item__main']}>
            <div className={styles['job-item__info']}>
              <div className={styles['job-item__title']} title={job.source.originalPath}>
                {job.source.originalPath.split(/[\\/]/).pop() || '未知文件'}
              </div>
              <div className={styles['job-item__meta']}>
                ID: {job.jobId.slice(0, 8)}... | {new Date(job.meta.createdAt).toLocaleString()}
              </div>
            </div>
            
            <div className={styles['job-item__status-container']}>
              <span className={`${styles['job-item__status']} ${styles[`job-item__status--${job.status}`]}`}>
                {translateStatus(job.status)}
              </span>
              {job.step && (
                <span className={styles['job-item__step']}>
                  {translateStep(job.step)}
                </span>
              )}
            </div>
          </div>

          <div className={styles['job-item__footer']}>
            <div className={styles['job-item__actions']}>
              <Link href={`/jobs/${job.jobId}`} className={styles['job-item__btn-link']}>
                查看详情
              </Link>
              {(job.status === 'queued' || job.status === 'running') && (
                <button 
                  className={styles['job-item__btn--cancel']} 
                  onClick={() => onCancel(job.jobId)}
                >
                  取消
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
