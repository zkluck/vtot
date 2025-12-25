import { z } from 'zod';

/**
 * shared 包：放所有“跨进程/跨模块共享”的纯数据类型与 zod schema。
 *
 * 设计目的：
 * 1) Renderer/Main/Worker 之间传输的 JSON 必须能被运行时校验（zod）。
 * 2) 类型与 schema 同源，减少“类型对了但 JSON 错了”的线上问题。
 *
 * 注意：
 * - 这里不要引入 Node/Electron/React 相关 API，保持纯数据与纯函数。
 */

/**
 * AppErrorCode：应用内统一错误码枚举。
 *
 * 说明：这里的集合与《VTOT-架构与协议规格.md》第 7 章保持一致。
 */
export const AppErrorCodeSchema = z.enum([
  'E_INVALID_INPUT',
  'E_PERMISSION_DENIED',
  'E_FFMPEG_FAILED',
  'E_ENVIRONMENT_ERROR',
  'E_ENGINE_NOT_FOUND',
  'E_ENGINE_START_FAILED',
  'E_ENGINE_RUNTIME_ERROR',
  'E_MODEL_DOWNLOAD_REQUIRED',
  'E_HF_TOKEN_REQUIRED',
  'E_HF_TOKEN_INVALID',
  'E_SCHEMA_INCOMPATIBLE',
  'E_PROTOCOL_INCOMPATIBLE',
  'E_WORKER_START_FAILED',
  'E_WORKER_CRASHED',
  'E_WORKER_TIMEOUT',
  'E_WORKER_ERROR',
  'E_USER_CANCELED',
]);

export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;

/**
 * AppError：跨进程可序列化的错误结构。
 *
 * - `message`：面向用户的短句。
 * - `detail`：仅用于排障；必须脱敏+截断。
 */
export const AppErrorSchema = z.object({
  code: AppErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  step: z.string().optional(),
  detail: z.record(z.unknown()).optional(),
});

export type AppError = z.infer<typeof AppErrorSchema>;

/**
 * IpcInvokeResult：统一的 invoke 返回结构。
 *
 * 说明：
 * - ok=true：业务成功，data 为业务数据。
 * - ok=false：业务失败，error 为结构化错误。
 */
export type IpcInvokeResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: AppError;
    };

/**
 * createIpcInvokeResultSchema：为特定 dataSchema 生成对应的运行时校验 schema。
 *
 * 目的：让 Main/Renderer/Worker 在边界上能用同一个 schema 做 parse。
 */
export const createIpcInvokeResultSchema = <T>(dataSchema: z.ZodType<T>) =>
  z.union([
    z.object({ ok: z.literal(true), data: dataSchema }),
    z.object({ ok: z.literal(false), error: AppErrorSchema }),
  ]);

/**
 * ExportFormat / SpeakerStyle：导出相关枚举。
 */
