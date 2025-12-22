# VTOT 桌面端转写应用：架构与协议规格（MVP）

## 1. 目标与约束

- **目标**：将本地音频/视频中的语音转成文字，并导出字幕。
- **语言**：中英混合（默认 `language=auto`）。
- **字幕格式**：必须支持 `SRT` / `VTT`（带时间轴），并支持导出纯文本 `TXT`（如 `input.txt`）。
- **说话人区分**：需要 diarization，**2-5 个 speaker**，时间对齐“基本正确即可”。
- **隐私**：音频不上传；推理与处理全部在本机完成。
- **在线**：仅用于未来扩展（如下载模型、更新、登录/授权），**不用于上传音频做转写**。

## 2. 技术栈与进程分层

### 2.1 桌面端技术栈

- **桌面壳**：Electron
- **UI**：Next.js（React）+ TypeScript
- **状态管理**：Jotai
- **校验**：zod（用于 IPC payload、Engine request/response 等 JSON 的轻量校验）
- **音视频处理**：ffmpeg / ffprobe
- **本地引擎（建议）**：WhisperX（转写+对齐） + pyannote（diarization）
- **存储**：SQLite（任务、结果索引、设置、最近任务）
- **密钥**：HF Token 等放系统密钥库（例如 keytar），不写明文配置文件

### 2.2 分层职责

- **Renderer（Next.js UI）**
  - 仅负责：导入文件、展示任务、展示/编辑字幕、导出。
  - 不直接跑 ffmpeg/模型，避免 UI 卡死。
- **Main（Electron 主进程）**
  - 负责：任务调度、IPC 路由、DB、文件读写、拉起 Worker。
- **Worker（后台执行）**
  - 负责：ffmpeg 编排、切片、调用 Engine、合并结果、导出 SRT/VTT/TXT。
  - **建议（MVP 推荐）**：Worker 以独立 Node 子进程运行，与 Main 进程隔离，便于强杀/重启，避免主进程被长任务拖死。
- **Engine（Python/可执行文件）**
  - 负责：WhisperX/pyannote 的计算。
  - 与 Worker 采用**文件式协议**通信（request/response/progress）。

## 3. 项目结构建议（概念）

- `packages/shared/`
  - `domain-types/`：Job/Utterance/Cue 等类型
  - `ipc-contracts/`：IPC 请求/响应/事件类型
  - `subtitle/`：SRT/VTT 格式化纯函数
- `apps/desktop/src/main/`：调度、DB、IPC
- `apps/desktop/src/renderer/`：Next.js UI（推荐使用 `app/` 或 `pages/` 目录结构）
- `apps/desktop/src/worker/`：Pipeline 编排
- `engine/`：Python 引擎源码（或最终 `transcriber.exe`）

## 4. Job 与落盘目录规范

### 4.1 JobRoot 目录结构

每个任务一个目录：`{appData}/jobs/{jobId}/`

- `job.json`：任务输入与选项（创建任务即写入）
- `job.lock`：互斥锁文件（可选，用于防止同一 `jobId` 被并发执行）
- `cancel.flag`：取消哨兵文件（可选，存在即代表用户取消）
- `artifacts/`：每个 step 的结构化输出（JSON）
  - `manifest.json`：step 输出索引与完整性标记（推荐）
  - `subtitle.edited.json`：用户编辑后的字幕快照（可选，导出时优先使用）
- `cache/`：中间文件（音频抽取、分段 wav）
- `engine/`：引擎原始输出（可选）
- `exports/`：导出的字幕文件
- `logs/`：日志（可选）

### 4.2 job.json（示例）

```json
{
  "schemaVersion": "1.0",
  "jobId": "uuid",
  "source": {
    "originalPath": "C:\\path\\input.mp4",
    "importStrategy": "reference",
    "fingerprint": { "sizeBytes": 123456789, "mtimeMs": 1734830000000 }
  },
  "options": {
    "language": "auto",
    "modelSize": "small",
    "diarization": { "enabled": true, "minSpeakers": 2, "maxSpeakers": 5 },
    "export": {
      "formats": ["srt", "vtt", "txt"],
      "speakerStyle": "none"
    }
  },
  "meta": {
    "createdAt": 1734830000000,
    "createdByAppVersion": "0.1.0"
  }
}
```

- `schemaVersion`：`job.json` 的结构版本（用于兼容与迁移）。
- `source.originalPath`：源文件原始路径（Main 会将 `job.create.sourceFilePath` 写入该字段）。
- `source.importStrategy`：源文件导入策略（见 4.3）。
- `source.copiedToCachePath`：仅当 `importStrategy=copy` 时存在，表示复制到任务目录后的源文件路径。
- `source.fingerprint`：用于检测源文件是否被替换/修改（避免“同路径不同内容”导致结果混乱）。
- `meta.createdByAppVersion`：创建该任务的应用版本（用于排障与兼容）。

- `speakerStyle`：
  - `none`：默认 **B**（字幕文本不加 speaker 前缀）
  - `prefix`：支持 **A**（导出时在每条 cue 前加 `Speaker 1:` 之类）

### 4.3 source 导入策略（MVP 推荐）

为了兼顾“导入速度/磁盘占用/重启可恢复”，建议将源文件导入策略显式化：

- `reference`（默认）
  - 不复制源文件；Worker 直接读取 `source.originalPath`。
  - 创建任务时记录 `fingerprint(sizeBytes + mtimeMs)`，Worker 开始执行前校验 fingerprint 一致性。
  - V1 建议：可选增加 hash（例如读取文件首尾小块计算 hash）以提升“被替换但 size/mtime 未变”的识别能力；MVP 不强制。
  - 若源文件不存在/无法访问/被替换：返回 `E_INVALID_INPUT` 或 `E_PERMISSION_DENIED`，并在 UI 提示用户重新选择文件。
- `copy`（可选）
  - 将源文件复制到 `{JobRoot}/cache/source.*`，并在 `job.json.source.copiedToCachePath` 记录路径。
  - 复制动作必须在 `probe` 前完成（可在创建任务时执行，也可由 Worker 启动后先复制再执行 pipeline）。
  - 适用于：用户担心源文件移动/删除、或希望任务完全自包含。

`importStrategy=copy` 时 `source` 字段示例：

```json
{
  "originalPath": "C:\\path\\input.mp4",
  "importStrategy": "copy",
  "copiedToCachePath": "C:\\appData\\jobs\\{jobId}\\cache\\source.mp4",
  "fingerprint": { "sizeBytes": 123456789, "mtimeMs": 1734830000000 }
}
```

- `cache`（V1 建议）
  - 引入全局媒体缓存（例如 `{appData}/media-cache/`），用 fingerprint 复用已抽取的音频与中间产物。

