"""
은혜로운 교회 - Telegram MP3 변환 봇
텔레그램에서 YouTube URL을 보내면 자동으로 MP3 변환 후 알림

사용법:
  텔레그램에서 봇에게 YouTube URL 전송
  예: https://youtu.be/abc123
  예: https://youtu.be/abc123 10:00 30:00  (시작~종료 시간 지정)
  예: https://youtu.be/abc123 10:00 30:00 나의제목  (제목도 지정)
"""

import os
import sys
import re
import json
import time
import shlex
import logging
import requests
import threading
import subprocess
from datetime import datetime

# ============================================================
# Windows 한글 출력 설정
# ============================================================
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    os.environ["PYTHONIOENCODING"] = "utf-8"

# ============================================================
# 설정
# ============================================================
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "여기에_봇_토큰_입력")
API_BASE_URL = os.environ.get("API_BASE_URL", "http://112.223.44.142:9897")
ALLOWED_CHAT_IDS = os.environ.get("ALLOWED_CHAT_IDS", "")  # 빈 값이면 모든 사용자 허용, 콤마로 구분

# --- Claude Code CLI 연동 설정 ---
CLAUDE_CLI = os.environ.get("CLAUDE_CLI", "claude")                      # claude 실행 파일 경로
CLAUDE_WORKDIR = os.environ.get(
    "CLAUDE_WORKDIR",
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))         # 기본: mp3 프로젝트 루트
)
CLAUDE_TIMEOUT = int(os.environ.get("CLAUDE_TIMEOUT", "600"))            # 초 (기본 10분)
# /c, /cc 명령 전용 화이트리스트 — PC에서 명령이 실행되므로 반드시 설정해야 동작 (빈 값이면 거부)
CLAUDE_ALLOWED_CHAT_IDS = os.environ.get("CLAUDE_ALLOWED_CHAT_IDS", "")
CLAUDE_EXTRA_ARGS = os.environ.get("CLAUDE_EXTRA_ARGS", "")              # 예: "--permission-mode acceptEdits"

# ============================================================
# 로깅 설정
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("mp3bot.log", encoding="utf-8"),
        logging.StreamHandler(stream=open(sys.stdout.fileno(), mode='w', encoding='utf-8', closefd=False))
    ]
)
logger = logging.getLogger(__name__)

# ============================================================
# Telegram API 호출
# ============================================================
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"


def send_message(chat_id, text, parse_mode="HTML"):
    """텔레그램 메시지 전송 (parse_mode=None이면 평문 전송)"""
    try:
        payload = {"chat_id": chat_id, "text": text}
        if parse_mode:
            payload["parse_mode"] = parse_mode
        resp = requests.post(f"{TELEGRAM_API}/sendMessage", json=payload, timeout=30)
        return resp.json()
    except Exception as e:
        logger.error(f"메시지 전송 실패: {e}")
        return None


def edit_message(chat_id, message_id, text, parse_mode="HTML"):
    """텔레그램 메시지 수정 (진행상황 업데이트용, parse_mode=None이면 평문)"""
    try:
        payload = {"chat_id": chat_id, "message_id": message_id, "text": text}
        if parse_mode:
            payload["parse_mode"] = parse_mode
        resp = requests.post(f"{TELEGRAM_API}/editMessageText", json=payload, timeout=30)
        return resp.json()
    except Exception as e:
        logger.error(f"메시지 수정 실패: {e}")
        return None


def get_updates(offset=None):
    """텔레그램 업데이트 가져오기 (Long Polling)"""
    params = {"timeout": 30}
    if offset:
        params["offset"] = offset
    try:
        resp = requests.get(f"{TELEGRAM_API}/getUpdates", params=params, timeout=60)
        return resp.json()
    except Exception as e:
        logger.error(f"업데이트 가져오기 실패: {e}")
        return None