export const ExportFormatSchema = z.enum(['srt', 'vtt', 'txt']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const SpeakerStyleSchema = z.enum(['none', 'prefix']);
export type SpeakerStyle = z.infer<typeof SpeakerStyleSchema>;

/**
 * SourceImportStrategy：源文件导入策略。
 *
 * 用途：
 * - Renderer 在 `job.create` 时选择策略。
 * - Main 会把该策略写入 job.json，并据此决定是引用/复制/缓存源文件。
 */
export const SourceImportStrategySchema = z.enum([
  'reference',
  'copy',
  'cache',
]);
export type SourceImportStrategy = z.infer<typeof SourceImportStrategySchema>;

/**
 * JobOptions：任务创建时的可配置选项（会被写入 job.json.options）。
 *
 * 说明：
 * - 这里先实现 MVP 所需字段,后续可以按协议文档继续扩展。
 */
export const JobOptionsSchema = z.object({
  /** 语言：'auto' 表示自动检测 */
  language: z.string(),
  /** Whisper 模型规格 */
  modelSize: z.enum(['tiny', 'base', 'small', 'medium', 'large', 'large-v2', 'large-v3']).default('medium'),
  /** Hugging Face Access Token */
  hfToken: z.string().optional(),
  /** 说话人分离配置 */
  diarization: z.object({
    enabled: z.boolean(),
    minSpeakers: z.number().int().min(1).optional(),
    maxSpeakers: z.number().int().min(1).optional(),
  }),
  /** 导出配置 */
  export: z.object({
    formats: z.array(ExportFormatSchema).min(1),
    speakerStyle: SpeakerStyleSchema,
  }),
});

export type JobOptions = z.infer<typeof JobOptionsSchema>;


/**
 * JobStatus：任务最小状态集合（与 DB `jobs.status` 对齐）。
 */
export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

/**
 * PersistedJob：由 Main 进程维护的持久化任务结构。
 *
 * 说明：
 * - 它是 job.json 的完整定义。
 * - 同时也是 SQLite `jobs` 表主要字段所在的记录。
 */
export const PersistedJobSchema = z.object({
  schemaVersion: z.literal('1.0'),
  jobId: z.string(),
  source: z.object({
    originalPath: z.string(),
    importStrategy: SourceImportStrategySchema,
    fingerprint: z
      .object({
        sizeBytes: z.number().nullable().optional(),
        mtimeMs: z.number().nullable().optional(),
      })
      .optional(),
  }),
  options: JobOptionsSchema,
  status: JobStatusSchema,
  step: z.string().optional(),
  error: AppErrorSchema.optional(),
  meta: z.object({
    createdAt: z.number(),
    updatedAt: z.number(),
    createdByAppVersion: z.string(),
  }),
});

export type PersistedJob = z.infer<typeof PersistedJobSchema>;

/**
 * JobCreateRequest：Renderer -> Main invoke 入参。
 *
 * 用途：
 * - Main 接收到后负责创建 JobRoot、落盘 job.json，并调度 Worker 执行。
 */
export const JobCreateRequestSchema = z.object({
  sourceFilePath: z.string(),
  importStrategy: SourceImportStrategySchema.optional(),
  options: JobOptionsSchema,
});

export type JobCreateRequest = z.infer<typeof JobCreateRequestSchema>;

/**
 * JobCreateResponse：Renderer -> Main invoke 返回 data。
 */
export const JobCreateResponseSchema = z.object({
  jobId: z.string(),
});

export type JobCreateResponse = z.infer<typeof JobCreateResponseSchema>;

/**
 * JobCancelRequest：Renderer -> Main invoke 入参。
 */
export const JobCancelRequestSchema = z.object({
  jobId: z.string(),
});

export type JobCancelRequest = z.infer<typeof JobCancelRequestSchema>;

/**
 * JobCancelResponse：Renderer -> Main invoke 返回 data。
 */
export const JobCancelResponseSchema = z.object({
  jobId: z.string(),
});

export type JobCancelResponse = z.infer<typeof JobCancelResponseSchema>;

/**
 * PingResponse：最小联通性测试数据结构（用于基础框架阶段）。
 */
export const PingResponseSchema = z.object({
  message: z.string(),
});

export type PingResponse = z.infer<typeof PingResponseSchema>;

/**
 * JobProgressEvent：Worker -> Main（也会被 Main 转发到 Renderer）。
 */
export const JobProgressEventSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  step: z.string(),
  percent: z.number().min(0).max(100),
  segmentIndex: z.number().int().min(0).optional(),
  segmentTotal: z.number().int().min(0).optional(),
  message: z.string(),
  ts: z.number(),
});

export type JobProgressEvent = z.infer<typeof JobProgressEventSchema>;

/**
 * JobLogLevel / JobLogEvent：Worker 运行过程的结构化日志。
 */
export const JobLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type JobLogLevel = z.infer<typeof JobLogLevelSchema>;

export const JobLogEventSchema = z.object({
  jobId: z.string(),
  ts: z.number(),
  level: JobLogLevelSchema,
  step: z.string().optional(),
  message: z.string(),
  data: z.record(z.unknown()).optional(),
});

export type JobLogEvent = z.infer<typeof JobLogEventSchema>;

/**
 * JobStatusEvent：任务状态变化事件。
 */
export const JobStatusEventSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  step: z.string().optional(),
  ts: z.number(),
  error: AppErrorSchema.optional(),
});

export type JobStatusEvent = z.infer<typeof JobStatusEventSchema>;

/**
 * JobEvent：Main -> Renderer 事件集合。
 *
 * 说明：
 * - 这些事件的 shape 与 Worker -> Main 的 job.* 事件一致，便于 Main 直接转发。
 */
export const JobEventSchema = z.union([
  z.object({ type: z.literal('job.progress'), data: JobProgressEventSchema }),
  z.object({ type: z.literal('job.log'), data: JobLogEventSchema }),
  z.object({ type: z.literal('job.status'), data: JobStatusEventSchema }),
]);

export type JobEvent = z.infer<typeof JobEventSchema>;

/**
 * WorkerReadyEvent：Worker 启动完成事件。
 *
 * 用途：
 * - Main 通过该事件确认 Worker 已就绪，可以接收控制消息。
 * - MVP 阶段先用作“骨架握手”，后续可以扩展更多字段（例如版本信息）。
 */
export const WorkerReadyEventSchema = z.object({
  /** 任务 ID（后续每个 job 一个 Worker；骨架阶段可以用固定值） */
  jobId: z.string(),
  /** Worker 进程 PID */
  pid: z.number(),
  /** 启动时间（ms） */
  startedAt: z.number(),
});

export type WorkerReadyEvent = z.infer<typeof WorkerReadyEventSchema>;

/**
 * WorkerPongEvent：Worker 对 ping 的响应。
 *
 * 用途：
 * - 让 Main 能做最小探活（确认 IPC 通道可用）。
 */