Worker 侧建议统一计算一个 `effectiveSourcePath`：

- 当 `importStrategy=copy` 且 `copiedToCachePath` 存在时：使用 `copiedToCachePath`
- 否则：使用 `originalPath`

## 5. Pipeline Step 规范（Worker 负责编排）

> 时间单位统一为 `ms`。

> 约定：所有 `artifacts/*.json` 顶层都包含 `schemaVersion`、`jobId`、`step`，并在 `meta` 中记录 `createdAt` 与 `attempt`（从 1 开始）。

### 5.0 Step 名称与约束（MVP）

- `step` 名称在全局统一使用（用于：`artifacts/*.json.step`、`job.progress.step`、`job.status.step`、`error.step`）。
- 时间基准统一：所有 `startMs/endMs` 都以 `{JobRoot}/cache/extracted/audio.wav` 的起点为 `0ms`（全局时间轴），用于保证 `words/turns/cues` 可直接做时间重叠计算。
- MVP 允许的 step 名称：
  - `probe`
  - `extract_audio`
  - `segment`
  - `transcribe`
  - `diarize`
  - `merge`
  - `export`
- 约定（MVP）：除 `manifest.json/subtitle.edited.json` 外，step 的默认输出文件名与 `step` 一致，例如：`artifacts/extract_audio.json`。

### Step 1：probe（ffprobe）

- 输出：`artifacts/probe.json`

```json
{
  "schemaVersion": "1.0",
  "jobId": "uuid",
  "step": "probe",
  "sourcePath": "...",
  "format": { "container": "mp4", "durationMs": 3578123 },
  "audio": {
    "hasAudio": true,
    "codec": "aac",
    "sampleRate": 48000,
    "channels": 2
  },
  "meta": { "createdAt": 1734830000000, "attempt": 1 }
}
```

### Step 2：extract_audio（ffmpeg 抽音频+统一格式）

- 目标：统一为 `mono + 16kHz wav`
- 输出：`artifacts/extract_audio.json`

```json
{
  "schemaVersion": "1.0",
  "jobId": "uuid",
  "step": "extract_audio",
  "inputPath": "...",
  "outputWavPath": "...\\cache\\extracted\\audio.wav",
  "audio": { "sampleRate": 16000, "channels": 1, "durationMs": 3578123 },
  "meta": { "createdAt": 1734830000000, "attempt": 1 }
}
```

### Step 3：segment（切片）

- 默认策略：**静音切分优先**，固定窗口兜底
- 默认参数：
  - **max 45s**（最长段）
  - **min 5s**（最短段）
- 输出：`artifacts/segment.json`

```json
{
  "schemaVersion": "1.0",
  "jobId": "uuid",
  "step": "segment",
  "wavPath": "...\\cache\\extracted\\audio.wav",
  "segmentsDir": "...\\cache\\segments",
  "segments": [
    {
      "index": 0,
      "startMs": 0,
      "endMs": 42500,
      "segmentWavPath": "...\\segments\\0000.wav"
    }
  ],
  "meta": { "createdAt": 1734830000000, "attempt": 1 }
}
```

### Step 4：transcribe（Engine：WhisperX 转写 + 对齐）

- 输入：`segment.json` + `job.json.options`
- 约定（MVP）：Worker 固定设置 `enableWordTimestamps=true`（用于 merge），无需从 UI/IPC 透传
- 输出：`artifacts/transcribe.json`

```json
{
  "schemaVersion": "1.0",
  "jobId": "uuid",
  "step": "transcribe",
  "language": "auto",
  "modelSize": "small",
  "enableWordTimestamps": true,
  "segments": [
    {
      "index": 0,
      "startMs": 0,
      "endMs": 42500,
      "text": "hello 大家好",
      "words": [
        { "startMs": 1200, "endMs": 1600, "text": "hello", "confidence": 0.92 },
        { "startMs": 2000, "endMs": 2300, "text": "大家好", "confidence": 0.88 }
      ]
    }
  ],
  "meta": { "createdAt": 1734830000000, "attempt": 1 }
}
```

### Step 5：diarize（Engine：说话人分离）

- 输入：`extract_audio.json` + `job.json.options.diarization`
- 输出：`artifacts/diarize.json`
- 约定（MVP）：若 `job.json.options.diarization.enabled=false`，Worker 可直接生成单 speaker 的 `diarize.json`（不调用 Engine）

```json
{
  "schemaVersion": "1.0",
  "jobId": "uuid",
  "step": "diarize",
  "speakers": [{ "speakerId": "SPEAKER_00" }, { "speakerId": "SPEAKER_01" }],
  "turns": [
    {
      "speakerId": "SPEAKER_00",
      "startMs": 0,
      "endMs": 2100,
      "confidence": 0.8
    },
    {
      "speakerId": "SPEAKER_01",
      "startMs": 2100,
      "endMs": 5200,
      "confidence": 0.78
    }
  ],
  "meta": { "createdAt": 1734830000000, "attempt": 1 }
}
```

### Step 6：merge（Worker：合并转写与 speaker）

- 输入：`transcribe.json` + `diarize.json`
- 输出：`artifacts/merge.json`
- 约定（MVP）：`cueId` 是稳定标识；`index` 仅用于排序，UI 编辑/增删时不要依赖 `index`

```json
{
  "schemaVersion": "1.0",
  "jobId": "uuid",
  "step": "merge",
  "speakers": [
    { "speakerId": "SPEAKER_00", "displayName": "Speaker 1" },
    { "speakerId": "SPEAKER_01", "displayName": "Speaker 2" }
  ],
  "cues": [
    {
      "cueId": "c1",
      "index": 0,
      "startMs": 1200,
      "endMs": 2300,
      "speakerId": "SPEAKER_00",
      "text": "hello 大家好"
    }
  ],
  "meta": { "createdAt": 1734830000000, "attempt": 1 }
}
```

### Step 7：export（Worker：导出 SRT/VTT/TXT）

- 输入：
  - `merge.json`（或 `subtitle.edited.json`，若存在且校验通过则优先使用）
  - 本次导出参数（默认使用 `job.json.options.export`；也可由 `job.export` request 覆盖，仅对本次生效）
- 输出：`artifacts/export.json`
- 说明：支持重复导出（例如用户编辑后再次导出），推荐通过 `job.export` 触发，仅重跑 export step

```json
{
  "schemaVersion": "1.0",
  "jobId": "uuid",
  "step": "export",
  "speakerStyle": "none",
  "exports": [
    { "format": "srt", "filePath": "...\\exports\\subtitles.srt" },
    { "format": "vtt", "filePath": "...\\exports\\subtitles.vtt" },
    { "format": "txt", "filePath": "...\\exports\\input.txt" }
  ],
  "meta": { "createdAt": 1734830000000, "attempt": 1 }
}
```

