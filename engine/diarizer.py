import sys
import json
import os
import torch
import whisperx

def main():
    """
    VTOT Diarization Engine
    
    用途：
    - 读取 workDir/request.json
    - 使用 pyannote.audio (通过 whisperx 封装) 执行说话人分离
    - 输出 workDir/response.json
    """
    if len(sys.argv) < 2:
        print("Usage: python diarizer.py <workDir>")
        sys.exit(1)

    # 强制设置 stdout 为 UTF-8 编码，防止 Windows 下输出乱码
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

    work_dir = sys.argv[1]
    request_path = os.path.join(work_dir, "request.json")
    response_path = os.path.join(work_dir, "response.json")

    try:
        if not os.path.exists(request_path):
            raise FileNotFoundError(f"Request file not found: {request_path}")

        with open(request_path, 'r', encoding='utf-8') as f:
            request = json.load(f)

        wav_path = request.get("wavPath")
        options = request.get("diarization", {})
        hf_token = request.get("hfToken")

        if not wav_path or not os.path.exists(wav_path):
            raise FileNotFoundError(f"Audio file not found: {wav_path}")

        if not hf_token:
            raise ValueError("Hugging Face Token (hfToken) is required for diarization")

        # 1. 自动选择设备 (CUDA/CPU)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        
        def update_progress(message):
            print(f"[VTOT:STATUS] {message}", flush=True)

        # 2. 初始化 DiarizationPipeline
        update_progress("加载分离模型...")
        diarize_model = whisperx.DiarizationPipeline(use_auth_token=hf_token, device=device)
        
        # 3. 执行分离
        update_progress("正在执行说话人分离...")
        # returns a pandas DataFrame with columns [start, end, speaker]
        diarize_segments = diarize_model(
            wav_path, 
            min_speakers=options.get("minSpeakers"),
            max_speakers=options.get("maxSpeakers")
        )
        
        # 4. 转换结果格式
        turns = []
        for _, row in diarize_segments.iterrows():
            turns.append({
                "speakerId": str(row["speaker"]),
                "startMs": int(row["start"] * 1000),
                "endMs": int(row["end"] * 1000),
                "confidence": None
            })
            
        # 提取唯一的说话人列表
        unique_speaker_ids = sorted(list(set(t["speakerId"] for t in turns)))
        speakers = []
        for i, sid in enumerate(unique_speaker_ids):
            speakers.append({
                "speakerId": sid,
                "displayName": f"Speaker {i+1}"
            })

        response = {
            "protocolVersion": "1.0",
            "command": "diarize",
            "ok": True,
            "result": {
                "speakers": speakers,
                "turns": turns
            }
        }

    except Exception as e:
        response = {
            "protocolVersion": "1.0",
            "command": "diarize",
            "ok": False,
            "error": {
                "code": "E_ENGINE_RUNTIME_ERROR",
                "message": str(e),
                "retryable": True,
                "detail": {
                    "type": type(e).__name__
                }
            }
        }

    # 5. 原子替换写入响应
    tmp_path = response_path + ".tmp"
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(response, f, indent=2, ensure_ascii=False)
    
    # 在 Windows 上 os.replace 是原子的，但在文件被占用时可能会失败
    # 这里我们确保文件写入关闭后再进行替换
    if os.path.exists(response_path):
        os.remove(response_path)
    os.rename(tmp_path, response_path)

if __name__ == "__main__":
    main()
