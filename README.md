# VTOT (Video to Text)

VTOT 是一个基于 Electron + Next.js + Python Engine 的全向音视频转写工具。支持将视频/音频文件自动转写为带时间戳的字幕文件（SRT/VTT），并可选启用说话人分离功能。

## ✨ 核心特性

-   **高精度转写**: 基于 WhisperX 实现高质量语音识别，支持多种模型规格（Tiny ~ Large-v3）
-   **说话人分离**: 集成 Pyannote 进行说话人识别，支持多人对话场景
-   **多格式导出**: 支持 SRT、VTT、TXT 等常见字幕格式
-   **简繁转换**: 自动将繁体中文转换为简体中文
-   **任务管理**: 可视化任务队列管理，支持并发控制和任务恢复
-   **实时日志**: 查看转写进度和详细日志

## 🏗️ 项目架构

```
vtot/
├── apps/
│   ├── desktop/     # Electron 主进程 - 窗口管理、SQLite 持久化、任务调度
│   ├── renderer/    # Next.js 渲染进程 - 现代化 UI 界面
│   └── worker/      # Node.js 子进程 - 协调 Python 引擎执行
├── packages/
│   └── shared/      # Zod schema 和 TypeScript 类型定义
└── engine/          # Python 核心引擎 - WhisperX 转写和 Pyannote 说话人分离
```

## 🛠️ 技术栈

| 层级 | 技术 |
| :--- | :--- |
| **Frontend** | React, Next.js, CSS Modules (BEM), Zod |
| **Backend (Desktop)** | Electron, better-sqlite3 |
| **Engine** | Python 3.13+, WhisperX, Pyannote, OpenCC |
| **DevOps** | pnpm workspaces, uv (Python 依赖管理) |

## 📋 环境要求

-   **Node.js**: v20+
-   **pnpm**: v9+
-   **Python**: 3.13+
-   **uv**: Python 依赖管理工具
-   **FFmpeg**: 音视频处理
-   **CUDA** (可选): GPU 加速（推荐用于 Large 模型）

## 🚀 快速开始

### 1. 克隆仓库

```bash
git clone <repository-url>
cd vtot
```

### 2. 安装 Node.js 依赖

```bash
pnpm install
```

### 3. 初始化 Python 环境

```bash
# 创建虚拟环境
uv venv

# 安装 Python 依赖
uv sync
```

### 4. 配置环境变量

创建 `.env` 文件（可选，用于 Hugging Face Token）：

```bash
VTOT_HF_TOKEN=your_hugging_face_token
```

> **注意**: 说话人分离功能需要 Hugging Face Token，请从 [Hugging Face](https://huggingface.co/settings/tokens) 获取。

### 5. 启动开发环境

```bash
# 一键启动所有服务（推荐）
pnpm run dev
```

或分别启动：

```bash
# 启动 Renderer
pnpm --filter @vtot/renderer dev

# 启动 Desktop (会自动拉起 Worker)
pnpm --filter @vtot/desktop dev
```

## 📖 使用指南

### 创建转写任务

1.  在主界面点击 **"新建任务"**
2.  选择要转写的音视频文件
3.  选择模型规格（推荐 Large-v2 以获得更高精度）
4.  点击 **"开始任务"**

### 查看任务状态

-   **排队中**: 任务等待执行
-   **正在运行**: 任务正在处理
-   **已完成**: 任务成功完成
-   **失败**: 任务执行出错
-   **已取消**: 任务被用户取消

### 导出字幕

任务完成后，字幕文件会自动保存在任务目录 (`%APPDATA%/@vtot/desktop/jobs/<jobId>/exports/`)

## ⚙️ 配置选项

### 应用设置

在 **"应用设置"** 页面可以配置：

-   **Hugging Face Token**: 用于说话人分离模型下载
-   **默认模型规格**: Tiny / Base / Small / Medium / Large / Large-v2 / Large-v3
-   **最大并发任务数**: 1-4

### 模型规格对比

| 模型 | VRAM | 速度 | 精度 |
| :--- | :--- | :--- | :--- |
| Tiny | ~1GB | 极快 | 低 |
| Base | ~1GB | 快 | 较低 |
| Small | ~2GB | 较快 | 中等 |
| Medium | ~5GB | 中等 | 较高 |
| Large | ~10GB | 慢 | 高 |
| Large-v2 | ~10GB | 慢 | 更高 |
| Large-v3 | ~10GB | 慢 | 最高 |

## 🧩 代码规范

-   **CSS**: 遵循 BEM 规则，禁用 `gap` 和 `grid` 布局
-   **TypeScript**: 全量使用，通过 Zod schema 在 IPC 边界进行运行时校验
-   **React**: 使用函数组件
-   **注释**: 代码需要详细注释说明用途

## 🔧 常见问题

### Q: 为什么任务一直卡在"准备中"？

A: 请检查控制台（终端）输出，查看 `[worker]` 开头的日志。可能是模型下载失败或文件权限问题。

### Q: 为什么任务一直"排队中"？

A: 默认并发数为 1。如果有任务正在运行，新任务会排队等待。可以在设置中调整最大并发数。

### Q: 字幕是繁体中文怎么办？

A: 系统已集成 OpenCC，会自动将繁体转换为简体。如果问题仍存在，请确保使用最新版本。

## 📝 许可证

MIT License