## 6. Engine 文件式协议（MVP 必做）

> 目标：让 Worker 与 Engine 的交互不依赖 stdout 文本解析；即使 Engine 崩溃，也能通过落盘文件定位问题。

### 6.0 Engine 启动方式（由 Worker 调用）

- Worker 使用 Main 注入的 `VTOT_ENGINE_PATH` 启动 Engine（见第 18.2 节）。
- 建议 Engine CLI 形态（示例）：

```bash
{VTOT_ENGINE_PATH} --workDir "{JobRoot}\\engine\\transcribe"
```

- Engine 必须：
  - 以 `workDir` 为唯一入口，读取 `{workDir}/request.json`
  - 写出 `{workDir}/progress.json`（可选）与 `{workDir}/response.json`
  - stdout/stderr 仅用于诊断（可被截断写入 `error.detail.stderrTail`），不作为协议字段

### 6.1 目录与文件约定

- Engine 每次执行使用独立工作目录（避免不同 command 互相覆盖）：
  - `transcribe`：`{JobRoot}/engine/transcribe/`
  - `diarize`：`{JobRoot}/engine/diarize/`
- Worker 在启动 Engine 前写入：
  - `{EngineWorkDir}/request.json`
- Engine 执行中反复更新（可选）：
  - `{EngineWorkDir}/progress.json`
- Engine 结束后写入：
  - `{EngineWorkDir}/response.json`

写入要求（MVP）：

- 必须采用“写临时文件 + 原子替换”方式，避免 Windows 上出现截断 JSON。
  - Python：推荐 `os.replace(tmpPath, finalPath)`
  - Node：推荐同盘 `rename`（确保替换为原子操作）

### 6.2 request.json（示例）

- `protocolVersion`：Engine 文件式协议版本（与第 13 章策略一致：严格写入、宽松读取）。
- `command`：`transcribe` | `diarize`
- `jobId`：任务 ID
- `cancelFlagPath`：可选；若 Engine 支持取消轮询，则读取该文件是否存在

`transcribe` 示例：

```json
{
  "protocolVersion": "1.0",
  "command": "transcribe",
  "jobId": "uuid",
  "segmentJsonPath": "...\\artifacts\\segment.json",
  "options": {
    "language": "auto",
    "modelSize": "small",
    "enableWordTimestamps": true
  },
  "cancelFlagPath": "...\\cancel.flag"
}
```

`diarize` 示例：

```json
{
  "protocolVersion": "1.0",
  "command": "diarize",
  "jobId": "uuid",
  "wavPath": "...\\cache\\extracted\\audio.wav",
  "diarization": { "minSpeakers": 2, "maxSpeakers": 5 },
  "cancelFlagPath": "...\\cancel.flag"
}
```

### 6.3 progress.json（示例，Engine -> Worker，可选）

- 目的：让 Worker 能对 UI 发出更细粒度的 `job.progress`（见第 8.1 节）。
- 约定：
  - `percent` 为 0-100
  - `segmentIndex` 为 0 基（0-based），仅 `transcribe` 可能出现
  - `ts` 为 ms 时间戳

```json
{
  "protocolVersion": "1.0",
  "command": "transcribe",
  "jobId": "uuid",
  "percent": 42,
  "segmentIndex": 3,
  "segmentTotal": 10,
  "message": "transcribing 4/10",
  "ts": 1734830000000
}
```

### 6.4 response.json（Engine -> Worker）

- `ok=true`：`result` 结构应与对应 step 的 artifacts JSON 一致（第 5 章）。
- `ok=false`：`error` 结构与第 12.1 节 `AppError` 对齐。
- Engine 若发现 `protocolVersion` 不兼容，必须返回：`E_PROTOCOL_INCOMPATIBLE`。

成功示例：

```json
{
  "protocolVersion": "1.0",
  "command": "transcribe",
  "jobId": "uuid",
  "ok": true,
  "result": { "...": "省略，结构与 artifacts/transcribe.json 一致" }
}
```

失败示例：

```json
{
  "protocolVersion": "1.0",
  "command": "transcribe",
  "jobId": "uuid",
  "ok": false,
  "error": {
    "code": "E_PROTOCOL_INCOMPATIBLE",
    "message": "protocolVersion incompatible",
    "retryable": false
  }
}
```

### 6.5 Worker 侧落盘规则（MVP）

- Worker 读取 `response.json.ok=true` 后：
  - 将 `result` 写入 `{JobRoot}/artifacts/{step}.json`（同样使用原子写）
- Worker 读取到 `ok=false` 或无 `response.json`：
  - 将 job 标为 `failed`，并写入 `error`（见第 7 章）

## 7. 错误码规范（MVP 必做）

> 目标：让 UI 能稳定展示错误、让 Main 能决定是否允许重试、让排障与埋点聚合有稳定维度。

### 7.1 约定

- 错误结构见第 12.1 节 `AppError`。
- `message` 必须面向用户（短句）。
- `detail` 仅用于排障：
  - 必须脱敏（禁止写入 Token、用户隐私文本）
  - 必须截断（例如 `stderrTail` 最多 8KB）

### 7.2 错误码清单（建议最小集合）

- **E_INVALID_INPUT**（`retryable=false`）
  - 输入文件路径不存在、job.json 缺字段、schema 校验失败等。
- **E_PERMISSION_DENIED**（`retryable=false`）
  - 读写权限不足、路径不在允许范围等。
- **E_FFMPEG_FAILED**（`retryable=false`）

  - ffmpeg/ffprobe 执行失败（不支持格式、解码失败等）。

- **E_ENVIRONMENT_ERROR**（`retryable=true`）

  - 本地运行环境/依赖错误（例如 ffmpeg 不存在、Engine 不存在、依赖库缺失、动态链接库缺失等）。
  - 建议在 `error.detail.reason` 写入更具体的原因（例如 `FFMPEG_NOT_FOUND|ENGINE_NOT_FOUND|DEPENDENCY_MISSING`）。

- **E_ENGINE_NOT_FOUND**（`retryable=false`）
  - Engine 可执行文件不存在（受控路径缺失）。
- **E_ENGINE_START_FAILED**（`retryable=false`）
  - Engine 启动失败（依赖缺失、无法拉起进程）。
- **E_ENGINE_RUNTIME_ERROR**（`retryable=true`）

  - Engine 运行时异常（推理失败、CUDA/模型异常等）。