export const WorkerPongEventSchema = z.object({
  /** 任务 ID */
  jobId: z.string(),
  /** Worker 进程 PID */
  pid: z.number(),
  /** ping 请求携带的 nonce，用于 Main 匹配请求/响应 */
  nonce: z.string(),
  /** 响应时间（ms） */
  ts: z.number(),
  /** 面向开发者的简短信息 */
  message: z.string(),
});

export type WorkerPongEvent = z.infer<typeof WorkerPongEventSchema>;

/**
 * WorkerShutdownAckEvent：Worker 收到 shutdown 后的确认事件。
 *
 * 用途：
 * - 让 Main 能在退出前确认 Worker 已进入退出流程。
 */
export const WorkerShutdownAckEventSchema = z.object({
  /** 任务 ID */
  jobId: z.string(),
  /** Worker 进程 PID */
  pid: z.number(),
  /** ack 时间（ms） */
  ts: z.number(),
});

export type WorkerShutdownAckEvent = z.infer<
  typeof WorkerShutdownAckEventSchema
>;

/**
 * WorkerEvent：Worker -> Main 事件集合（MVP 最小）。
 *
 * 注意：
 * - 事件 payload 必须是可序列化 JSON（不能包含函数/Buffer 等）。
 */
export const WorkerEventSchema = z.union([
  z.object({ type: z.literal('worker.ready'), data: WorkerReadyEventSchema }),
  z.object({ type: z.literal('worker.pong'), data: WorkerPongEventSchema }),
  z.object({
    type: z.literal('worker.shutdown.ack'),
    data: WorkerShutdownAckEventSchema,
  }),
  JobEventSchema,
]);

export type WorkerEvent = z.infer<typeof WorkerEventSchema>;

/**
 * WorkerPingControl：Main -> Worker ping 消息。
 */
export const WorkerPingControlSchema = z.object({
  /** 任务 ID */
  jobId: z.string(),
  /** 请求 nonce，用于匹配响应 */
  nonce: z.string(),
  /** 请求时间（ms） */
  ts: z.number(),
});

export type WorkerPingControl = z.infer<typeof WorkerPingControlSchema>;

/**
 * WorkerShutdownControl：Main -> Worker shutdown 消息。
 */
export const WorkerShutdownControlSchema = z.object({
  /** 任务 ID */
  jobId: z.string(),
  /** 请求时间（ms） */
  ts: z.number(),
});

export type WorkerShutdownControl = z.infer<typeof WorkerShutdownControlSchema>;

/**
 * JobStartControl：Main -> Worker 的开始执行指令（骨架阶段用于跑 stub 进度）。
 */
export const JobStartControlSchema = z.object({
  jobId: z.string(),
  sourceFilePath: z.string(),
  jobRootPath: z.string(),
  options: JobOptionsSchema.optional(),
  ts: z.number(),
});

export type JobStartControl = z.infer<typeof JobStartControlSchema>;

/**
 * JobCancelControl：Main -> Worker 的取消指令。
 */
export const JobCancelControlSchema = z.object({
  jobId: z.string(),
  ts: z.number(),
});

export type JobCancelControl = z.infer<typeof JobCancelControlSchema>;

/**
 * WorkerControl：Main -> Worker 控制消息集合（MVP 最小）。
 */
export const WorkerControlSchema = z.union([
  z.object({ type: z.literal('worker.ping'), data: WorkerPingControlSchema }),
  z.object({
    type: z.literal('worker.shutdown'),
    data: WorkerShutdownControlSchema,
  }),
  z.object({ type: z.literal('job.start'), data: JobStartControlSchema }),
  z.object({ type: z.literal('job.cancel'), data: JobCancelControlSchema }),
]);

export type WorkerControl = z.infer<typeof WorkerControlSchema>;

/**
 * EnvCheckResult：环境自检结果。
 */
export const EnvCheckResultSchema = z.object({
  ok: z.boolean(),
  ffmpeg: z.boolean(),
  ffprobe: z.boolean(),
  python: z.boolean(),
  whisperx: z.boolean(),
  details: z.object({
    ffmpegVersion: z.string().optional(),
    pythonVersion: z.string().optional(),
    error: z.string().optional(),
  }),
});

export type EnvCheckResult = z.infer<typeof EnvCheckResultSchema>;

/**
 * AppSettings：应用程序全局配置。
 */
export const AppSettingsSchema = z.object({
  /** Hugging Face Access Token */
  hfToken: z.string().optional(),
  /** 默认 Whisper 模型规格 */
  defaultModelSize: z.enum(['tiny', 'base', 'small', 'medium', 'large', 'large-v2', 'large-v3']).default('medium'),
  /** 并发任务数限制 */
  maxConcurrentJobs: z.number().int().min(1).max(4).default(1),
  /** 模型存储路径 (可选，留空使用默认) */
  modelDir: z.string().optional(),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