# ============================================================
# YouTube URL 파싱
# ============================================================
YOUTUBE_PATTERNS = [
    r'(https?://(?:www\.)?youtube\.com/watch\?[^\s]+)',
    r'(https?://youtu\.be/[\w-]+(?:\?[^\s]*)?)',
    r'(https?://(?:www\.)?youtube\.com/shorts/[\w-]+(?:\?[^\s]*)?)',
    r'(https?://(?:m\.)?youtube\.com/watch\?[^\s]+)',
]


def extract_youtube_url(text):
    """텍스트에서 YouTube URL 추출"""
    for pattern in YOUTUBE_PATTERNS:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return None


def parse_message(text):
    """
    메시지 파싱
    형식 1: URL만
    형식 2: URL,시작시간,종료시간
    형식 3: URL,시작시간,종료시간,제목
    형식 4: URL 시작시간 종료시간 (공백 구분도 호환)
    """
    url = extract_youtube_url(text)
    if not url:
        return None

    start = ""
    end = ""
    title = ""
    time_pattern = r'^\d{1,2}:\d{2}(:\d{2})?$'

    # URL 제거 후 나머지 파싱
    remaining = text.replace(url, "").strip()

    # 콤마가 있으면 콤마 구분자 우선
    if "," in remaining:
        # 앞뒤 콤마 제거 후 분리
        remaining = remaining.strip(",").strip()
        parts = [p.strip() for p in remaining.split(",")]

        if len(parts) >= 2 and re.match(time_pattern, parts[0]) and re.match(time_pattern, parts[1]):
            start = parts[0]
            end = parts[1]
            if len(parts) >= 3:
                title = ",".join(parts[2:]).strip()
        elif len(parts) == 1:
            if not re.match(time_pattern, parts[0]):
                title = parts[0]
    else:
        # 공백 구분 (기존 호환)
        parts = remaining.split() if remaining else []

        if len(parts) >= 2:
            if re.match(time_pattern, parts[0]) and re.match(time_pattern, parts[1]):
                start = parts[0]
                end = parts[1]
                if len(parts) >= 3:
                    title = " ".join(parts[2:])
        elif len(parts) == 1:
            if not re.match(time_pattern, parts[0]):
                title = parts[0]

    return {
        "url": url,
        "start": start,
        "end": end,
        "title": title
    }


# ============================================================
# MP3 변환 처리
# ============================================================
def convert_mp3(chat_id, params):
    """MP3 변환 요청 및 진행상황 모니터링"""
    url = params["url"]
    start = params.get("start", "")
    end = params.get("end", "")
    title = params.get("title", "")

    # 시작 메시지
    time_info = ""
    if start and end:
        time_info = f"\n⏱ 구간: {start} ~ {end}"
    if title:
        time_info += f"\n📝 제목: {title}"

    status_msg = send_message(
        chat_id,
        f"🎵 <b>MP3 변환 시작</b>\n"
        f"🔗 {url}{time_info}\n\n"
        f"⏳ 변환 준비 중..."
    )
    status_message_id = status_msg["result"]["message_id"] if status_msg and status_msg.get("result") else None

    try:
        # 1단계: 변환 요청
        logger.info(f"변환 요청: {url} (start={start}, end={end}, title={title})")
        resp = requests.post(f"{API_BASE_URL}/api/convert", json={
            "url": url,
            "start": start,
            "end": end,
            "title": title
        }, timeout=30)

        data = resp.json()
        logger.info(f"변환 응답: {data}")

        if not data.get("success") or not data.get("jobId"):
            error_msg = data.get("error", "알 수 없는 오류")
            send_message(chat_id, f"❌ <b>변환 실패</b>\n{error_msg}")
            return

        job_id = data["jobId"]

        # 2단계: SSE로 진행상황 모니터링
        logger.info(f"진행상황 모니터링 시작: {job_id}")
        monitor_progress(chat_id, status_message_id, job_id, url)

    except requests.exceptions.ConnectionError:
        send_message(chat_id, "❌ <b>서버 연결 실패</b>\nMP3 변환 서버에 연결할 수 없습니다.")
    except Exception as e:
        logger.error(f"변환 오류: {e}")
        send_message(chat_id, f"❌ <b>오류 발생</b>\n{str(e)}")