- **E_MODEL_DOWNLOAD_REQUIRED**（`retryable=false`）
  - 模型未下载（需要用户先下载/配置）。
- **E_HF_TOKEN_REQUIRED**（`retryable=false`）
  - 访问受限模型需要 Token。
- **E_HF_TOKEN_INVALID**（`retryable=false`）

  - Token 无效/过期。

- **E_SCHEMA_INCOMPATIBLE**（`retryable=false`）
  - `schemaVersion` 主版本不兼容（需要重跑任务或清理缓存）。
- **E_PROTOCOL_INCOMPATIBLE**（`retryable=false`）

  - `protocolVersion` 主版本不兼容。

- **E_WORKER_START_FAILED**（`retryable=true`）
  - Worker 子进程拉起失败。
- **E_WORKER_CRASHED**（`retryable=true`）
  - Worker 崩溃/异常退出。
- **E_WORKER_TIMEOUT**（`retryable=true`）

  - Worker 超时被强杀。

- **E_USER_CANCELED**（`retryable=false`）
  - 仅用于“兜底映射”（例如 Worker 在退出码层面表示取消），正常情况下取消应进入 `status=canceled`，不作为错误。

### 7.3 Engine 错误到 AppError 的映射（Worker 规则）

- 若 Engine `response.json.ok=false`：
  - `error.code/message/retryable` 原样透传；`error.step` 由 Worker 补齐为当前 step。
- 若 Engine 无 `response.json` 或 JSON 无法解析：
  - 兜底映射为 `E_ENGINE_RUNTIME_ERROR`（并在 `detail` 写入 `exitCode`、`stderrTail` 等）。

## 8. 进度与日志事件（MVP 必做）

> 重要：事件均为**非权威**、**可丢**。最终状态与结果以 SQLite + JobRoot 落盘为准。

### 8.1 `job.progress`（Main -> Renderer，非权威）

- 用途：进度条、即时提示。
- 约定：
  - `percent`：0-100
  - `segmentIndex`：0 基（0-based），UI 展示可用 `segmentIndex + 1`
  - `segmentTotal`：总段数（可选）

```json
{
  "jobId": "uuid",
  "status": "running",
  "step": "transcribe",
  "percent": 42,
  "segmentIndex": 3,
  "segmentTotal": 10,
  "message": "转写中 4/10",
  "ts": 1734830000000
}
```

### 8.2 `job.log`（Main -> Renderer，非权威）

- 用途：UI 日志面板、排障。
- 约定：
  - `level`：`debug|info|warn|error`
  - `data`：可选结构化字段（用于排障；避免放大文本/敏感信息）

```json
{
  "jobId": "uuid",
  "ts": 1734830000000,
  "level": "info",
  "step": "extract_audio",
  "message": "ffmpeg extracting audio..."
}
```

## 9. zod 校验点清单（MVP 必做：跨进程/落盘 JSON）

> 原则：任何跨进程/跨语言边界的数据都必须先校验，再进入业务逻辑。

### 9.1 Renderer 校验点（建议）

- `job.create` 前：
  - 校验 `options` 结构（例如 `formats` 非空、`minSpeakers<=maxSpeakers` 等）。

### 9.2 Main 校验点（MVP 必做）

- 所有 `invoke` 入参必须 zod 校验（见第 12.2 节）：
  - `job.create/job.cancel/job.retry/job.export/job.get/job.list`
- 所有路径字段必须归一化与约束：
  - 输入文件路径必须来自用户选择
  - 输出/中间文件只能落在 `{JobRoot}`（及其子目录）

### 9.3 Worker 校验点（MVP 必做）

- 读取 `{JobRoot}/job.json` 后必须校验：
  - 失败直接退出并标记 `E_INVALID_INPUT`
- 读取/复用历史 artifacts 前必须校验：
  - schemaVersion 不兼容：`E_SCHEMA_INCOMPATIBLE`
- 读取 Engine `progress.json/response.json` 前必须校验：
  - 解析失败：按第 7.3 节兜底映射

### 9.4 WorkerEventSchema（MVP 必做）

```ts
import { z } from 'zod';

/**
 * JobStatus 的 zod schema：用于校验 Worker -> Main 事件里的 status。
 */
export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

/**
 * AppError 的 zod schema：与第 12.1 节 `AppError` 对齐。
 */
export const AppErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  step: z.string().optional(),
  retryable: z.boolean(),
  detail: z.record(z.unknown()).optional(),
});

/**
 * WorkerEvent 的 zod schema：Main 收到后必须先校验，再进入业务逻辑。
 */
export const WorkerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('worker.ready'),
    data: z.object({
      jobId: z.string(),
      pid: z.number(),
      startedAt: z.number(),
    }),
  }),
  z.object({
    type: z.literal('job.progress'),
    data: z.object({
      jobId: z.string(),
      status: JobStatusSchema,
      step: z.string(),
      percent: z.number().min(0).max(100),
      segmentIndex: z.number().int().min(0).optional(),
      segmentTotal: z.number().int().min(0).optional(),
      message: z.string(),
      ts: z.number(),
    }),
  }),
  z.object({
    type: z.literal('job.log'),
    data: z.object({
      jobId: z.string(),
      ts: z.number(),
      level: z.enum(['debug', 'info', 'warn', 'error']),
      step: z.string().optional(),
      message: z.string(),
      data: z.record(z.unknown()).optional(),
    }),
  }),
  z.object({
    type: z.literal('job.status'),
    data: z.object({
      jobId: z.string(),
      status: JobStatusSchema,
      step: z.string().optional(),
      ts: z.number(),
      error: AppErrorSchema.optional(),
    }),
  }),
]);
```

## 10. MVP 验收标准

- 任务创建：
  - `job.create` 后必须生成 `{JobRoot}` 与 `{JobRoot}/job.json`
  - DB 插入 `jobs(status=queued)`
- Pipeline 执行：
  - Step 1-7 依次生成对应 `artifacts/*.json`（结构符合第 5 章示例）
  - `exports/` 下生成 SRT/VTT/TXT（按 `job.json.options.export`）
- 取消：
  - `job.cancel` 幂等
  - 写入 `cancel.flag` 后 Worker 在轮询点停止
  - DB 最终状态为 `canceled`
- 重试：
  - `job.retry` 仅允许 `failed(retryable=true)` 或 `canceled`
  - 重试前清理 `cancel.flag` 与陈旧 `job.lock`
- 导出：
  - `job.export` 仅执行 export step，不重跑前置步骤
  - `formats/speakerStyle` 仅对本次导出有效，不写回 `job.json.options.export`
