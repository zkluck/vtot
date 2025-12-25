import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { z } from 'zod';

import type { JobOptions, WorkerControl, WorkerEvent } from '@vtot/shared';
import {
  JobCancelControlSchema,
  JobOptionsSchema,
  JobStartControlSchema,
  WorkerControlSchema,
  WorkerEventSchema,
  WorkerPingControlSchema,
  WorkerShutdownControlSchema,
} from '@vtot/shared';

/**
 * VTOT Worker（骨架）。
 *
 * 用途：
 * - 作为 Desktop(Main) 拉起的 Node 子进程。
 * - 处理最小控制消息：`worker.ping` / `worker.shutdown`。
 * - 在启动后立刻发送 `worker.ready`，用于握手。
 *
 * 注意：
 * - 这里暂不实现真正的 job 执行逻辑（转写/diarize/export）。
 * - 所有跨进程消息必须保持“纯 JSON 可序列化”。
 */

/**
 * Worker 在骨架阶段使用环境变量传入 jobId。
 *
 * 说明：
 * - 后续每个 job 一个 Worker 时，Main 会按 jobId 启动不同 Worker。
 * - 目前仅用于日志/握手关联。
 */
const jobId = process.env.VTOT_JOB_ID ?? 'dev-job';

/**
 * 记录 Worker 启动时间。
 */
const startedAt = Date.now();

/**
 * Job 文件 schema，确保 Worker 读取的 job.json 结构符合预期。
 */
const JobFileSchema = z.object({
  schemaVersion: z.string(),
  jobId: z.string(),
  source: z.object({
    originalPath: z.string(),
    importStrategy: z.string(),
    fingerprint: z
      .object({
        sizeBytes: z.number().nullable().optional(),
        mtimeMs: z.number().nullable().optional(),
      })
      .optional(),
  }),
  options: JobOptionsSchema,
  meta: z.object({
    createdAt: z.number(),
    createdByAppVersion: z.string(),
  }),
});

type JobFile = z.infer<typeof JobFileSchema>;

/**
 * JobRoot 路径工具函数。
 */
const getJobJsonPath = (jobRootPath: string): string => {
  return path.join(jobRootPath, 'job.json');
};

/**
 * 通用的引擎调用辅助函数（遵循文件式协议）。
 */
const runEngineCommand = async (
  targetJobId: string,
  workDir: string,
  command: string,
  payload: Record<string, unknown>,
  stepName: string,
  baseProgress: number
): Promise<any> => {
  const requestPath = path.join(workDir, 'request.json');
  const responsePath = path.join(workDir, 'response.json');

  await ensureDir(workDir);
  await writeJsonAtomic(requestPath, payload);

  const projectRoot = path.resolve(__dirname, '../../../');
  const pythonPath =
    process.platform === 'win32'
      ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, '.venv', 'bin', 'python');

  const scriptPath = path.join(projectRoot, 'engine', `${command}.py`);

  const result = await runProcess(
    pythonPath,
    [scriptPath, workDir],
    undefined,
    {
      onStdout: (line) => {
        // 解析引擎输出的特殊标记
        if (line.includes('[VTOT:STATUS]')) {
          const msg = line.split('[VTOT:STATUS]')[1].trim();
          emitProgress(targetJobId, stepName, baseProgress, msg);
        }
      },
      onStderr: (line) => {
        // whisperX 的进度通常在 stderr
        // 也可以捕获特定的下载信息
        if (line.includes('Downloading')) {
          emitProgress(
            targetJobId,
            stepName,
            baseProgress,
            `下载中: ${line.trim()}`
          );
        }
      },
    },
    { ...process.env, PYTHONIOENCODING: 'utf-8' }
  );

  if (result.code !== 0) {
    throw new Error(
      `Engine ${command} 进程异常退出 (code=${result.code ?? -1}).\nStderr: ${
        result.stderr
      }`
    );
  }

  const responseContent = await fs.readFile(responsePath, 'utf-8');
  const response = JSON.parse(responseContent);

  if (!response.ok) {
    throw new Error(
      `Engine ${command} 返回失败: ${response.error?.message || '未知错误'}`
    );
  }

  return response.result;
};

/**
 * 说话人分离：调用 Python 引擎脚本执行真实计算。
 */
const runDiarizeStep = async (
  targetJobId: string,
  jobRootPath: string
): Promise<void> => {
  emitProgress(targetJobId, 'diarize', 60, 'diarize: 准备');

  const jobFile = await readJobFile(jobRootPath);
  if (!jobFile) {
    throw new Error('job.json 不可读，无法执行 diarize');
  }

  const extractPath = path.join(jobRootPath, 'artifacts', 'extract_audio.json');
  let extracted: ExtractAudioArtifact | null = null;

  try {
    const content = await fs.readFile(extractPath, 'utf-8');
    extracted = JSON.parse(content) as ExtractAudioArtifact;
  } catch (err) {
    console.warn(
      '[worker] failed to read extract_audio artifact for diarize',
      err
    );
  }

  const durationMs =
    extracted?.audio?.durationMs !== undefined &&
    extracted?.audio?.durationMs !== null
      ? extracted.audio.durationMs
      : null;

  const diarizationOptions = jobFile.options.diarization;

  if (!diarizationOptions.enabled) {
    const singleSpeaker: DiarizeSpeaker = {
      speakerId: 'SPEAKER_00',
      displayName: 'Speaker 1',
    };
    const singleTurn: SpeakerTurn = {
      speakerId: singleSpeaker.speakerId,
      startMs: 0,
      endMs: durationMs ?? 0,
      confidence: null,
    };

    const artifactPayload = buildArtifactPayload(targetJobId, 'diarize', {
      speakers: [singleSpeaker],
      turns: [singleTurn],
      note: 'diarization disabled, fallback to single speaker',
    });

    const artifactPath = path.join(jobRootPath, 'artifacts', 'diarize.json');
    await writeJsonAtomic(artifactPath, artifactPayload);

    emitProgress(targetJobId, 'diarize', 71, 'diarize: 完成（disabled）');

    sendEvent({
      type: 'job.log',
      data: {
        jobId: targetJobId,
        ts: Date.now(),
        level: 'info',
        step: 'diarize',
        message: 'diarize skipped (disabled)',
        data: {
          artifactPath,
        },
      },
    });

    return;
  }

  emitProgress(targetJobId, 'diarize', 65, 'diarize: 引擎计算中');

  /**
   * 按照协议，在 JobRoot/engine/diarize 下执行。
   */
  const workDir = path.join(jobRootPath, 'engine', 'diarize');
  const wavPath = path.join(jobRootPath, 'cache', 'extracted', 'audio.wav');

  try {
    const result = await runEngineCommand(targetJobId, workDir, 'diarizer', {
      wavPath,
      diarization: diarizationOptions,
      hfToken: jobFile.options.hfToken,
    }, 'diarize', 65);

    const speakers: DiarizeSpeaker[] = result.speakers;
    const turns: SpeakerTurn[] = result.turns;

    const artifactPayload = buildArtifactPayload(targetJobId, 'diarize', {
      speakers,
      turns,
      note: 'real diarization result',
    });

    const artifactPath = path.join(jobRootPath, 'artifacts', 'diarize.json');
    await writeJsonAtomic(artifactPath, artifactPayload);

    emitProgress(targetJobId, 'diarize', 71, 'diarize: 完成');

    sendEvent({
      type: 'job.log',
      data: {
        jobId: targetJobId,
        ts: Date.now(),
        level: 'info',
        step: 'diarize',
        message: 'diarize done',
        data: {
          artifactPath,
          speakersCount: speakers.length,
        },
      },
    });
  } catch (err) {
    /**
     * 这里捕获引擎错误，由 Worker 统一抛出以标记任务失败。
     */
    console.error('[worker] diarize step failed', err);
    throw err;
  }
};

