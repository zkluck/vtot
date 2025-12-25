import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { EnvCheckResult } from '@vtot/shared';

const execAsync = promisify(exec);

/**
 * 检查运行环境是否就绪。
 */
export async function checkEnvironment(): Promise<EnvCheckResult> {
  const result: EnvCheckResult = {
    ok: true,
    ffmpeg: false,
    ffprobe: false,
    python: false,
    whisperx: false,
    details: {},
  };

  try {
    // 1. 检查 ffmpeg
    try {
      const { stdout } = await execAsync('ffmpeg -version');
      result.ffmpeg = true;
      result.details.ffmpegVersion = stdout.split('\n')[0];
    } catch (e) {
      result.ok = false;
    }

    // 2. 检查 ffprobe
    try {
      await execAsync('ffprobe -version');
      result.ffprobe = true;
    } catch (e) {
      result.ok = false;
    }

    // 3. 检查 python
    try {
      const { stdout } = await execAsync('python --version');
      result.python = true;
      result.details.pythonVersion = stdout.trim();
    } catch (e) {
      result.ok = false;
    }

    // 4. 检查 whisperx (通过 python 尝试 import)
    if (result.python) {
      try {
        await execAsync('python -c "import whisperx"');
        result.whisperx = true;
      } catch (e) {
        result.ok = false;
      }
    } else {
      result.ok = false;
    }

  } catch (globalErr: any) {
    result.ok = false;
    result.details.error = globalErr.message;
  }

  return result;
}