- 稳定性：
  - 所有跨进程/落盘 JSON（IPC、job.json、artifacts、Engine 协议文件）均有对应 zod 校验点（第 9 章）
  - 所有 JSON 写入必须遵守原子替换规则（第 6.1 节）
  - 错误必须包含 `code/message/retryable`（第 7 章）

## 11. Job 生命周期与可恢复执行（MVP 必做）

### 11.1 Job 状态机（最小集合）

- `queued`：已创建，等待调度
- `running`：Worker 正在执行
- `succeeded`：成功完成（`export` 已完成）
- `failed`：执行失败（带 `error`）
- `canceled`：用户取消（不当作错误）

建议由 **SQLite** 作为权威状态存储（`status/step/error/updatedAt`），`JobRoot` 负责保存 artifacts 与可导出文件。

### 11.2 取消（cancel）语义

- Main 收到 `job.cancel(jobId)` 后：
  - 写入 `{JobRoot}/cancel.flag`
  - 通知 Worker 尽快停止（如果有能力则优雅停止；否则超时后强杀兜底）
  - 幂等：若 job 已处于 `succeeded|failed|canceled`，直接返回 `{}`（不再调度/不再启动 Worker）
  - 若 job 仍为 `queued`：应从队列移除并将 DB 状态置为 `canceled`（不启动 Worker）
- Worker/Engine 在以下时机检查 `cancel.flag`：
  - 每个 step 开始前
  - 长耗时 step 的轮询点（例如：读取 Engine `progress.json` 时顺带检查）
- 取消后的落盘：
  - artifacts 可保留（用于排障或后续重试）
  - Job 状态置为 `canceled`，并可在 UI 上展示“已取消”

### 11.3 重试（retry）语义

- 前置条件（建议）：仅当 job.status 为 `failed` 且 `error.retryable=true`（或 job.status 为 `canceled`）允许重试
- 若 job 当前为 `running|queued`：返回 `E_INVALID_INPUT`（避免并发执行）
- `job.retry(jobId)` 默认语义：从**失败 step**开始重跑，并重做其后所有 step。
- 重试前 Main 需要清理控制文件：
  - 删除 `{JobRoot}/cancel.flag`（若存在）
  - 删除 `{JobRoot}/job.lock`（若存在且判定为陈旧锁）
- 为避免错误复用旧产物：建议删除“失败 step 及其后所有 step”的 artifacts 与 exports（再重新排队执行）

## 12. IPC Contract 清单（Renderer <-> Main）（MVP 必做）

### 12.1 统一返回结构与类型（MVP 必做）

> 说明：本节的 TypeScript 仅作为“契约定义”，用于约束跨进程 payload 的形状；实际实现建议放在 `packages/shared/ipc-contracts/`。

```ts
/**
 * VTOT 在 IPC/DB/落盘之间通用的错误结构。
 *
 * 目的：
 * 1) 让 UI 能稳定展示错误
 * 2) 让 Main 能根据 `retryable` 决定是否允许重试
 */
export interface AppError {
  /** 稳定错误码（用于程序逻辑与埋点聚合） */
  code: string;
  /** 面向用户的可读提示（短句，避免包含敏感路径/Token） */
  message: string;
  /** 可选：发生错误的 pipeline step 名称 */
  step?: string;
  /** 是否允许 UI 提供“重试”入口（最终由 Main 决策） */
  retryable: boolean;
  /**
   * 可选：排障信息（只给开发者/诊断包使用）。
   *
   * 说明：这里使用 `unknown`，避免上层强依赖内部结构；同时要求写入前进行脱敏与截断。
   */
  detail?: Record<string, unknown>;
}

/**
 * Renderer -> Main invoke 的统一返回结构。
 *
 * 目的：避免 throw 异常跨进程导致格式不一致。
 */
export type IpcInvokeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

/** Job 最小状态集合（与 DB `jobs.status` 对齐） */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/** 源文件导入策略（与 `job.json.source.importStrategy` 对齐） */
export type SourceImportStrategy = 'reference' | 'copy' | 'cache';

/** 导出格式集合 */
export type ExportFormat = 'srt' | 'vtt' | 'txt';

/** 导出时说话人展示风格 */
export type SpeakerStyle = 'none' | 'prefix';

/**
 * 任务创建时的可配置选项（会被写入 `job.json.options`）。
 *
 * 目的：保证 Worker 执行时无需再从 IPC 获取配置。
 */
export interface JobOptions {
  /** 语言：'auto' 表示自动检测 */
  language: string;
  /** Whisper 模型规格（MVP 只需覆盖常用档位） */
  modelSize: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  /** 说话人分离配置 */
  diarization: {
    /** 是否启用 diarization */
    enabled: boolean;
    /** 最少 speaker 数（可选） */
    minSpeakers?: number;
    /** 最多 speaker 数（可选） */
    maxSpeakers?: number;
  };
  /** 导出配置（默认值） */
  export: {
    /** 导出格式集合 */
    formats: ExportFormat[];
    /** 说话人展示风格 */
    speakerStyle: SpeakerStyle;
  };
}

/**
 * UI 列表/详情页需要的 Job 摘要（权威来自 SQLite）。
 *
 * 目的：让 Renderer 无需直接读取 JobRoot 文件即可展示任务列表。
 */
export interface JobSummary {
  /** 任务 ID */
  jobId: string;
  /** 状态 */
  status: JobStatus;
  /** 可选：最后/当前 step */
  step?: string;
  /** 源文件原始路径（用于 UI 展示） */
  sourceOriginalPath: string;
  /** 导入策略（用于 UI/诊断展示） */
  importStrategy: SourceImportStrategy;
  /** 创建时间（ms） */
  createdAt: number;
  /** 更新时间（ms） */
  updatedAt: number;
  /** 可选：失败时的错误信息 */
  error?: AppError;
}
```

### 12.2 Renderer -> Main（invoke）

- `job.create`
  - request：`{ sourceFilePath: string; importStrategy?: SourceImportStrategy; options: JobOptions }`
  - response：`IpcInvokeResult<{ jobId: string }>`
  - 说明：
    - Main 会将 `sourceFilePath` 写入 `job.json.source.originalPath`.
    - `importStrategy` 为空时默认按 `reference` 处理。
- `job.cancel`
  - request：`{ jobId: string }`
  - response：`IpcInvokeResult<{}>`
  - 说明：
    - 语义见第 11.2 节。
    - 幂等：若 job 已处于 `succeeded|failed|canceled`，直接返回 `{}`。
- `job.retry`
  - request：`{ jobId: string }`
  - response：`IpcInvokeResult<{}>`
  - 前置条件：
    - 语义见第 11.3 节。
    - 仅当 job.status 为 `failed` 且 `error.retryable=true`（或 job.status 为 `canceled`）允许重试。
    - 若 job 当前为 `running|queued`：返回 `E_INVALID_INPUT`。