const formatTimestamp = (valueMs: number, separator: ',' | '.'): string => {
  const clamped = Math.max(valueMs, 0);
  const hours = Math.floor(clamped / 3_600_000)
    .toString()
    .padStart(2, '0');
  const minutes = Math.floor((clamped % 3_600_000) / 60_000)
    .toString()
    .padStart(2, '0');
  const seconds = Math.floor((clamped % 60_000) / 1000)
    .toString()
    .padStart(2, '0');
  const millis = Math.floor(clamped % 1000)
    .toString()
    .padStart(3, '0');
  return `${hours}:${minutes}:${seconds}${separator}${millis}`;
};

const normalizeCues = (rawCues: MergeCue[]): MergeCue[] => {
  return rawCues.map((cue, idx) => {
    return {
      cueId: cue.cueId ?? `cue-${idx.toString().padStart(4, '0')}`,
      index: typeof cue.index === 'number' ? cue.index : idx,
      startMs: cue.startMs,
      endMs: cue.endMs,
      speakerId:
        cue.speakerId !== undefined && cue.speakerId !== null
          ? cue.speakerId
          : null,
      text: cue.text ?? '',
    };
  });
};

const loadSubtitleCues = async (
  jobRootPath: string
): Promise<{ cues: MergeCue[]; speakers: DiarizeSpeaker[] }> => {
  const editedPath = path.join(
    jobRootPath,
    'artifacts',
    'subtitle.edited.json'
  );
  const mergePath = path.join(jobRootPath, 'artifacts', 'merge.json');

  const [edited, merged] = await Promise.all([
    readArtifactJson<EditedSubtitleArtifact>(editedPath),
    readArtifactJson<MergeArtifact>(mergePath),
  ]);

  if (edited?.cues?.length) {
    const cues = normalizeCues(
      edited.cues.map((cue, idx) => ({
        cueId: cue.cueId ?? `cue-${idx.toString().padStart(4, '0')}`,
        index: typeof cue.index === 'number' ? cue.index : idx,
        startMs: cue.startMs,
        endMs: cue.endMs,
        speakerId:
          cue.speakerId !== undefined && cue.speakerId !== null
            ? cue.speakerId
            : null,
        text: cue.text ?? '',
      }))
    );

    return {
      cues,
      speakers: merged?.speakers ?? [],
    };
  }

  return {
    cues: normalizeCues(merged?.cues ?? []),
    speakers: merged?.speakers ?? [],
  };
};

const buildSrtContent = (cues: MergeCue[]): string => {
  const blocks = cues.map((cue, idx) => {
    const start = formatTimestamp(cue.startMs, ',');
    const end = formatTimestamp(cue.endMs, ',');
    return `${idx + 1}\n${start} --> ${end}\n${cue.text}\n`;
  });
  return blocks.join('\n');
};

const buildVttContent = (cues: MergeCue[]): string => {
  const lines = cues.map((cue) => {
    const start = formatTimestamp(cue.startMs, '.');
    const end = formatTimestamp(cue.endMs, '.');
    return `${start} --> ${end}\n${cue.text}\n`;
  });
  return `WEBVTT\n\n${lines.join('\n')}`.trimEnd();
};

const buildTxtContent = (cues: MergeCue[]): string => {
  return cues.map((cue) => cue.text).join('\n');
};