def monitor_progress(chat_id, status_message_id, job_id, url):
    """SSE로 변환 진행상황 모니터링 (실패 시 폴링 대체)"""
    last_update_text = ""
    sse_failed = False
    completed = False

    # 변환 전 파일 목록 저장 (폴링 대비)
    try:
        before_resp = requests.get(f"{API_BASE_URL}/api/files", timeout=10)
        before_data = before_resp.json()
        before_files = set(f["fileName"] for f in before_data.get("files", []))
    except Exception:
        before_files = set()

    try:
        resp = requests.get(
            f"{API_BASE_URL}/api/progress/{job_id}",
            stream=True,
            timeout=600,
            headers={"Accept": "text/event-stream"}
        )
        resp.encoding = "utf-8"
        logger.info(f"SSE 연결 성공 (status={resp.status_code})")

        # iter_lines 대신 chunk 기반으로 읽기 (버퍼링 문제 방지)
        buffer = ""
        for chunk in resp.iter_content(chunk_size=1, decode_unicode=True):
            if chunk is None:
                continue
            buffer += chunk

            # 줄바꿈이 올 때마다 처리
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()

                if not line or not line.startswith("data:"):
                    continue

                try:
                    raw_data = line[5:].strip()
                    event_data = json.loads(raw_data)
                    event_type = event_data.get("type", "")
                    logger.info(f"SSE 이벤트: type={event_type}, progress={event_data.get('progress', '-')}")

                    if event_type in ("progress", "started", "connected"):
                        progress = event_data.get("progress", 0)
                        message = event_data.get("message", "진행 중...")
                        bar = make_progress_bar(progress)

                        update_text = (
                            f"🎵 <b>MP3 변환 중</b>\n"
                            f"🔗 {url}\n\n"
                            f"{bar} {progress}%\n"
                            f"📌 {message}"
                        )

                        if update_text != last_update_text and status_message_id:
                            edit_message(chat_id, status_message_id, update_text)
                            last_update_text = update_text

                    elif event_type == "completed":
                        handle_completed(chat_id, status_message_id, event_data)
                        completed = True
                        return

                    elif event_type == "error":
                        error_msg = event_data.get("message", "알 수 없는 오류")
                        send_message(chat_id, f"❌ <b>변환 실패</b>\n{error_msg}")
                        logger.error(f"변환 실패: {error_msg}")
                        completed = True
                        return

                except json.JSONDecodeError as e:
                    logger.warning(f"JSON 파싱 실패: {e} / 원본: {line}")
                    continue

    except requests.exceptions.Timeout:
        logger.warning("SSE 타임아웃")
    except Exception as e:
        logger.warning(f"SSE 연결 오류: {e}")

    # SSE가 완료 이벤트 없이 끝난 경우 → 폴링으로 전환
    if not completed:
        logger.info("SSE 스트림 종료됨, 폴링으로 전환")
        if status_message_id:
            edit_message(chat_id, status_message_id,
                f"🎵 <b>MP3 변환 중</b>\n"
                f"🔗 {url}\n\n"
                f"⏳ 변환 진행 중... 완료되면 알려드릴게요."
            )
        poll_for_completion(chat_id, status_message_id, job_id, before_files)


