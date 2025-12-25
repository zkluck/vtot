import sys
import json
import os
import torch
import whisperx
import gc

def main():
    """
    VTOT Transcription Engine
    
    用途：
    - 读取 workDir/request.json
    - 使用 whisperx 执行转写和单词级时间戳对齐
    - 输出 workDir/response.json
    - 支持进度汇报 (progress.json) 和 取消标志 (cancel.flag)
    """
    if len(sys.argv) < 2:
        print("Usage: python transcriber.py <workDir>")
        sys.exit(1)

    # 强制设置 stdout 为 UTF-8 编码，防止 Windows 下输出乱码
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

    work_dir = sys.argv[1]
    request_path = os.path.join(work_dir, "request.json")
    response_path = os.path.join(work_dir, "response.json")
    progress_path = os.path.join(work_dir, "progress.json")
    cancel_flag_path = os.path.join(work_dir, "cancel.flag")

    def update_progress(percent, message):
        try:
            # 同时也通过 stdout 输出，方便 Worker 实时捕获
            print(f"[VTOT:STATUS] {message}", flush=True)
            with open(progress_path, 'w', encoding='utf-8') as f:
                json.dump({"percent": percent, "message": message}, f, ensure_ascii=False)
        except:
            pass

    def check_cancel():
        if os.path.exists(cancel_flag_path):
            raise InterruptedError("Job canceled by user")

    try:
        update_progress(0, "引擎启动中")
        
        if not os.path.exists(request_path):
            raise FileNotFoundError(f"Request file not found: {request_path}")

        with open(request_path, 'r', encoding='utf-8') as f:
            request = json.load(f)

        wav_path = request.get("wavPath")
        options = request.get("options", {})
        hf_token = request.get("hfToken")
        
        language = options.get("language", "zh")
        if language == "auto":
            language = None
            
        model_size = options.get("modelSize", "medium")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float32" # CPU 场景通常不支持 float16

        if not wav_path or not os.path.exists(wav_path):
            raise FileNotFoundError(f"Audio file not found: {wav_path}")

        check_cancel()

        # 1. 转写阶段
        update_progress(10, f"加载模型: {model_size}")
        
        # 优化策略：
        # - 使用更宽松的 VAD 阈值 (0.3)，防止漏掉 quiet speech
        # - 显式指定 silero VAD
        # - 在 CPU 上适当降低 batch_size
        asr_options = {
            "word_timestamps": True,
            "beam_size": 5,
        }
        vad_options = {
            "threshold": 0.3, 
        }

        model = whisperx.load_model(
            model_size, 
            device, 
            compute_type=compute_type, 
            asr_options=asr_options,
            vad_method="silero",
            vad_options=vad_options
        )
        
        check_cancel()
        update_progress(30, "正在转写音频...")
        audio = whisperx.load_audio(wav_path)
        result = model.transcribe(audio, batch_size=4, language=language)
        
        # 备份原始转录结果用于对齐失败时的兜底
        original_segments = result["segments"]

        # 释放显存/内存 (由于后面还要加载对齐模型)
        gc.collect()
        if device == "cuda":
            torch.cuda.empty_cache()

        check_cancel()

        # 2. 对齐阶段
        detected_language = result["language"]
        update_progress(60, f"加载对齐模型 ({detected_language})")
        
        try:
            model_a, metadata = whisperx.load_align_model(language_code=detected_language, device=device)
            
            check_cancel()
            update_progress(80, "执行单词级时间戳对齐...")
            aligned_result = whisperx.align(result["segments"], model_a, metadata, audio, device, return_char_alignments=False)
            
            # 只有在对齐结果不为空时才替换
            if aligned_result and aligned_result.get("segments"):
                result = aligned_result
            else:
                print("Warning: alignment returned empty segments, using original results.")
        except Exception as align_err:
            print(f"Warning: alignment failed ({str(align_err)}), falling back to original segments.")
            # 对齐失败则保留原始转写结果（只有段落时间戳，没有词级）
            pass
        
        check_cancel()

        # 3. 结果处理
        # 这里的 result 结构已经包含了 segments 和 language
        response = {
            "protocolVersion": "1.0",
            "command": "transcribe",
            "ok": True,
            "result": {
                "segments": result["segments"],
                "language": detected_language
            }
        }

    except InterruptedError as e:
        response = {
            "protocolVersion": "1.0",
            "command": "transcribe",
            "ok": False,
            "error": {
                "code": "E_CANCELED",
                "message": str(e),
                "retryable": False
            }
        }
    except Exception as e:
        import traceback
        response = {
            "protocolVersion": "1.0",
            "command": "transcribe",
            "ok": False,
            "error": {
                "code": "E_ENGINE_RUNTIME_ERROR",
                "message": str(e),
                "retryable": True,
                "detail": {
                    "type": type(e).__name__,
                    "traceback": traceback.format_exc()
                }
            }
        }

    # 原子写入响应
    tmp_path = response_path + ".tmp"
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(response, f, indent=2, ensure_ascii=False)
    
    if os.path.exists(response_path):
        os.remove(response_path)
    os.rename(tmp_path, response_path)
    
    update_progress(100, "引擎任务完成")

if __name__ == "__main__":
    main()