const runExportStep = async (
  targetJobId: string,
  jobRootPath: string
): Promise<void> => {
  emitProgress(targetJobId, 'export', 88, 'export: 准备数据');

  const jobFile = await readJobFile(jobRootPath);

  if (!jobFile) {
    throw new Error('job.json 不可读，无法执行 export');
  }

  const { cues, speakers } = await loadSubtitleCues(jobRootPath);

  if (cues.length === 0) {
    throw new Error('没有可导出的字幕内容');
  }

  const formats = jobFile.options.export.formats ?? ['srt'];
  const speakerStyle = jobFile.options.export.speakerStyle ?? 'none';
  const sourceDir =
    jobFile.source?.originalPath !== undefined
      ? path.dirname(jobFile.source.originalPath)
      : null;
  const exportsDir = sourceDir ?? path.join(jobRootPath, 'exports');
  /**
   * 导出目录默认与原始文件一致，若无法解析则回退到 job 根目录下的 exports。
   */
  await ensureDir(exportsDir);

  const speakerNameMap = new Map<string, string>();

  speakers.forEach((speaker, index) => {
    if (speaker.speakerId) {
      speakerNameMap.set(
        speaker.speakerId,
        speaker.displayName || `Speaker ${index + 1}`
      );
    }
  });

  const cuesWithSpeakerStyle = cues.map((cue) => {
    if (speakerStyle !== 'prefix') {
      return cue;
    }

    const speakerName =
      cue.speakerId && speakerNameMap.get(cue.speakerId)
        ? speakerNameMap.get(cue.speakerId)
        : 'Speaker';

    return {
      ...cue,
      text: `${speakerName}: ${cue.text}`.trim(),
    };
  });

  const exportEntries: Array<{ format: string; filePath: string }> = [];

  emitProgress(targetJobId, 'export', 93, 'export: 写入文件');

  for (const format of formats) {
    let fileName = `subtitles.${format}`;
    let content: string | null = null;

    if (format === 'srt') {
      content = buildSrtContent(cuesWithSpeakerStyle);
    } else if (format === 'vtt') {
      content = buildVttContent(cuesWithSpeakerStyle);
    } else if (format === 'txt') {
      content = buildTxtContent(cuesWithSpeakerStyle);
    } else {
      console.warn(`[worker] 未知导出格式 ${format}，已跳过`);
      continue;
    }

    const filePath = path.join(exportsDir, fileName);
    await fs.writeFile(filePath, content, 'utf-8');
    exportEntries.push({ format, filePath });
  }

  if (exportEntries.length === 0) {
    throw new Error('export: 没有成功生成的文件');
  }

  const artifactPayload = buildArtifactPayload(targetJobId, 'export', {
    speakerStyle,
    exports: exportEntries,
  });

  const artifactPath = path.join(jobRootPath, 'artifacts', 'export.json');
  await writeJsonAtomic(artifactPath, artifactPayload);

  emitProgress(targetJobId, 'export', 97, 'export: 完成');

  sendEvent({
    type: 'job.log',
    data: {
      jobId: targetJobId,
      ts: Date.now(),
      level: 'info',
      step: 'export',
      message: 'export done',
      data: {
        artifactPath,
        exports: exportEntries,
      },
    },
  });
};

/**
 * 合并转写与说话人信息，生成 artifacts/merge.json。
 *
 * 说明：
 * - diarize 若缺失则全部标记为 null speaker。
 * - cueId 使用稳定前缀 + index，方便 UI/导出引用。
 */
const runMergeStep = async (
  targetJobId: string,
  jobRootPath: string
): Promise<void> => {
  emitProgress(targetJobId, 'merge', 74, 'merge: 准备数据');

  const transcribePath = path.join(jobRootPath, 'artifacts', 'transcribe.json');
  const diarizePath = path.join(jobRootPath, 'artifacts', 'diarize.json');

  const transcribeArtifact =
    (await readArtifactJson<TranscribeArtifact>(transcribePath)) ?? undefined;
  const diarizeArtifact =
    (await readArtifactJson<DiarizeArtifact>(diarizePath)) ?? undefined;

  const segments = transcribeArtifact?.segments ?? [];
  const speakers = diarizeArtifact?.speakers ?? [];
  const turns = diarizeArtifact?.turns ?? [];

  const cues: MergeCue[] = segments.map((segment, index) => {
    const cueStart = segment.startMs;
    const cueEnd = segment.endMs;

    const matchedTurn = turns.find(
      (turn) => turn.startMs <= cueStart && turn.endMs >= cueEnd
    );

    return {
      cueId: `cue-${index.toString().padStart(4, '0')}`,
      index,
      startMs: cueStart,
      endMs: cueEnd,
      speakerId: matchedTurn?.speakerId ?? null,
      text: segment.text,
    };
  });

  const artifactPayload = buildArtifactPayload(targetJobId, 'merge', {
    speakers:
      speakers.length > 0
        ? speakers
        : [
            {
              speakerId: 'SPEAKER_00',
              displayName: 'Speaker 1',
            },
          ],
    cues,
  });

  const artifactPath = path.join(jobRootPath, 'artifacts', 'merge.json');
  await writeJsonAtomic(artifactPath, artifactPayload);

  emitProgress(targetJobId, 'merge', 86, 'merge: 完成');

  sendEvent({
    type: 'job.log',
    data: {
      jobId: targetJobId,
      ts: Date.now(),
      level: 'info',
      step: 'merge',
      message: 'merge done',
      data: {
        artifactPath,
        cuesCount: cues.length,
      },
    },
  });
};

const getCancelFlagPath = (jobRootPath: string): string => {
  return path.join(jobRootPath, 'cancel.flag');
};

/**
 * 确保目录存在。
 */
const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

/**
 * 将 ffprobe 返回的 duration 字符串转换为毫秒，失败返回 null。
 */
const parseDurationMs = (duration: string | undefined): number | null => {
  if (!duration) {
    return null;
  }

  const sec = Number.parseFloat(duration);

  if (!Number.isFinite(sec) || Number.isNaN(sec)) {
    return null;
  }

  return Math.max(Math.round(sec * 1000), 0);
};

/**
 * 读取 job.json，解析成结构化数据。
 */
const readJobFile = async (jobRootPath: string): Promise<JobFile | null> => {
  try {
    const content = await fs.readFile(getJobJsonPath(jobRootPath), 'utf-8');
    const parsed = JobFileSchema.safeParse(JSON.parse(content) as unknown);

    if (!parsed.success) {
      console.error('[worker] invalid job.json content', parsed.error);
      return null;
    }

    return parsed.data;
  } catch (err) {
    console.error(
      '[worker] failed to read job.json',
      jobRootPath,
      err instanceof Error ? err.message : err
    );
    return null;
  }
};

/**
 * 读取指定 artifact JSON。
 *
 * 说明：
 * - 当文件缺失或 JSON 无法解析时返回 null，调用方自行决定兜底策略。
 */
const readArtifactJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    console.error('[worker] failed to read artifact json', filePath, err);
    return null;
  }
};

/**
 * 检查 cancel.flag 是否存在。
 */
const hasCancelFlag = async (jobRootPath: string): Promise<boolean> => {
  try {
    await fs.access(getCancelFlagPath(jobRootPath));
    return true;
  } catch {
    return false;
  }
};

/**
 * 发送 WorkerEvent 到 Main。
 *
 * 说明：
 * - `process.send` 只在被 `child_process.fork` 拉起时存在。
 * - 这里统一做一次 zod 校验，防止发送脏数据到主进程。
 */