- `job.export`
  - request：`{ jobId: string; formats: ExportFormat[]; speakerStyle: SpeakerStyle }`
  - response：`IpcInvokeResult<{ exports: { format: ExportFormat; filePath: string }[] }>`
  - 说明：
    - 仅执行 `export` step（依赖 `merge.json` 或 `subtitle.edited.json` 已存在）。
    - `formats/speakerStyle` 仅对本次导出有效，不写回 `job.json.options.export`。
    - 前置条件：若 job 当前为 `running|queued`，返回 `E_INVALID_INPUT`（避免并发导出）。
- `job.get`
  - request：`{ jobId: string }`
  - response：`IpcInvokeResult<{ job: JobSummary }>`
- `job.list`

  - request：`{ cursor?: string; limit?: number }`
  - response：`IpcInvokeResult<{ jobs: JobSummary[]; nextCursor?: string }>`

### 12.3 Main -> Renderer（event）

- `job.progress`（非权威、可丢事件）
  - 用于进度条与实时提示
- `job.log`（非权威、可丢事件）
  - 用于 UI 日志面板
- `job.status`（MVP 推荐，状态变更快照）
  - 低频：仅在 `status/step/error` 发生变化时发送
  - 用于 UI 列表刷新与“最终一致性”
  - 说明：事件本身仍可能丢失；UI 在需要时应通过 `job.get/job.list` 以 DB 快照兜底

`job.status` 示例：

```json
{
  "jobId": "uuid",
  "status": "failed",
  "step": "diarize",
  "ts": 1734830000000,
  "error": {
    "code": "E_ENGINE_RUNTIME_ERROR",
    "message": "engine failed",
    "step": "diarize",
    "retryable": true
  }
}
```

## 13. Schema / Protocol 版本化与兼容策略（建议作为 V1 补齐）

### 13.1 字段约定

- `schemaVersion`：用于 `job.json` 与 `artifacts/*.json` 的结构版本（建议采用 `MAJOR.MINOR`）。
- `protocolVersion`：用于 Engine `request/progress/response` 的协议版本（建议采用 `MAJOR.MINOR`）。

### 13.2 兼容规则（推荐）

- **严格写入，宽松读取**：
  - 写入端必须写齐当前版本要求的必填字段
  - 读取端必须忽略未知字段（便于 minor 扩展）
- **主版本不兼容**（MAJOR 不同）处理建议：
  - Worker 读取到不兼容 `schemaVersion`：返回 `E_SCHEMA_INCOMPATIBLE`，提示用户“需要重跑任务或清理缓存”。
  - Engine 收到不兼容 `protocolVersion`：返回 `E_PROTOCOL_INCOMPATIBLE`。

## 14. 字幕编辑模型与导出规则（建议作为 V1 补齐）

### 14.1 机器结果与编辑结果分离

- `artifacts/merge.json`：机器合并结果（不被 UI 编辑直接覆盖）。
- `artifacts/subtitle.edited.json`：用户编辑后的字幕快照（导出时优先使用）。

### 14.2 subtitle.edited.json（示例）

```json
{
  "schemaVersion": "1.0",
  "jobId": "uuid",
  "speakers": [{ "speakerId": "SPEAKER_00", "displayName": "Speaker 1" }],
  "cues": [
    {
      "cueId": "c1",
      "startMs": 1200,
      "endMs": 2300,
      "speakerId": "SPEAKER_00",
      "text": "hello 大家好"
    }
  ],
  "meta": { "editedAt": 1734830000000 }
}
```

### 14.3 导出规则（补充）

- 导出时选择输入：
  - 若 `subtitle.edited.json` 存在且校验通过，则用其 `cues` 导出
  - 否则回退到 `merge.json.cues`
- `speakerStyle=prefix`：仅在导出时拼接 `${displayName}: ${cue.text}`，**不写回** `cue.text`。

## 15. 模型管理与资源调度（建议作为 V1 补齐）

### 15.1 模型与缓存目录（建议）

- 模型与缓存建议分离：
  - `{appData}/models/`：模型文件（可复用、体积大）
  - `{appData}/jobs/{jobId}/cache/`：任务级中间文件（可清理）

### 15.2 Token 与环境变量注入

- HF Token 等敏感信息：
  - Renderer 不接触明文
  - Main 存系统密钥库（例如 keytar）
  - Worker 启动 Engine 时通过环境变量注入（例如 `HF_TOKEN`）

### 15.3 并发与队列（MVP 建议默认 1）

- 默认只允许同时运行 1 个 `running` job，其余 `queued`。
- 后续如要扩展并发：建议把“推理阶段”作为互斥资源，避免 GPU/CPU 抢占导致整体变慢。
- 最简资源令牌建议（MVP 可先做这一条）：推理令牌 `engine=1`，任意时刻只允许 1 个 Engine 推理任务运行。

## 16. 诊断与排障（建议作为 V1 补齐）

### 16.1 建议的最小诊断材料

- `{JobRoot}/job.json`
- `{JobRoot}/artifacts/manifest.json`（若启用）
- `{JobRoot}/logs/`（若启用）
- 失败时的 `error.detail.stderrTail`（已在错误结构中约定）

### 16.2 日志建议（可选）

- Worker 建议把 `job.log` 事件同时落盘为 JSONL：`logs/job.log.jsonl`（一行一个 JSON）。
- Engine 若能输出日志：建议落盘到 `engine/engine.log`，并在错误时截取尾部写入 `error.detail`。

## 17. 工程化优化建议（按 9 类落地）

> 本章用于把“架构方向”写成可实施的工程约束，避免实现时口头约定失效。

### 17.1 Worker 进程隔离（MVP 推荐）

- 目标：避免长任务/崩溃影响 Main 与 UI，提升取消与超时控制能力。
- MVP 推荐：
  - Worker 以独立 Node 子进程运行（Main 负责拉起与监控）。
  - Worker 崩溃时：Main 将 job 标为 `failed`（或 `canceled`，取决于原因），并保留 artifacts 以便重试。
- V1 建议：
  - Worker 支持“自愈重启”（同一 jobId 的互斥约束由 `job.lock` 或 DB 保证）。

### 17.2 Pipeline DAG 与资源令牌（V1 建议，MVP 可先串行）

- 目标：在不打爆 CPU/GPU 的前提下缩短总耗时。
- DAG 依赖建议：
  - `probe -> extract_audio -> segment -> transcribe -> merge -> export`
  - `extract_audio -> diarize -> merge`
  - 其中 `segment` 与 `diarize` 在 `extract_audio` 后可并行（受令牌限制）。
