import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

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
  cwd?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
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
  emitProgress(targetJobId, 'transcribe', 45, 'transcribe: whisperx 开始');

  const wavPath = path.join(jobRootPath, 'cache', 'extracted', 'audio.wav');
  const outputDir = path.join(jobRootPath, 'cache', 'transcribe');
  await ensureDir(outputDir);

  const baseName = path.parse(wavPath).name;
  const whisperJsonPath = path.join(outputDir, `${baseName}.json`);

  const args = [
    '-m',
    'whisperx',
    wavPath,
    '--model',
    'small',
    '--output_dir',
    outputDir,
    '--print_progress',
    'False',
    '--verbose',
    'False',
  ];

  const result = await runProcess('python', args);

  if (result.code !== 0) {
    throw new Error(
      `whisperx failed code=${result.code ?? -1} stderr=${result.stderr}`
    );
  }

  const TranscribeWordSchema = z.object({
    text: z.string(),
    start: z.number().nullable().optional(),
    end: z.number().nullable().optional(),
    score: z.number().nullable().optional(),
  });

  const TranscribeSegmentSchema = z.object({
    start: z.number(),
    end: z.number(),
    text: z.string(),
    words: z.array(TranscribeWordSchema).optional(),
  });

  const WhisperxOutputSchema = z.object({
    segments: z.array(TranscribeSegmentSchema),
    language: z.string().optional(),
  });

  let parsed: z.infer<typeof WhisperxOutputSchema>;

  try {
    const content = await fs.readFile(whisperJsonPath, 'utf-8');
    parsed = WhisperxOutputSchema.parse(JSON.parse(content) as unknown);
  } catch (err) {
    throw new Error(
      `whisperx output parse failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const segments: TranscribedSegment[] = parsed.segments.map((item, index) => {
    const words: TranscribedWord[] =
      item.words?.map((word) => ({
        startMs:
          typeof word.start === 'number'
            ? Math.max(Math.round(word.start * 1000), 0)
            : null,
        endMs:
          typeof word.end === 'number'
            ? Math.max(Math.round(word.end * 1000), 0)
            : null,
        text: word.text,
        confidence: word.score ?? null,
      })) ?? [];

    return {
      index,
      startMs: Math.max(Math.round(item.start * 1000), 0),
      endMs: Math.max(Math.round(item.end * 1000), 0),
      text: item.text,
      words,
    };
  });

  const artifactPayload = buildArtifactPayload(targetJobId, 'transcribe', {
    language: parsed.language ?? 'auto',
    modelSize: 'small',
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
      message: 'transcribe done',
      data: {
        artifactPath,
        whisperJsonPath,
      },
    },
  });
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
 * 写一个简单的 SRT 占位文件，便于验证导出链路。
 */
const writePlaceholderSrt = async (
  targetPath: string,
  jobId: string
): Promise<void> => {
  const content = `1
00:00:00,000 --> 00:00:02,000
Stub subtitle for job ${jobId}
`;

  await fs.writeFile(targetPath, content, 'utf-8');
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
  /**
   * 同 jobId 可能被重复 start（例如重试/重复点击），这里直接覆盖并重启。
   */
  stopStubJob(targetJobId);

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
  }

  runningJobs.set(targetJobId, {
    jobId: targetJobId,
    jobRootPath,
  });

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
        await sleep(200);
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
        await sleep(200);
      },
    },
    {
      name: 'merge',
      run: async () => {
        await sleep(200);
      },
    },
    {
      name: 'export',
      run: async () => {
        const srtPath = path.join(jobRootPath, 'exports', 'stub.srt');
        await writePlaceholderSrt(srtPath, targetJobId);
        await sleep(50);
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

    // probe/extract_audio 已写入真实 artifact；其余步骤保持 stub 占位。
    if (currentStep.name !== 'probe' && currentStep.name !== 'extract_audio') {
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