const sendEvent = (event: WorkerEvent): void => {
  const parsed = WorkerEventSchema.parse(event);

  if (!process.send) {
    /**
     * 若不是通过 fork 启动，说明运行方式不符合我们的约定。
     *
     * 这里使用 exitCode=2（E_INVALID_INPUT）作为兜底。
     */
    // eslint-disable-next-line no-console
    console.error(
      '[worker] process.send is not available. Please start worker via child_process.fork.'
    );
    process.exit(2);
  }

  process.send(parsed);
};

/**
 * Worker 主状态。
 *
 * 说明：
 * - 只用于避免重复处理 shutdown。
 */
let isShuttingDown = false;

/**
 * RunningJob：Worker 内部的 stub 任务运行态。
 *
 * 用途：
 * - 让 `job.start` 能在 Worker 内部模拟进度推进。
 * - 支持 `job.cancel` 中断。
 */
type RunningJob = {
  /** 任务 ID */
  jobId: string;
  /** JobRoot 路径 */
  jobRootPath: string;
};

/**
 * 运行中的任务集合。
 */
const runningJobs = new Map<string, RunningJob>();

/**
 * 停止一个 stub 任务。
 */
const stopStubJob = (targetJobId: string): RunningJob | null => {
  const running = runningJobs.get(targetJobId);

  if (!running) {
    return null;
  }

  runningJobs.delete(targetJobId);
  return running;
};

/**
 * 运行子进程并收集输出。
 */
const runProcess = async (
  command: string,
  args: string[],
  cwd?: string,
  callbacks?: {
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
  },
  env?: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, env });
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      stdout += text;
      if (callbacks?.onStdout) {
        text.split(/\r?\n/).forEach((line) => {
          if (line.trim()) callbacks.onStdout!(line);
        });
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      stderr += text;
      if (callbacks?.onStderr) {
        text.split(/\r?\n/).forEach((line) => {
          if (line.trim()) callbacks.onStderr!(line);
        });
      }
    });

    child.on('close', (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      console.log(`[worker] process ${command} closed with code ${code}`);
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      console.error(`[worker] process ${command} failed to start:`, err);
    });
  });
};

/**
 * 通过 ffprobe 读取 wav 时长，返回毫秒。
 */