- 资源令牌（最简）：
  - `engine=1`：推理互斥（避免同时跑多个推理导致整体更慢）。
  - `ffmpeg`：可按机器能力设置并发上限（可选）。

### 17.3 大文件导入与缓存策略（MVP 推荐）

- 目标：减少无意义的文件复制与磁盘占用，缩短导入耗时。
- MVP 推荐：
  - 默认 `importStrategy=reference`（不拷贝源文件）。
  - 用 `fingerprint(sizeBytes + mtimeMs)` 检测源文件是否被替换。
- V1 建议：
  - 全局媒体缓存（复用抽取音频/中间产物），并提供“清理缓存”的设置入口。

### 17.4 Engine 启动开销与复用（V1 建议）

- 目标：减少 Python/模型重复加载带来的固定开销。
- V1 建议（两种路径二选一即可）：
  - Engine 增加 `command=run_job`：一次启动完成 transcribe+diarize 并输出多个 artifacts。
  - Engine daemon/pool：复用进程与模型（需更严格的版本与资源管理）。

### 17.5 数据权威边界（MVP 推荐）

- 目标：避免 DB/IPC 承载大体量字幕与词级时间戳，降低迁移与性能风险。
- MVP 推荐：
  - SQLite：只保存 `JobSummary`、状态、关键路径索引、错误信息。
  - JobRoot：保存所有重数据（`merge.json`、`subtitle.edited.json`、`transcribe.json.words` 等）。
  - IPC：避免一次性传输大量 cues/words；优先传“文件路径 + 分段读取”。

### 17.6 Electron 安全边界（MVP 必做：安全基线）

- 目标：确保 Renderer 无法获取任意文件读写/命令执行能力。
- MVP 必做：
  - `BrowserWindow` 安全配置（建议作为默认值）：
    - `contextIsolation: true`
    - `nodeIntegration: false`
    - `sandbox: true`（若业务允许）
    - `webSecurity: true`
  - Renderer 只通过 preload 暴露的白名单 API 与 Main 通信（禁止在 Renderer 暴露 `ipcRenderer` 原始对象）。
  - preload 使用 `contextBridge` 暴露单一命名空间（例如 `window.vtot`），并且只暴露最小集合：`invoke` + `on/off`（通道白名单）。
  - Main 对 IPC 入参做 zod 校验与路径归一化：
    - 所有路径先 `normalize/resolve`
    - 输入文件路径只能是用户选择过的文件
    - 输出/中间文件只能落在 `{JobRoot}`（以及其子目录）
  - ffmpeg/engine 路径固定为受控位置：
    - 禁止从 Renderer 传入可执行文件路径
    - 禁止拼接任意命令字符串（使用参数数组调用，避免注入）

### 17.7 可观测性与性能指标（V1 建议，MVP 保持日志与错误即可）

- 目标：让“慢/卡/失败”可量化、可定位。
- V1 建议：
  - 在每个 step 的 artifacts `meta` 中补充 `startedAt/endedAt/durationMs`。
  - Engine response 可选增加 `metrics`（例如 RTF、模型加载耗时、是否 GPU）。
  - UI 提供“导出诊断包”（打包 job.json + manifest + log tail）。

### 17.8 字幕与说话人体验（V1 建议）

- 目标：让结果更可编辑、可控、导出更符合字幕习惯。
- V1 建议：
  - 支持 speaker 重命名并落盘（与 `subtitle.edited.json` 一并存储）。
  - merge 阶段增加最小抖动治理（避免 1-2 秒内频繁换 speaker）。
  - 导出规则增加：最大行长/最小时长/断句策略等可配置项。

### 17.9 Renderer 打包与运行时复杂度（Next.js + Electron）（V1 建议）

- 目标：降低打包与运行时复杂度，减少线上故障面。
- V1 建议：
  - 若不需要 SSR：优先采用静态资源方式打包 Renderer，避免在桌面端内置复杂的服务端运行时。
  - 明确路由、资源加载与更新策略（避免因资源路径/缓存导致白屏）。

## 18. Main <-> Worker 子进程协议（MVP 推荐）

> 目标：让 Worker 成为可控、可观测、可强杀的独立执行单元。

### 18.1 Worker 启动方式（建议）

- Main 以子进程方式启动 Worker（每个 job 一个 Worker 进程，job 结束进程退出）：
  - 推荐：Node 子进程（便于跨平台）
  - 进阶：打包为独立 `worker.exe`（减少对 Node 运行时依赖）

Worker CLI（示例）：

```bash
vtot-worker run --jobRoot "...\\jobs\\{jobId}"
```

约定：Worker 启动后通过读取 `{JobRoot}/job.json` 获取 `jobId/source/options`，避免 Main 通过命令行传递大量参数。

通信通道建议（MVP 推荐）：

- 若 Worker 以 Node 脚本运行：建议使用 `child_process.fork` 的内建 IPC（`process.send`）传输 `WorkerEvent/WorkerControl`。
- 若 Worker 打包为独立可执行文件：建议使用 stdout 输出 NDJSON（每行一个 `WorkerEvent` JSON），并用 stdin 接收 `WorkerControl` NDJSON。
- 无论哪种通道：Main 与 Worker 都应对消息体做 zod 校验（对应第 9.4 节 `WorkerEventSchema`）。

### 18.2 环境变量（由 Main 注入）

- `VTOT_ENGINE_PATH`：Engine 可执行文件路径（受控）
- `VTOT_FFMPEG_PATH`：ffmpeg 路径（受控）
- `VTOT_FFPROBE_PATH`：ffprobe 路径（受控）
- `HF_TOKEN`：HuggingFace token（若需要；来自系统密钥库，不落盘）

### 18.3 Worker -> Main 事件（IPC 消息）

约定：Worker 只通过事件把“进度/状态/日志”传回 Main，**禁止通过 IPC 传输大量字幕/词级时间戳**；大数据必须落盘到 `{JobRoot}/artifacts/`。

