# VTOT (Video to Text)

VTOT 是一个基于 Electron + Next.js + Python Engine 的全向音视频转写工具。

## 项目架构

- **apps/desktop**: Electron 主进程，负责窗口管理、SQLite 持久化、任务调度及 Worker 进程管理。
- **apps/renderer**: 基于 Next.js 的渲染进程，提供现代化、响应式的任务管理界面。
- **apps/worker**: Node.js 子进程，负责协调 Python 引擎执行具体的音频提取、转写、说话人分离等任务。
- **packages/shared**: 包含 Zod schema 和 TypeScript 类型定义，确保跨进程通信的安全性。
- **engine**: Python 核心引擎，使用 Whisper 和相关库进行高性能 AI 处理。

## 技术栈

- **Frontend**: React, Next.js, CSS Modules (BEM), Zod
- **Backend (Desktop)**: Electron, better-sqlite3
- **Engine**: Python, Faster-Whisper, Pyannote-Diarization
- **DevOps**: pnpm workspaces, uv (Python 依赖管理)

## 规范

- **CSS**: 遵循 BEM 规则，禁用 `gap` 和 `grid` 布局。
- **Type Safety**: 全量使用 TypeScript，并通过 Zod schema 在 IPC 边界进行运行时校验。

## 如何运行

1.  **环境准备**:
    - 安装 Node.js (v20+)
    - 安装 pnpm
    - 安装 uv (Python 管理工具)

2.  **安装依赖**:
    ```bash
    pnpm install
    # 初始化 Python 环境
    uv venv
    uv sync
    ```

3.  **启动开发环境**:
    ```bash
    # 启动 Renderer
    pnpm --filter @vtot/renderer dev
    # 启动 Desktop (会自动拉起 Worker)
    pnpm --filter @vtot/desktop dev
    ```
