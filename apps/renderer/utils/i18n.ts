/**
 * i18n.ts: 负责将内部标识符翻译为用户可见的中文文本。
 */

const STEP_TRANSLATIONS: Record<string, string> = {
  stub: '准备中',
  probe: '媒体探测',
  extract_audio: '音频提取',
  segment: '语音切分',
  transcribe: '语音转写',
  diarize: '说话人识别',
  merge: '结果合并',
  export: '字幕导出',
  queue: '排队中',
};

const STATUS_TRANSLATIONS: Record<string, string> = {
  queued: '排队中',
  running: '正在运行',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
};

/**
 * 翻译任务步骤名称。
 */
export function translateStep(step: string | undefined): string {
  if (!step) return '';
  return STEP_TRANSLATIONS[step] || step;
}

/**
 * 翻译任务状态名称。
 */
export function translateStatus(status: string | undefined): string {
  if (!status) return '';
  const lowerStatus = status.toLowerCase();
  return STATUS_TRANSLATIONS[lowerStatus] || status;
}
