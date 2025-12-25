import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { AppSettings, EnvCheckResult } from '@vtot/shared';
import styles from '../styles/Settings.module.css';

/**
 * 设置页面。
 */
export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [envReport, setEnvReport] = useState<EnvCheckResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const loadSettings = useCallback(async () => {
    const vtot = window.vtot;
    if (!vtot?.settings?.get) return;
    const res = await vtot.settings.get();
    if (res.ok) {
      setSettings(res.data);
    }
  }, []);

  const checkEnv = useCallback(async () => {
    const vtot = window.vtot;
    if (!vtot?.env?.check) return;
    setChecking(true);
    const res = await vtot.env.check();
    if (res.ok) {
      setEnvReport(res.data);
    }
    setChecking(false);
  }, []);

  useEffect(() => {
    loadSettings();
    checkEnv();
  }, [loadSettings, checkEnv]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;

    const vtot = window.vtot;
    if (!vtot?.settings?.set) return;

    setSaving(true);
    const res = await vtot.settings.set(settings);
    if (res.ok) {
      alert('保存成功');
    } else {
      alert('保存失败: ' + res.error.message);
    }
    setSaving(false);
  };

  if (!settings) return <div className={styles.loading}>加载中...</div>;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles['header__content']}>
          <h1 className={styles['header__title']}>应用设置</h1>
          <Link href="/" className={styles['header__back']}>返回列表</Link>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.section}>
          <h2 className={styles['section__title']}>通用配置</h2>
          <form className={styles.form} onSubmit={handleSave}>
            <div className={styles['form__group']}>
              <label className={styles['form__label']}>Hugging Face Token</label>
              <input 
                type="password" 
                className={styles['form__input']}
                value={settings.hfToken || ''}
                onChange={e => setSettings({...settings, hfToken: e.target.value})}
                placeholder="用于说话人分离 (pyannote.audio)"
              />
              <p className={styles['form__hint']}>
                访问 <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">Hugging Face</a> 获取 Token。
              </p>
            </div>

            <div className={styles['form__group']}>
              <label className={styles['form__label']}>默认模型规格</label>
              <select 
                className={styles['form__select']}
                value={settings.defaultModelSize}
                onChange={e => setSettings({...settings, defaultModelSize: e.target.value as any})}
              >
                <option value="tiny">Tiny (极快, 低显存)</option>
                <option value="base">Base</option>
                <option value="small">Small</option>
                <option value="medium">Medium (推荐)</option>
                <option value="large">Large (极慢, 高显存)</option>
              </select>
            </div>

            <div className={styles['form__group']}>
              <label className={styles['form__label']}>最大并发任务数</label>
              <input 
                type="number" 
                className={styles['form__input']}
                min={1} 
                max={4}
                value={settings.maxConcurrentJobs}
                onChange={e => setSettings({...settings, maxConcurrentJobs: parseInt(e.target.value) || 1})}
              />
            </div>

            <button type="submit" className={styles['form__submit']} disabled={saving}>
              {saving ? '保存中...' : '保存设置'}
            </button>
          </form>
        </section>

        <section className={styles.section}>
          <div className={styles['section__header']}>
            <h2 className={styles['section__title']}>环境探测</h2>
            <button 
              className={styles['section__refresh']} 
              onClick={checkEnv}
              disabled={checking}
            >
              {checking ? '探测中...' : '重新探测'}
            </button>
          </div>
          
          <div className={styles['env-report']}>
            <div className={styles['env-report__item']}>
              <span className={styles['env-report__label']}>总体状态</span>
              <span className={envReport?.ok ? styles['status--ok'] : styles['status--error']}>
                {envReport?.ok ? '就绪' : '异常'}
              </span>
            </div>
            <div className={styles['env-report__item']}>
              <span className={styles['env-report__label']}>FFmpeg</span>
              <span className={envReport?.ffmpeg ? styles['status--ok'] : styles['status--error']}>
                {envReport?.ffmpeg ? '已安装' : '未找到'}
              </span>
            </div>
            <div className={styles['env-report__item']}>
              <span className={styles['env-report__label']}>Python</span>
              <span className={envReport?.python ? styles['status--ok'] : styles['status--error']}>
                {envReport?.python ? `已安装 (${envReport.details.pythonVersion})` : '未找到'}
              </span>
            </div>
            <div className={styles['env-report__item']}>
              <span className={styles['env-report__label']}>WhisperX</span>
              <span className={envReport?.whisperx ? styles['status--ok'] : styles['status--error']}>
                {envReport?.whisperx ? '已加载' : '未安装'}
              </span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