def poll_for_completion(chat_id, status_message_id, job_id, before_files=None):
    """SSE 실패 시 파일 목록을 주기적으로 확인하여 완료 감지"""
    logger.info(f"폴링 모드로 완료 대기: {job_id}")
    max_wait = 600  # 최대 10분
    interval = 10   # 10초 간격
    elapsed = 0

    if before_files is None:
        try:
            before_resp = requests.get(f"{API_BASE_URL}/api/files", timeout=10)
            before_data = before_resp.json()
            before_files = set(f["fileName"] for f in before_data.get("files", []))
        except Exception:
            before_files = set()

    while elapsed < max_wait:
        time.sleep(interval)
        elapsed += interval

        try:
            resp = requests.get(f"{API_BASE_URL}/api/files", timeout=10)
            data = resp.json()
            current_files = data.get("files", [])
            current_names = set(f["fileName"] for f in current_files)

            # 새 파일 감지
            new_files = current_names - before_files
            if new_files:
                new_file_name = list(new_files)[0]
                new_file = next(f for f in current_files if f["fileName"] == new_file_name)

                event_data = {
                    "fileName": new_file["fileName"],
                    "fileSize": new_file.get("fileSize", 0),
                    "downloadUrl": new_file.get("downloadUrl", "")
                }
                handle_completed(chat_id, status_message_id, event_data)
                return

        except Exception as e:
            logger.warning(f"폴링 확인 오류: {e}")

    send_message(chat_id, "⏰ <b>대기 시간 초과</b>\n/list 로 파일 목록을 확인해주세요.")


def handle_completed(chat_id, status_message_id, event_data):
    """변환 완료 처리 (공통)"""
    file_name = event_data.get("fileName", "unknown.mp3")
    file_size = event_data.get("fileSize", 0)
    download_url = event_data.get("downloadUrl", "")
    size_mb = file_size / 1024 / 1024

    if download_url and not download_url.startswith("http"):
        download_url = f"{API_BASE_URL}{download_url}"

    # 완료 알림은 server.js의 notifyTelegram이 단일 진실 공급원으로 발송하므로 봇은 발송하지 않음
    # (중복 메시지 방지). 진행 메시지만 in-place로 정리.
    # send_message(
    #     chat_id,
    #     f"✅ <b>변환 완료!</b>\n\n"
    #     f"📁 파일: {file_name}\n"
    #     f"📦 크기: {size_mb:.1f} MB\n"
    #     f"🔗 <a href=\"{download_url}\">다운로드 링크</a>\n\n"
    #     f"🕐 {datetime.now().strftime('%H:%M:%S')}"
    # )

    if status_message_id:
        edit_message(chat_id, status_message_id, f"✅ 변환 완료: {file_name}")

    logger.info(f"변환 완료: {file_name} ({size_mb:.1f}MB)")


def make_progress_bar(percent):
    """텍스트 프로그레스 바 생성"""
    filled = int(percent / 10)
    empty = 10 - filled
    return "▓" * filled + "░" * empty


# ============================================================
# Claude Code CLI 연동 (/c, /cc)
# ============================================================
def claude_allowed(chat_id):
    """Claude 명령 허용 여부 — 화이트리스트가 비어있으면 무조건 거부 (PC 명령 실행 통로이므로)"""
    if not CLAUDE_ALLOWED_CHAT_IDS:
        return False
    try:
        allowed = [int(x.strip()) for x in CLAUDE_ALLOWED_CHAT_IDS.split(",") if x.strip()]
    except ValueError:
        return False
    return chat_id in allowed