const probeAudioDurationMs = async (wavPath: string): Promise<number> => {
  const probeArgs = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    wavPath,
  ];
  const result = await runProcess('ffprobe', probeArgs);

  if (result.code !== 0) {
    throw new Error(
      `ffprobe for segment duration failed code=${result.code ?? -1} stderr=${
        result.stderr
      }`
    );
  }

  type FormatMeta = { format?: { duration?: string } };
  let parsed: FormatMeta = {};

  try {
    parsed = JSON.parse(result.stdout) as FormatMeta;
  } catch (err) {
    throw new Error(
      `ffprobe duration parse error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const durationMs = parseDurationMs(parsed.format?.duration);

  if (durationMs === null) {
    throw new Error('unable to parse wav duration for segment step');
  }

  return durationMs;
};

/**
 * 调用 ffmpeg silencedetect 输出静音区间列表，单位毫秒。
 */
const detectSilenceRanges = async (
  wavPath: string,
  totalDurationMs: number
): Promise<SilenceRange[]> => {
  const args = [
    '-hide_banner',
    '-i',
    wavPath,
    '-af',
    `silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${SILENCE_MIN_DURATION_SECONDS}`,
    '-f',
    'null',
    '-',
  ];

  const result = await runProcess('ffmpeg', args);

  if (result.code !== 0) {
    throw new Error(
      `ffmpeg silencedetect failed code=${result.code ?? -1} stderr=${
        result.stderr
      }`
    );
  }

  const lines = result.stderr.split(/\r?\n/);
  const startRegex = /silence_start:\s*([0-9.]+)/i;
  const endRegex = /silence_end:\s*([0-9.]+)/i;
  let pendingStartMs: number | null = null;
  const ranges: SilenceRange[] = [];

  lines.forEach((line) => {
    const startMatch = line.match(startRegex);
    if (startMatch) {
      const seconds = Number.parseFloat(startMatch[1] ?? '');
      if (Number.isFinite(seconds)) {
        pendingStartMs = Math.max(Math.round(seconds * 1000), 0);
      }
      return;
    }

    const endMatch = line.match(endRegex);
    if (endMatch && pendingStartMs !== null) {
      const seconds = Number.parseFloat(endMatch[1] ?? '');
      if (Number.isFinite(seconds)) {
        const rawEnd = Math.max(Math.round(seconds * 1000), pendingStartMs);
        ranges.push({
          startMs: pendingStartMs,
          endMs: Math.min(rawEnd, totalDurationMs),
        });
      }
      pendingStartMs = null;
    }
  });

  if (pendingStartMs !== null) {
    ranges.push({
      startMs: pendingStartMs,
      endMs: totalDurationMs,
    });
  }

  return ranges.sort((a, b) => a.startMs - b.startMs);
};

/**
 * 将静音区间映射为切片窗口列表，自动满足最短/最长时长的约束。
 */
const buildSegmentWindows = (
  silenceRanges: SilenceRange[],
  durationMs: number
): SegmentWindow[] => {
  if (durationMs <= 0) {
    return [{ startMs: 0, endMs: MIN_SEGMENT_DURATION_MS }];
  }

  const windows: SegmentWindow[] = [];
  let currentStart = 0;

  silenceRanges.forEach((range) => {
    const silenceStart = Math.min(
      Math.max(range.startMs, currentStart),
      durationMs
    );

    while (silenceStart - currentStart > MAX_SEGMENT_DURATION_MS) {
      const forcedEnd = currentStart + MAX_SEGMENT_DURATION_MS;
      windows.push({ startMs: currentStart, endMs: forcedEnd });
      currentStart = forcedEnd;
    }

    if (silenceStart - currentStart >= MIN_SEGMENT_DURATION_MS) {
      windows.push({ startMs: currentStart, endMs: silenceStart });
      currentStart = Math.min(range.endMs, durationMs);
    }
  });

  while (durationMs - currentStart > MAX_SEGMENT_DURATION_MS) {
    const forcedEnd = currentStart + MAX_SEGMENT_DURATION_MS;
    windows.push({ startMs: currentStart, endMs: forcedEnd });
    currentStart = forcedEnd;
  }

  if (durationMs - currentStart > 0) {
    windows.push({ startMs: currentStart, endMs: durationMs });
  }

  if (windows.length === 0) {
    return [{ startMs: 0, endMs: durationMs }];
  }

  const merged: SegmentWindow[] = [];

  windows.forEach((window) => {
    const duration = window.endMs - window.startMs;
    if (duration >= MIN_SEGMENT_DURATION_MS || merged.length === 0) {
      merged.push({ ...window });
    } else {
      merged[merged.length - 1].endMs = window.endMs;
    }
  });

  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    if (last.endMs - last.startMs < MIN_SEGMENT_DURATION_MS) {
      merged[merged.length - 2].endMs = last.endMs;
      merged.pop();
    }
  }

  return merged;
};

/**
 * 将毫秒转换为 ffmpeg 需要的秒数字符串。
 */
const formatSeconds = (valueMs: number): string => {
  return (Math.max(valueMs, 0) / 1000).toFixed(3);
};

/**
 * 裁剪音频并写入单个 segment wav。
 */
const writeSegmentWav = async (
  wavPath: string,
  window: SegmentWindow,
  outputPath: string
): Promise<void> => {
  const duration = window.endMs - window.startMs;
  const args = [
    '-y',
    '-i',
    wavPath,
    '-ss',
    formatSeconds(window.startMs),
    '-t',
    formatSeconds(duration),
    '-c',
    'copy',
    outputPath,
  ];

  const result = await runProcess('ffmpeg', args);

  if (result.code !== 0) {
    throw new Error(
      `ffmpeg segment export failed code=${result.code ?? -1} stderr=${
        result.stderr
      }`
    );
  }
};

/**
 * 静音切片：生成 cache/segments 及 artifacts/segment.json。
 */
const runSegmentStep = async (
  targetJobId: string,
  jobRootPath: string
): Promise<void> => {
  emitProgress(targetJobId, 'segment', 31, 'segment: 静音分析');

  const wavPath = path.join(jobRootPath, 'cache', 'extracted', 'audio.wav');
  const segmentsDir = path.join(jobRootPath, 'cache', 'segments');
  await fs.rm(segmentsDir, { recursive: true, force: true });
  await ensureDir(segmentsDir);

  const durationMs = await probeAudioDurationMs(wavPath);
  const silenceRanges = await detectSilenceRanges(wavPath, durationMs);
  const windows = buildSegmentWindows(silenceRanges, durationMs);

  emitProgress(targetJobId, 'segment', 37, 'segment: 切割音频');

  const segments: SegmentArtifactItem[] = [];

  for (let i = 0; i < windows.length; i += 1) {
    const window = windows[i];
    const fileName = `${i.toString().padStart(4, '0')}.wav`;
    const segmentPath = path.join(segmentsDir, fileName);
    await writeSegmentWav(wavPath, window, segmentPath);
    segments.push({
      index: i,
      startMs: window.startMs,
      endMs: window.endMs,
      segmentWavPath: segmentPath,
    });
  }

  const artifactPayload = buildArtifactPayload(targetJobId, 'segment', {
    wavPath,
    segmentsDir,
    segments,
    silenceRanges,
  });

  const artifactPath = path.join(jobRootPath, 'artifacts', 'segment.json');
  await writeJsonAtomic(artifactPath, artifactPayload);

  emitProgress(targetJobId, 'segment', 43, 'segment: 完成');

  sendEvent({
    type: 'job.log',
    data: {
      jobId: targetJobId,
      ts: Date.now(),
      level: 'info',
      step: 'segment',
      message: 'segment done',
      data: {
        artifactPath,
        segmentsCount: segments.length,
      },
    },
  });
};

/**
 * 发送进度事件，便于减少重复代码。
 */
const emitProgress = (
  targetJobId: string,
  step: string,
  percent: number,
  message: string
): void => {
  sendEvent({
    type: 'job.progress',
    data: {
      jobId: targetJobId,
      status: 'running',
      step,
      percent,
      message,
      ts: Date.now(),
    },
  });
};

/**
 * 运行 ffprobe 获取媒体信息。
 */
const runProbeStep = async (
  targetJobId: string,
  sourceFilePath: string,
  jobRootPath: string
): Promise<void> => {
  emitProgress(targetJobId, 'probe', 5, 'probe: ffprobe 开始');

  const probeArgs = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    sourceFilePath,
  ];

  const result = await runProcess('ffprobe', probeArgs);

  if (result.code !== 0) {
    throw new Error(
      `ffprobe failed code=${result.code ?? -1} stderr=${result.stderr}`
    );
  }

  let parsed: {
    format?: { format_name?: string; duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
    }>;
  } = {};

  try {
    parsed = JSON.parse(result.stdout) as {
      format?: { format_name?: string; duration?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        sample_rate?: string;
        channels?: number;
      }>;
    };
  } catch (err) {
    throw new Error(
      `ffprobe parse error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const durationSec = parsed.format?.duration
    ? Number.parseFloat(parsed.format.duration)
    : null;
  const durationMs = parseDurationMs(
    durationSec !== null ? parsed.format?.duration : undefined
  );

  const audioStream = parsed.streams?.find(
    (item) => item.codec_type === 'audio'
  );

  const artifactPayload = buildArtifactPayload(targetJobId, 'probe', {
    sourcePath: sourceFilePath,
    format: {
      container: parsed.format?.format_name ?? 'unknown',
      durationMs: durationMs ?? null,
    },
    audio: {
      hasAudio: Boolean(audioStream),
      codec: audioStream?.codec_name ?? null,
      sampleRate: audioStream?.sample_rate
        ? Number.parseInt(audioStream.sample_rate, 10)
        : null,
      channels: audioStream?.channels ?? null,
    },
  });

  const artifactPath = path.join(jobRootPath, 'artifacts', 'probe.json');
  await writeJsonAtomic(artifactPath, artifactPayload);

  emitProgress(targetJobId, 'probe', 15, 'probe: 完成');

  sendEvent({
    type: 'job.log',
    data: {
      jobId: targetJobId,
      ts: Date.now(),
      level: 'info',
      step: 'probe',
      message: 'probe done',
      data: {
        artifactPath,
      },
    },
  });
};

/**
 * 抽取音频并统一为 mono + 16kHz wav。
 */
const runExtractAudioStep = async (
  targetJobId: string,
  sourceFilePath: string,
  jobRootPath: string
): Promise<void> => {
  emitProgress(targetJobId, 'extract_audio', 20, 'extract_audio: ffmpeg 开始');

  const outputDir = path.join(jobRootPath, 'cache', 'extracted');
  await ensureDir(outputDir);
  const outputPath = path.join(outputDir, 'audio.wav');

  const args = [
    '-y',
    '-i',
    sourceFilePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    outputPath,
  ];

  const result = await runProcess('ffmpeg', args);

  if (result.code !== 0) {
    throw new Error(
      `ffmpeg extract failed code=${result.code ?? -1} stderr=${result.stderr}`
    );
  }

  // 对生成的 wav 再做一次 ffprobe 以便写入采样率/时长。
  const probeArgs = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    outputPath,
  ];
  const probeResult = await runProcess('ffprobe', probeArgs);

  if (probeResult.code !== 0) {
    throw new Error(
      `ffprobe on extracted audio failed code=${
        probeResult.code ?? -1
      } stderr=${probeResult.stderr}`
    );
  }

  let parsed: {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      sample_rate?: string;
      channels?: number;
    }>;
  } = {};

  try {
    parsed = JSON.parse(probeResult.stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        sample_rate?: string;
        channels?: number;
      }>;
    };
  } catch (err) {
    throw new Error(
      `ffprobe parse on extracted audio failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const durationMs = parseDurationMs(parsed.format?.duration);

  const audioStream = parsed.streams?.find(
    (item) => item.codec_type === 'audio'
  );

  const artifactPayload = buildArtifactPayload(targetJobId, 'extract_audio', {
    inputPath: sourceFilePath,
    outputWavPath: outputPath,
    audio: {
      sampleRate: audioStream?.sample_rate
        ? Number.parseInt(audioStream.sample_rate, 10)
        : null,
      channels: audioStream?.channels ?? null,
      durationMs: durationMs ?? null,
    },
  });

  const artifactPath = path.join(
    jobRootPath,
    'artifacts',
    'extract_audio.json'
  );
  await writeJsonAtomic(artifactPath, artifactPayload);

  emitProgress(targetJobId, 'extract_audio', 35, 'extract_audio: 完成');

  sendEvent({
    type: 'job.log',
    data: {
      jobId: targetJobId,
      ts: Date.now(),
      level: 'info',
      step: 'extract_audio',
      message: 'extract_audio done',
      data: {
        artifactPath,
        outputPath,
      },
    },
  });
};

type TranscribedWord = {
  startMs: number | null;
  endMs: number | null;
  text: string;
  confidence: number | null;
};

type TranscribedSegment = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  words: TranscribedWord[];
};

type SegmentWindow = {
  startMs: number;
  endMs: number;
};

type SilenceRange = {
  startMs: number;
  endMs: number;
};

type SegmentArtifactItem = SegmentWindow & {
  index: number;
  segmentWavPath: string;
};

type DiarizeSpeaker = {
  speakerId: string;
  displayName: string;
};

type SpeakerTurn = {
  speakerId: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
};

type TranscribeArtifact = {
  segments?: TranscribedSegment[];
};

type ExtractAudioArtifact = {
  audio?: {
    durationMs?: number | null;
  };
};

type DiarizeArtifact = {
  speakers?: DiarizeSpeaker[];
  turns?: SpeakerTurn[];
};

type MergeCue = {
  cueId: string;
  index: number;
  startMs: number;
  endMs: number;
  speakerId: string | null;
  text: string;
};

type MergeArtifact = {
  speakers?: DiarizeSpeaker[];
  cues?: MergeCue[];
};

type EditedSubtitleCue = {
  cueId?: string;
  index?: number;
  startMs: number;
  endMs: number;
  speakerId?: string | null;
  text: string;
};

type EditedSubtitleArtifact = {
  cues?: EditedSubtitleCue[];
};

const MIN_SEGMENT_DURATION_MS = 5000;
const MAX_SEGMENT_DURATION_MS = 45000;
const SILENCE_THRESHOLD_DB = -35;
const SILENCE_MIN_DURATION_SECONDS = 0.4;

/**
 * 调用 whisperx 转写并生成 artifacts/transcribe.json。
 *
 * 说明：
 * - 使用 python -m whisperx，默认模型 small，语言自动检测（不传 --language）。
 * - whisperx 输出的 JSON 命名为 <basename>.json，位于输出目录。
 * - 转写结果写入 artifacts/transcribe.json，包含段落与词级时间戳。
 */
const runTranscribeStep = async (
  targetJobId: string,
  jobRootPath: string
): Promise<void> => {
  emitProgress(targetJobId, 'transcribe', 45, 'transcribe: 引擎计算中');

  const wavPath = path.join(jobRootPath, 'cache', 'extracted', 'audio.wav');
  const jobFile = await readJobFile(jobRootPath);

  if (!jobFile) {
    throw new Error('job.json 不可读，无法执行 transcribe');
  }

  const workDir = path.join(jobRootPath, 'engine', 'transcribe');

  try {
    const result = await runEngineCommand(targetJobId, workDir, 'transcriber', {
      wavPath,
      options: {
        language: jobFile.options.language,
        modelSize: jobFile.options.modelSize,
      },
      hfToken: jobFile.options.hfToken,
    }, 'transcribe', 45);

    const segments: TranscribedSegment[] = result.segments.map(
      (item: any, index: number) => {
        const words: TranscribedWord[] = (item.words ?? []).map((word: any) => ({
          startMs:
            typeof word.start === 'number'
              ? Math.max(Math.round(word.start * 1000), 0)
              : null,
          endMs:
            typeof word.end === 'number'
              ? Math.max(Math.round(word.end * 1000), 0)
              : null,
          text: word.word ?? word.text, // whisperx python API 结果可能是 word
          confidence: word.score ?? word.probability ?? null,
        }));

        return {
          index,
          startMs: Math.max(Math.round(item.start * 1000), 0),
          endMs: Math.max(Math.round(item.end * 1000), 0),
          text: item.text,
          words,
        };
      }
    );

    const artifactPayload = buildArtifactPayload(targetJobId, 'transcribe', {
      language: result.language,
      modelSize: jobFile.options.modelSize,
      enableWordTimestamps: true,
      segments,
    });

    const artifactPath = path.join(jobRootPath, 'artifacts', 'transcribe.json');
    await writeJsonAtomic(artifactPath, artifactPayload);

    emitProgress(targetJobId, 'transcribe', 70, 'transcribe: 完成');

    sendEvent({
      type: 'job.log',
      data: {
        jobId: targetJobId,
        ts: Date.now(),
        level: 'info',
        step: 'transcribe',
        message: 'transcribe done via engine',
        data: {
          artifactPath,
          segmentsCount: segments.length,
        },
      },
    });
  } catch (err) {
    console.error('[worker] transcribe step failed', err);
    throw err;
  }
};



/**
 * 延迟工具，用于模拟耗时步骤。
 */
const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * 原子写入 JSON：先写临时文件，再 rename。
 */
const writeJsonAtomic = async (
  targetPath: string,
  payload: unknown
): Promise<void> => {
  const tempPath = `${targetPath}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(payload, null, 2)}\n`;

  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, targetPath);
};

/**
 * 生成每个 step 的占位 artifacts 数据。
 */
const buildArtifactPayload = (
  jobId: string,
  step: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => {
  return {
    schemaVersion: '1.0',
    jobId,
    step,
    meta: { createdAt: Date.now(), attempt: 1 },
    ...extra,
  };
};

/**
 * 将完成的步骤写入 manifest，便于后续调试。
 */
const writeManifest = async (
  jobRootPath: string,
  finishedSteps: string[]
): Promise<void> => {
  const manifestPath = path.join(jobRootPath, 'artifacts', 'manifest.json');
  await writeJsonAtomic(manifestPath, {
    schemaVersion: '1.0',
    jobId,
    steps: finishedSteps,
    meta: { updatedAt: Date.now() },
  });
};

/**
 * 启动一个 stub 任务。
 *
 * 说明：
 * - MVP 阶段先不执行真实 pipeline（ffmpeg/whisper 等），只模拟进度，便于 UI/调度联调。
 */
const startStubJob = async (
  targetJobId: string,
  sourceFilePath: string,
  jobRootPath: string
): Promise<void> => {
  try {
    /**
     * 同 jobId 可能被重复 start（例如重试/重复点击），这里直接覆盖并重启。
     */
    stopStubJob(targetJobId);

    console.log(`[worker] [${targetJobId}] startStubJob entry`);

  const jobFile = await readJobFile(jobRootPath);

  sendEvent({
    type: 'job.status',
    data: {
      jobId: targetJobId,
      status: 'running',
      step: 'stub',
      ts: Date.now(),
    },
  });

  sendEvent({
    type: 'job.log',
    data: {
      jobId: targetJobId,
      ts: Date.now(),
      level: 'info',
      step: 'stub',
      message: 'job started (stub)',
      data: {
        sourceFilePath,
        jobRootPath,
      },
    },
  });

    console.log(`[worker] starting stub job: ${targetJobId} for ${sourceFilePath}`);
    sendEvent({
      type: 'job.log',
      data: {
        jobId: targetJobId,
        ts: Date.now(),
        level: 'info',
        step: 'stub',
        message: 'Worker beginning pipeline execution...',
      },
    });

  if (jobFile) {
    sendEvent({
      type: 'job.log',
      data: {
        jobId: targetJobId,
        ts: Date.now(),
        level: 'debug',
        step: 'stub',
        message: 'job.json loaded',
        data: {
          schemaVersion: jobFile.schemaVersion,
          importStrategy: jobFile.source.importStrategy,
        },
      },
    });
  } else {
    console.warn(`[worker] [${targetJobId}] job.json not found or invalid`);
  }

  runningJobs.set(targetJobId, {
    jobId: targetJobId,
    jobRootPath,
  });

  console.log(`[worker] [${targetJobId}] pipeline starting...`);

  /**
   * pipeline：probe/extract_audio 使用真实 ffprobe/ffmpeg，其余步骤仍为 stub。
   *
   * 说明：
   * - 每个 step 结束写对应 JSON。
   * - 取消时检测 cancel.flag，立刻停止并发出 canceled 状态。
   */
  const steps: Array<{
    name:
      | 'probe'
      | 'extract_audio'
      | 'segment'
      | 'transcribe'
      | 'diarize'
      | 'merge'
      | 'export';
    run: () => Promise<void>;
  }> = [
    {
      name: 'probe',
      run: async () => {
        await runProbeStep(targetJobId, sourceFilePath, jobRootPath);
      },
    },
    {
      name: 'extract_audio',
      run: async () => {
        await runExtractAudioStep(targetJobId, sourceFilePath, jobRootPath);
      },
    },
    {
      name: 'segment',
      run: async () => {
        await runSegmentStep(targetJobId, jobRootPath);
      },
    },
    {
      name: 'transcribe',
      run: async () => {
        await runTranscribeStep(targetJobId, jobRootPath);
      },
    },
    {
      name: 'diarize',
      run: async () => {
        await runDiarizeStep(targetJobId, jobRootPath);
      },
    },
    {
      name: 'merge',
      run: async () => {
        await runMergeStep(targetJobId, jobRootPath);
      },
    },
    {
      name: 'export',
      run: async () => {
        await runExportStep(targetJobId, jobRootPath);
      },
    },
  ];

  const finishedSteps: string[] = [];

  for (let i = 0; i < steps.length; i += 1) {
    const currentStep = steps[i];

    if (!runningJobs.has(targetJobId)) {
      break;
    }

    if (await hasCancelFlag(jobRootPath)) {
      stopStubJob(targetJobId);

      sendEvent({
        type: 'job.status',
        data: {
          jobId: targetJobId,
          status: 'canceled',
          step: currentStep.name,
          ts: Date.now(),
        },
      });

      sendEvent({
        type: 'job.log',
        data: {
          jobId: targetJobId,
          ts: Date.now(),
          level: 'warn',
          step: currentStep.name,
          message: 'job canceled via cancel.flag',
        },
      });

      break;
    }

    emitProgress(
      targetJobId,
      currentStep.name,
      Math.min(99, Math.round(((i + 0.2) / steps.length) * 100)),
      `step ${currentStep.name}...`
    );

    sendEvent({
      type: 'job.log',
      data: {
        jobId: targetJobId,
        ts: Date.now(),
        level: 'debug',
        step: currentStep.name,
        message: `step start: ${currentStep.name}`,
      },
    });

    await currentStep.run();

    const artifactPath = path.join(
      jobRootPath,
      'artifacts',
      `${currentStep.name}.json`
    );

    const realArtifactSteps = new Set([
      'probe',
      'extract_audio',
      'segment',
      'transcribe',
      'diarize',
      'merge',
      'export',
    ]);

    if (!realArtifactSteps.has(currentStep.name)) {
      await writeJsonAtomic(
        artifactPath,
        buildArtifactPayload(targetJobId, currentStep.name, {
          note: 'stub artifact',
        })
      );
    }

    finishedSteps.push(currentStep.name);
    await writeManifest(jobRootPath, finishedSteps);

    sendEvent({
      type: 'job.log',
      data: {
        jobId: targetJobId,
        ts: Date.now(),
        level: 'info',
        step: currentStep.name,
        message: `step done: ${currentStep.name}`,
        data: {
          artifactPath,
        },
      },
    });

    const percentAfterStep = Math.round(((i + 1) / steps.length) * 100);
    sendEvent({
      type: 'job.progress',
      data: {
        jobId: targetJobId,
        status: 'running',
        step: currentStep.name,
        percent: percentAfterStep,
        message: `step ${currentStep.name} completed`,
        ts: Date.now(),
      },
    });
  }

  if (!runningJobs.has(targetJobId)) {
    return;
  }

  stopStubJob(targetJobId);

  sendEvent({
    type: 'job.status',
    data: {
      jobId: targetJobId,
      status: 'succeeded',
      step: 'export',
      ts: Date.now(),
    },
  });

  sendEvent({
    type: 'job.log',
    data: {
      jobId: targetJobId,
      ts: Date.now(),
      level: 'info',
      step: 'export',
      message: 'job succeeded (stub pipeline)',
    },
  });

  console.log(`[worker] [${targetJobId}] job succeeded`);
  } catch (err) {
    console.error(`[worker] [${targetJobId}] fatal error in startStubJob:`, err);
    sendEvent({
      type: 'job.status',
      data: {
        jobId: targetJobId,
        status: 'failed',
        step: 'stub',
        ts: Date.now(),
        error: {
          code: 'E_WORKER_ERROR',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      },
    });
    sendEvent({
      type: 'job.log',
      data: {
        jobId: targetJobId,
        ts: Date.now(),
        level: 'error',
        step: 'stub',
        message: `fatal error: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }
};

