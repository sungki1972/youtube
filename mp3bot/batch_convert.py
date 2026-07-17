"""
은혜로운 교회 - YouTube MP3 일괄 변환 스크립트
여러 YouTube URL을 한번에 변환

사용법:
  python batch_convert.py
  python batch_convert.py urls.txt
"""

import sys
import json
import time
import requests

# ============================================================
# 설정
# ============================================================
API_BASE_URL = "http://112.223.44.142:9897"

# 변환할 YouTube URL 목록 (직접 입력)
# urls.txt 파일이 있으면 파일에서 읽음
DEFAULT_URLS = [
    # 형식: (URL, 시작시간, 종료시간, 제목)
    # 시작/종료 시간과 제목은 빈 문자열이면 전체 영상/자동 제목
    ("https://youtu.be/VIDEO_ID_1", "", "", ""),
    ("https://youtu.be/VIDEO_ID_2", "10:00", "30:00", "주일설교"),
    ("https://youtu.be/VIDEO_ID_3", "0:00", "45:00", "수요예배"),
]


def convert_one(url, start="", end="", title=""):
    """URL 하나 변환"""
    print(f"\n{'='*60}")
    print(f"🎵 변환 시작: {url}")
    if start and end:
        print(f"   구간: {start} ~ {end}")
    if title:
        print(f"   제목: {title}")
    print(f"{'='*60}")

    # 1단계: 변환 요청
    try:
        resp = requests.post(f"{API_BASE_URL}/api/convert", json={
            "url": url,
            "start": start,
            "end": end,
            "title": title
        }, timeout=30)
        data = resp.json()
    except Exception as e:
        print(f"❌ 요청 실패: {e}")
        return False

    if not data.get("success") or not data.get("jobId"):
        print(f"❌ 변환 실패: {data.get('error', '알 수 없는 오류')}")
        return False

    job_id = data["jobId"]
    print(f"   Job ID: {job_id}")

    # 2단계: SSE로 진행상황 모니터링
    try:
        resp = requests.get(
            f"{API_BASE_URL}/api/progress/{job_id}",
            stream=True,
            timeout=600
        )

        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue

            try:
                event = json.loads(line[5:].strip())
                etype = event.get("type", "")

                if etype == "progress":
                    progress = event.get("progress", 0)
                    msg = event.get("message", "")
                    bar = "▓" * int(progress / 10) + "░" * (10 - int(progress / 10))
                    print(f"\r   {bar} {progress:3.0f}% - {msg}", end="", flush=True)

                elif etype == "completed":
                    file_name = event.get("fileName", "")
                    file_size = event.get("fileSize", 0)
                    print(f"\n✅ 완료: {file_name} ({file_size/1024/1024:.1f}MB)")
                    return True

                elif etype == "error":
                    print(f"\n❌ 오류: {event.get('message', '')}")
                    return False

            except json.JSONDecodeError:
                continue

    except Exception as e:
        print(f"\n❌ 모니터링 오류: {e}")
        return False

    return False


def load_urls_from_file(filepath):
    """텍스트 파일에서 URL 목록 읽기 (콤마 구분)"""
    urls = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split(",")
            url = parts[0].strip()
            start = parts[1].strip() if len(parts) > 1 else ""
            end = parts[2].strip() if len(parts) > 2 else ""
            title = parts[3].strip() if len(parts) > 3 else ""
            urls.append((url, start, end, title))

    return urls


def main():
    print("🎵 은혜로운 교회 - MP3 일괄 변환")
    print(f"   서버: {API_BASE_URL}")
    print()

    # URL 목록 결정
    if len(sys.argv) > 1:
        filepath = sys.argv[1]
        print(f"📄 파일에서 URL 읽기: {filepath}")
        urls = load_urls_from_file(filepath)
    else:
        urls = DEFAULT_URLS

    if not urls:
        print("변환할 URL이 없습니다.")
        return

    print(f"📋 총 {len(urls)}개 변환 예정\n")

    # 일괄 변환
    success = 0
    fail = 0

    for i, (url, start, end, title) in enumerate(urls, 1):
        print(f"\n[{i}/{len(urls)}]")
        if convert_one(url, start, end, title):
            success += 1
        else:
            fail += 1

        # 다음 변환 전 잠시 대기
        if i < len(urls):
            print("\n⏳ 3초 후 다음 변환...")
            time.sleep(3)

    # 결과 요약
    print(f"\n{'='*60}")
    print(f"📊 변환 결과: 성공 {success}개 / 실패 {fail}개 / 총 {len(urls)}개")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()