def run_claude(chat_id, prompt, continue_session=False):
    """claude -p 헤드리스 실행 후 결과를 텔레그램으로 전송 (별도 스레드에서 호출)"""
    mode = "이어서" if continue_session else "새 대화"
    status = send_message(chat_id, f"🤖 Claude 작업 중 ({mode})... 최대 {CLAUDE_TIMEOUT // 60}분", parse_mode=None)
    status_id = status["result"]["message_id"] if status and status.get("result") else None

    cmd = [CLAUDE_CLI, "-p"]
    if continue_session:
        cmd.append("--continue")
    if CLAUDE_EXTRA_ARGS:
        cmd.extend(shlex.split(CLAUDE_EXTRA_ARGS))
    cmd.append(prompt)

    logger.info(f"Claude 실행: continue={continue_session}, prompt={prompt[:80]}")
    try:
        result = subprocess.run(
            cmd,
            cwd=CLAUDE_WORKDIR,
            capture_output=True,
            stdin=subprocess.DEVNULL,  # stdin 닫고 실행 — "no stdin data" 경고 및 3초 대기 제거
            encoding="utf-8",
            errors="replace",
            timeout=CLAUDE_TIMEOUT,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"}
        )
        output = (result.stdout or "").strip()
        if not output:
            err = (result.stderr or "").strip()
            output = f"⚠️ Claude 응답이 비었습니다 (코드 {result.returncode})" + (f"\n{err[:800]}" if err else "")
    except subprocess.TimeoutExpired:
        output = f"⏰ 시간 초과 ({CLAUDE_TIMEOUT}초). 작업을 더 작게 나눠서 요청해 주세요."
    except FileNotFoundError:
        output = f"❌ claude CLI를 찾을 수 없습니다: {CLAUDE_CLI}\nCLAUDE_CLI 환경변수를 확인하세요."
    except Exception as e:
        output = f"❌ Claude 실행 오류: {e}"

    logger.info(f"Claude 응답 길이: {len(output)}자")

    # 응답 전송: 4000자 단위 분할, 최대 3개 메시지 (평문 — 마크다운/HTML 파싱 오류 방지)
    MAX_LEN = 4000
    chunks = [output[i:i + MAX_LEN] for i in range(0, len(output), MAX_LEN)]
    if len(chunks) > 3:
        chunks = chunks[:3]
        chunks[-1] += "\n\n…(응답이 길어 이하 생략)"

    if status_id:
        edit_message(chat_id, status_id, f"🤖 Claude 응답 ({mode}):", parse_mode=None)
    for c in chunks:
        send_message(chat_id, c, parse_mode=None)


