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
 * PingResponse：最小联通性测试数据结构（用于基础框架阶段）。
 */
export const PingResponseSchema = z.object({
  message: z.string(),
});

export type PingResponse = z.infer<typeof PingResponseSchema>;
