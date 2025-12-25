import { useCallback, useState } from 'react';
import type { JobCreateRequest } from '@vtot/shared';
import styles from '../styles/JobCreateModal.module.css';

/**
 * JobCreateModal 组件：用于创建新任务的弹窗。
 */
interface JobCreateModalProps {
  /** 控制弹窗关闭 */
  onClose: () => void;
  /** 任务创建成功后的回调 */
  onCreated: (jobId: string) => void;
}

export const JobCreateModal = ({ onClose, onCreated }: JobCreateModalProps) => {
  const [sourceFilePath, setSourceFilePath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 调用 preload 暴露的 API 选择文件
   */
  const onPickFile = useCallback(async () => {
    if (!window.vtot?.dialog?.selectSourceFile) return;
    
    const result = await window.vtot.dialog.selectSourceFile();
    if (result.ok && result.data.filePath) {
      setSourceFilePath(result.data.filePath);
    }
  }, []);

  /**
   * 提交创建任务请求
   */
  const onSubmit = useCallback(async () => {
    if (!sourceFilePath) {
      setError('请选择源文件');
      return;
    }

    setLoading(true);
    setError(null);

    const request: JobCreateRequest = {
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

    try {
      const vtot = window.vtot;
      if (!vtot) {
        setError('vtot API 未加载');
        return;
      }
      const result = await vtot.job.create(request);
      if (result.ok) {
        onCreated(result.data.jobId);
        onClose();
      } else {
        setError(`${result.error.code}: ${result.error.message}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sourceFilePath, onClose, onCreated]);

  return (
    <div className={styles.modal}>
      <div className={styles['modal__overlay']} onClick={onClose} />
      <div className={styles['modal__content']}>
        <h2 className={styles['modal__title']}>创建新任务</h2>
        
        <div className={styles['modal__field']}>
          <label className={styles['modal__label']}>源文件</label>
          <div className={styles['modal__row']}>
            <input 
              className={styles['modal__input']} 
              value={sourceFilePath} 
              readOnly 
              placeholder="请选择媒体文件..."
            />
            <button 
              className={styles['modal__picker-btn']} 
              onClick={onPickFile}
              disabled={loading}
            >
              浏览
            </button>
          </div>
        </div>

        {error && <div className={styles['modal__error']}>{error}</div>}

        <div className={styles['modal__actions']}>
          <button 
            className={styles['modal__btn--secondary']} 
            onClick={onClose}
            disabled={loading}
          >
            取消
          </button>
          <button 
            className={styles['modal__btn--primary']} 
            onClick={onSubmit}
            disabled={loading || !sourceFilePath}
          >
            {loading ? '创建中...' : '开始任务'}
          </button>
        </div>
      </div>
    </div>
  );
};