# ============================================================
# 명령어 처리
# ============================================================
def handle_message(message):
    """수신 메시지 처리"""
    chat_id = message["chat"]["id"]
    text = message.get("text", "")
    user_name = message["from"].get("first_name", "사용자")

    # 허용된 사용자 확인
    if ALLOWED_CHAT_IDS:
        allowed = [int(x.strip()) for x in ALLOWED_CHAT_IDS.split(",") if x.strip()]
        if chat_id not in allowed:
            send_message(chat_id, "⛔ 권한이 없습니다.")
            return

    logger.info(f"메시지 수신: [{chat_id}] {user_name}: {text}")

    # /start 명령어
    if text.startswith("/start"):
        send_message(
            chat_id,
            f"🎵 <b>은혜로운 교회 MP3 변환 봇</b>\n\n"
            f"안녕하세요, {user_name}님!\n\n"
            f"<b>사용법:</b>\n"
            f"1️⃣ YouTube URL만 전송\n"
            f"<code>https://youtu.be/abc123</code>\n\n"
            f"2️⃣ URL,시작시간,종료시간\n"
            f"<code>https://youtu.be/abc123,10:00,30:00</code>\n\n"
            f"3️⃣ URL,시간,시간,제목\n"
            f"<code>https://youtu.be/abc123,10:00,30:00,주일설교</code>\n\n"
            f"<b>명령어:</b>\n"
            f"/list - 변환된 파일 목록\n"
            f"/help - 도움말\n"
            f"/status - 서버 상태 확인\n"
            f"/c 질문 - Claude에게 새 작업/질문\n"
            f"/cc 질문 - 직전 Claude 대화 이어가기"
        )
        return

    # /help 명령어
    if text.startswith("/help"):
        send_message(
            chat_id,
            "📖 <b>도움말</b>\n\n"
            "• YouTube URL을 보내면 자동으로 MP3 변환\n"
            "• 시간 형식: <code>MM:SS</code> 또는 <code>HH:MM:SS</code>\n"
            "• 시간을 지정하지 않으면 전체 영상 변환\n"
            "• 변환 완료 시 다운로드 링크 제공\n\n"
            "💡 <b>팁:</b> 다른 앱을 사용해도 변환은 계속 진행됩니다!"
        )
        return

    # /list 명령어
    if text.startswith("/list"):
        try:
            resp = requests.get(f"{API_BASE_URL}/api/files", timeout=10)
            data = resp.json()
            if data.get("success") and data.get("files"):
                files = data["files"][:10]  # 최근 10개
                file_list = "\n".join([
                    f"📁 {f['fileName'][:30]}... ({f['fileSize']/1024/1024:.1f}MB)"
                    for f in files
                ])
                send_message(
                    chat_id,
                    f"📋 <b>최근 변환 파일 (최대 10개)</b>\n\n{file_list}"
                )
            else:
                send_message(chat_id, "📋 변환된 파일이 없습니다.")
        except Exception as e:
            send_message(chat_id, f"❌ 파일 목록 조회 실패: {e}")
        return

    # /c, /cc 명령어 — Claude Code CLI 연동
    m_claude = re.match(r'^/(cc|c)(?:\s+(.*))?$', text, re.DOTALL)
    if m_claude:
        if not claude_allowed(chat_id):
            send_message(chat_id, "⛔ Claude 명령 권한이 없습니다. (CLAUDE_ALLOWED_CHAT_IDS 설정 필요)")
            return
        prompt = (m_claude.group(2) or "").strip()
        if not prompt:
            send_message(
                chat_id,
                "🤖 <b>Claude 사용법</b>\n\n"
                "<code>/c 질문이나 작업</code> — 새 대화\n"
                "<code>/cc 이어지는 질문</code> — 직전 대화 이어가기\n\n"
                "예: <code>/c 서버 상태 요약해줘</code>"
            )
            return
        continue_session = m_claude.group(1) == "cc"
        thread = threading.Thread(target=run_claude, args=(chat_id, prompt, continue_session))
        thread.daemon = True
        thread.start()
        return

    # /status 명령어
    if text.startswith("/status"):
        try:
            resp = requests.get(f"{API_BASE_URL}/api/files", timeout=5)
            if resp.status_code == 200:
                send_message(chat_id, "✅ <b>서버 상태: 정상</b>")
            else:
                send_message(chat_id, f"⚠️ <b>서버 응답 이상</b> (코드: {resp.status_code})")
        except Exception:
            send_message(chat_id, "❌ <b>서버 연결 불가</b>")
        return

    # YouTube URL 감지
    parsed = parse_message(text)
    if parsed:
        # 변환을 별도 스레드에서 실행 (봇이 멈추지 않도록)
        thread = threading.Thread(target=convert_mp3, args=(chat_id, parsed))
        thread.daemon = True
        thread.start()
        return

    # 인식 못하는 메시지
    if text and not text.startswith("/"):
        send_message(
            chat_id,
            "🤔 YouTube URL을 인식하지 못했습니다.\n\n"
            "예시: <code>https://youtu.be/VIDEO_ID</code>\n"
            "/help 로 사용법을 확인하세요."
        )


# ============================================================
# 메인 루프 (Long Polling)
# ============================================================
def main():
    logger.info("=" * 50)
    logger.info("은혜로운 교회 MP3 변환 봇 시작")
    logger.info(f"API 서버: {API_BASE_URL}")
    logger.info("=" * 50)

    # 봇 정보 확인
    try:
        resp = requests.get(f"{TELEGRAM_API}/getMe", timeout=10)
        bot_info = resp.json()
        if bot_info.get("ok"):
            bot_name = bot_info["result"]["username"]
            logger.info(f"봇 연결 성공: @{bot_name}")
        else:
            logger.error(f"봇 토큰 오류: {bot_info}")
            return
    except Exception as e:
        logger.error(f"봇 연결 실패: {e}")
        return

    offset = None

    while True:
        try:
            updates = get_updates(offset)

            if updates and updates.get("ok"):
                for update in updates.get("result", []):
                    offset = update["update_id"] + 1

                    if "message" in update and "text" in update["message"]:
                        handle_message(update["message"])

        except KeyboardInterrupt:
            logger.info("봇 종료")
            break
        except Exception as e:
            logger.error(f"메인 루프 오류: {e}")
            time.sleep(5)  # 오류 시 5초 대기 후 재시도


if __name__ == "__main__":
    main()