```ts
/**
 * Worker 启动完成事件：用于 Main 判断 Worker 已就绪。
 */
export interface WorkerReadyEvent {
  /** 任务 ID */
  jobId: string;
  /** Worker 进程 PID */
  pid: number;
  /** 启动时间（ms） */
  startedAt: number;
}

/**
 * Job 进度事件：与文档第 8.1 节的 `job.progress` 对齐。
 */
export interface JobProgressEvent {
  /** 任务 ID */
  jobId: string;
  /** 当前状态（通常为 running） */
  status: JobStatus;
  /** 当前 step */
  step: string;
  /** 0-100 */
  percent: number;
  /**
   * 可选：分段序号（用于 transcribe）。
   *
   * 约定：0 基（0-based），UI 展示时可用 `segmentIndex + 1`。
   */
  segmentIndex?: number;
  /** 可选：总分段数（用于 transcribe） */
  segmentTotal?: number;
  /** 面向用户的提示 */
  message: string;
  /** 事件时间（ms） */
  ts: number;
}

/**
 * Job 日志事件：与文档第 8.2 节的 `job.log` 对齐。
 */
export interface JobLogEvent {
  /** 任务 ID */
  jobId: string;
  /** 日志时间（ms） */
  ts: number;
  /** 日志级别 */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** 可选：当前 step */
  step?: string;
  /** 日志正文 */
  message: string;
  /**
   * 可选：结构化字段。
   *
   * 说明：这里使用 `unknown` 以避免上层逻辑依赖内部结构。
   */
  data?: Record<string, unknown>;
}

/**
 * Job 状态事件：与文档第 12.3 节的 `job.status` 示例对齐。
 */
export interface JobStatusEvent {
  /** 任务 ID */
  jobId: string;
  /** 状态（权威以 DB 为准，事件用于刷新） */
  status: JobStatus;
  /** 可选：最后所在 step */
  step?: string;
  /** 事件时间（ms） */
  ts: number;
  /** 可选：失败时错误结构 */
  error?: AppError;
}

/**
 * Worker 发给 Main 的事件集合。
 */
export type WorkerEvent =
  | { type: 'worker.ready'; data: WorkerReadyEvent }
  | { type: 'job.progress'; data: JobProgressEvent }
  | { type: 'job.log'; data: JobLogEvent }
  | { type: 'job.status'; data: JobStatusEvent };
```

### 18.4 Main -> Worker 控制（MVP 最小）

- 取消建议以文件哨兵为主（`{JobRoot}/cancel.flag`），Main 写入后 Worker 在轮询点检查。
- 可选（减少取消延迟）：Main 通过 IPC 发送 `worker.cancel`，Worker 收到后立即检查并退出。

```ts
/**
 * Main 发给 Worker 的控制消息（最小集合）。
 */
export type WorkerControl = {
  type: 'worker.cancel';
  data: { jobId: string; ts: number };
};
```

### 18.5 Worker 退出码（兜底）

> 说明：最终状态以 `job.status` 事件 + DB 落库为准；退出码仅作为“Worker 崩溃/丢事件”的兜底。

- `0`：成功（Main 应收到 `job.status(status=succeeded)`）
- `1`：用户取消（Main 应收到 `job.status(status=canceled)`；若事件丢失则 Main 直接将 DB 状态置为 `canceled`，不写入 `error`）
- `2`：输入无效（例如 `job.json` 缺字段/损坏）
- `3`：环境错误（例如 ffmpeg/engine 不存在）
- `10`：运行时异常（兜底失败）

### 18.6 退出码到状态/错误码映射（Main 兜底规则）

- 启动失败（子进程拉起失败）：`status=failed` + `error=E_WORKER_START_FAILED`
- exitCode=1：`status=canceled`（不写入 `error`）
- exitCode=2：`status=failed` + `error=E_INVALID_INPUT`
- exitCode=3：`status=failed` + `error=E_ENVIRONMENT_ERROR`（建议在 `error.detail.reason` 写明 `FFMPEG_NOT_FOUND|ENGINE_NOT_FOUND|DEPENDENCY_MISSING` 等）
- exitCode=10 或异常退出/无退出码：`status=failed` + `error=E_WORKER_CRASHED`
- 超时被 Main 强杀：`status=failed` + `error=E_WORKER_TIMEOUT`

## 19. SQLite 数据模型（MVP 推荐）

> 目标：SQLite 只保存“索引与权威状态”，重数据落盘在 `{JobRoot}`。

### 19.1 原则

- 只有 Main 进程读写 SQLite（Renderer/Worker 不直接访问 DB）。
- DB 作为 Job 状态的权威来源：UI 列表与详情优先读 DB。
- cues/words 等大字段不进入 DB（避免膨胀与迁移风险）。

### 19.2 表结构（建议）

```sql
-- jobs：任务索引与权威状态
CREATE TABLE IF NOT EXISTS jobs (
  -- 任务 ID（uuid）
  job_id TEXT PRIMARY KEY,
  -- 状态：queued/running/succeeded/failed/canceled
  status TEXT NOT NULL,
  -- 当前/最后 step（可空）
  step TEXT,
  -- 源文件路径（用于 UI 展示）
  source_original_path TEXT NOT NULL,
  -- 导入策略：reference/copy/cache
  source_import_strategy TEXT NOT NULL,
  -- fingerprint（用于检测源文件替换）
  source_fingerprint_size_bytes INTEGER,
  source_fingerprint_mtime_ms INTEGER,
  -- jobRoot 路径（可选；若可由 appData 推导，也可不存）
  job_root_path TEXT,
  -- 时间戳
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 错误（失败时写入；取消/成功可为空）
  error_code TEXT,
  error_message TEXT,
  error_step TEXT,
  error_retryable INTEGER,
  -- error.detail 的 JSON 字符串（可选，注意截断/脱敏）
  error_detail_json TEXT,
  -- 约束：保证 status 值合法
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled'))
);

-- jobs 列表常用索引
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status_updated_at ON jobs (status, updated_at DESC);

-- settings：非敏感设置（敏感信息如 HF_TOKEN 放系统密钥库，不进 DB）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  -- JSON 字符串，便于扩展
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

SQLite 运行参数建议（可选）：

- `PRAGMA journal_mode=WAL;`（减少读写互斥）
- `PRAGMA synchronous=NORMAL;`（性能与可靠性的折中）
- `PRAGMA busy_timeout=3000;`（避免短时间写锁导致的失败）

### 19.3 状态更新规则（MVP 最小可用）

- `job.create`：插入 `jobs(status=queued)`；同时创建 JobRoot 与 `job.json`。
- `job.start`（Main 调度开始）：将 `status` 更新为 `running`，`step` 置为 `probe`。
- Main 接收 Worker `job.status`：以事件为准更新 DB（并更新 `updated_at`）。
- 应用重启后的兜底：
  - 若 DB 中存在 `status=running` 的 job（表示上次运行中断）：MVP 可直接标为 `failed`，错误码使用 `E_WORKER_CRASHED`（`detail.reason=APP_RESTART`），用户可点击重试。

### 19.4 幂等与一致性（建议）

- DB 更新建议使用事务：
  - 先落库状态
  - 再广播 `job.status` 给 Renderer
- `job.status` 事件可丢失：UI 需要时必须以 `job.get/job.list` 读取 DB 快照兜底。