/**
 * 处理来自 Main 的控制消息。
 */
const handleControl = (control: WorkerControl): void => {
  if (control.type === 'worker.ping') {
    const parsed = WorkerPingControlSchema.parse(control.data);

    sendEvent({
      type: 'worker.pong',
      data: {
        jobId: parsed.jobId,
        pid: process.pid,
        nonce: parsed.nonce,
        ts: Date.now(),
        message: `pong from worker @ ${new Date().toISOString()}`,
      },
    });

    return;
  }

  if (control.type === 'job.start') {
    const parsed = JobStartControlSchema.parse(control.data);

    void startStubJob(
      parsed.jobId,
      parsed.sourceFilePath,
      parsed.jobRootPath
    ).catch((err: unknown) => {
      console.error('[worker] failed to start stub job', err);

      sendEvent({
        type: 'job.status',
        data: {
          jobId: parsed.jobId,
          status: 'failed',
          step: 'stub',
          ts: Date.now(),
        },
      });

      sendEvent({
        type: 'job.log',
        data: {
          jobId: parsed.jobId,
          ts: Date.now(),
          level: 'error',
          step: 'stub',
          message: 'job start failed',
          data: {
            reason: err instanceof Error ? err.message : String(err),
          },
        },
      });
    });
    return;
  }

  if (control.type === 'job.cancel') {
    const parsed = JobCancelControlSchema.parse(control.data);

    const stoppedJob = stopStubJob(parsed.jobId);

    if (!stoppedJob) {
      sendEvent({
        type: 'job.log',
        data: {
          jobId: parsed.jobId,
          ts: Date.now(),
          level: 'debug',
          step: 'stub',
          message: 'job cancel ignored (not running)',
        },
      });

      return;
    }

    sendEvent({
      type: 'job.status',
      data: {
        jobId: parsed.jobId,
        status: 'canceled',
        step: 'stub',
        ts: Date.now(),
      },
    });

    sendEvent({
      type: 'job.log',
      data: {
        jobId: parsed.jobId,
        ts: Date.now(),
        level: 'warn',
        step: 'stub',
        message: 'job canceled (stub)',
      },
    });

    return;
  }

  if (control.type === 'worker.shutdown') {
    const parsed = WorkerShutdownControlSchema.parse(control.data);

    /**
     * 防止重复 shutdown。
     */
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;

    /**
     * 清理所有定时器，避免 Worker 在退出前被 event loop 持有。
     */
    runningJobs.clear();

    sendEvent({
      type: 'worker.shutdown.ack',
      data: {
        jobId: parsed.jobId,
        pid: process.pid,
        ts: Date.now(),
      },
    });

    /**
     * 给 IPC 消息一个 flush 的窗口，然后退出。
     */
    setTimeout(() => {
      process.exit(0);
    }, 20);

    return;
  }

  /**
   * 理论上这里不会走到，因为 zod union 已经约束了 type。
   */
  // eslint-disable-next-line no-console
  console.warn('[worker] unknown control type');
};

/**
 * 订阅主进程消息。
 *
 * 注意：
 * - Node 的类型定义里 message 事件参数是 `any`，这里用 `unknown` 接住并在 zod 里校验。
 */
process.on('message', ((rawMessage: unknown) => {
  const parsed = WorkerControlSchema.safeParse(rawMessage);

  if (!parsed.success) {
    /**
     * Main 侧发送了不符合约定的 payload：
     * - 这里不直接崩溃，避免影响主进程退出流程。
     */
    // eslint-disable-next-line no-console
    console.error('[worker] invalid control message', parsed.error);
    return;
  }

  handleControl(parsed.data);
}) as (message: unknown, sendHandle: unknown) => void);

/**
 * Worker 启动完成，发送 ready 握手事件。
 */
sendEvent({
  type: 'worker.ready',
  data: {
    jobId,
    pid: process.pid,
    startedAt,
  },
});

/**
 * 若主进程断开 IPC 通道，Worker 也应该退出，避免孤儿进程。
 */
process.on('disconnect', () => {
  process.exit(0);
});
