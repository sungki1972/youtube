"""
칠암(Chilam) - Telegram Claude Code 봇
텔레그램에서 Claude Code CLI를 헤드리스로 실행하는 전용 봇

사용법:
  일반 텍스트        → 직전 대화 이어가기 (첫 메시지면 새 대화)
  /new 질문 (또는 /c) → 새 대화 시작
  /help              → 도움말

보안:
  CLAUDE_ALLOWED_CHAT_IDS 화이트리스트에 있는 사용자만 사용 가능 (빈 값이면 전부 거부)
"""

import os
import sys
import re
import shlex
import logging
import requests
import threading
import subprocess

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
BOT_TOKEN = os.environ.get("CLAUDE_BOT_TOKEN", "")
CLAUDE_CLI = os.environ.get("CLAUDE_CLI", "claude")
CLAUDE_WORKDIR = os.environ.get(
    "CLAUDE_WORKDIR",
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 기본: mp3 프로젝트 루트
)
CLAUDE_TIMEOUT = int(os.environ.get("CLAUDE_TIMEOUT", "600"))
CLAUDE_ALLOWED_CHAT_IDS = os.environ.get("CLAUDE_ALLOWED_CHAT_IDS", "")  # 필수 (빈 값 = 전부 거부)
CLAUDE_EXTRA_ARGS = os.environ.get("CLAUDE_EXTRA_ARGS", "")

# ============================================================
# 로깅
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("claudebot.log", encoding="utf-8"),
        logging.StreamHandler(stream=open(sys.stdout.fileno(), mode='w', encoding='utf-8', closefd=False))
    ]
)
logger = logging.getLogger(__name__)

TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

# 채팅별 "대화 시작됨" 여부 (첫 메시지는 새 대화, 이후 평문은 이어가기)
session_started = {}


def send_message(chat_id, text, parse_mode=None):
    """텔레그램 메시지 전송 (기본 평문 — Claude 응답의 특수문자 파싱 오류 방지)"""
    try:
        payload = {"chat_id": chat_id, "text": text}
        if parse_mode:
            payload["parse_mode"] = parse_mode
        resp = requests.post(f"{TELEGRAM_API}/sendMessage", json=payload, timeout=30)
        return resp.json()
    except Exception as e:
        logger.error(f"메시지 전송 실패: {e}")
        return None


def edit_message(chat_id, message_id, text):
    try:
        requests.post(f"{TELEGRAM_API}/editMessageText", json={
            "chat_id": chat_id, "message_id": message_id, "text": text
        }, timeout=30)
    except Exception as e:
        logger.error(f"메시지 수정 실패: {e}")


def get_updates(offset=None):
    params = {"timeout": 30}
    if offset:
        params["offset"] = offset
    try:
        resp = requests.get(f"{TELEGRAM_API}/getUpdates", params=params, timeout=60)
        return resp.json()
    except Exception as e:
        logger.error(f"업데이트 가져오기 실패: {e}")
        return None


def is_allowed(chat_id):
    if not CLAUDE_ALLOWED_CHAT_IDS:
        return False
    try:
        allowed = [int(x.strip()) for x in CLAUDE_ALLOWED_CHAT_IDS.split(",") if x.strip()]
    except ValueError:
        return False
    return chat_id in allowed


def run_claude_cmd(prompt, continue_session):
    """claude -p 실행. (returncode, output) 반환"""
    cmd = [CLAUDE_CLI, "-p"]
    if continue_session:
        cmd.append("--continue")
    if CLAUDE_EXTRA_ARGS:
        cmd.extend(shlex.split(CLAUDE_EXTRA_ARGS))
    cmd.append(prompt)
    result = subprocess.run(
        cmd, cwd=CLAUDE_WORKDIR, capture_output=True,
        stdin=subprocess.DEVNULL,  # stdin 닫고 실행 — "no stdin data received in 3s" 경고 및 3초 대기 제거
        encoding="utf-8", errors="replace", timeout=CLAUDE_TIMEOUT,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"}
    )
    output = (result.stdout or "").strip()
    if not output:
        err = (result.stderr or "").strip()
        output = err[:1000] if err else ""
    return result.returncode, output


def run_claude(chat_id, prompt, force_new=False):
    """Claude 실행 후 결과 전송 (별도 스레드에서 호출)"""
    continue_session = (not force_new) and session_started.get(chat_id, False)
    mode = "이어서" if continue_session else "새 대화"
    status = send_message(chat_id, f"🤖 Claude 작업 중 ({mode})... 최대 {CLAUDE_TIMEOUT // 60}분")
    status_id = status["result"]["message_id"] if status and status.get("result") else None

    # 1분마다 경과 시간 갱신 (오래 걸릴 때 진행 여부 확인용)
    stop_ticker = threading.Event()

    def ticker():
        elapsed = 0
        while not stop_ticker.wait(60):
            elapsed += 1
            if status_id:
                edit_message(chat_id, status_id,
                             f"🤖 Claude 작업 중 ({mode})... {elapsed}분 경과 / 최대 {CLAUDE_TIMEOUT // 60}분")

    threading.Thread(target=ticker, daemon=True).start()

    logger.info(f"Claude 실행: continue={continue_session}, prompt={prompt[:80]}")
    try:
        code, output = run_claude_cmd(prompt, continue_session)
        # 이어가기 실패(이전 세션 없음 등) 시 새 대화로 1회 재시도
        if continue_session and code != 0:
            logger.warning(f"--continue 실패(코드 {code}), 새 대화로 재시도")
            code, output = run_claude_cmd(prompt, False)
            mode = "새 대화"
        if code != 0 and not output:
            output = f"⚠️ Claude 실행 오류 (코드 {code})"
        session_started[chat_id] = True
    except subprocess.TimeoutExpired:
        output = f"⏰ 시간 초과 ({CLAUDE_TIMEOUT}초). 작업을 더 작게 나눠서 요청해 주세요."
    except FileNotFoundError:
        output = f"❌ claude CLI를 찾을 수 없습니다: {CLAUDE_CLI}"
    except Exception as e:
        output = f"❌ Claude 실행 오류: {e}"
    finally:
        stop_ticker.set()

    logger.info(f"Claude 응답 길이: {len(output)}자")

    # 4000자 단위 분할, 최대 3개 메시지
    MAX_LEN = 4000
    chunks = [output[i:i + MAX_LEN] for i in range(0, len(output), MAX_LEN)] or ["(응답 없음)"]
    if len(chunks) > 3:
        chunks = chunks[:3]
        chunks[-1] += "\n\n…(응답이 길어 이하 생략)"

    if status_id:
        edit_message(chat_id, status_id, f"🤖 Claude 응답 ({mode}):")
    for c in chunks:
        send_message(chat_id, c)


HELP_TEXT = (
    "🤖 칠암 Claude 봇\n\n"
    "• 그냥 메시지를 보내면 → 직전 대화를 이어갑니다\n"
    "• /new 질문 → 새 대화 시작\n"
    "• /help → 이 도움말\n\n"
    "Claude는 설교 관리 시스템(mp3) 프로젝트 폴더에서 실행되어\n"
    "서버 상태 확인, 코드 질문, 파일 분석 등을 할 수 있습니다."
)


def handle_message(message):
    chat_id = message["chat"]["id"]
    text = (message.get("text", "") or "").strip()
    user_name = message["from"].get("first_name", "사용자")

    if not is_allowed(chat_id):
        send_message(chat_id, f"⛔ 권한이 없습니다. (chat_id: {chat_id})")
        logger.warning(f"미허용 사용자 접근: {chat_id} ({user_name})")
        return

    logger.info(f"메시지 수신: [{chat_id}] {user_name}: {text[:100]}")

    if not text:
        return

    if text.startswith("/start") or text.startswith("/help"):
        send_message(chat_id, HELP_TEXT)
        return

    # /new 질문 (또는 /c 질문) → 새 대화
    m = re.match(r'^/(new|c)(?:\s+(.*))?$', text, re.DOTALL)
    if m:
        prompt = (m.group(2) or "").strip()
        if not prompt:
            send_message(chat_id, "사용법: /new 질문이나 작업 내용")
            return
        threading.Thread(target=run_claude, args=(chat_id, prompt, True), daemon=True).start()
        return

    # 그 외 명령어는 무시
    if text.startswith("/"):
        send_message(chat_id, "알 수 없는 명령입니다. /help 를 확인하세요.")
        return

    # 일반 텍스트 → 대화 이어가기 (첫 메시지면 새 대화)
    threading.Thread(target=run_claude, args=(chat_id, text, False), daemon=True).start()


def main():
    logger.info("=" * 50)
    logger.info("칠암 Claude 봇 시작")
    logger.info(f"작업 폴더: {CLAUDE_WORKDIR}")
    logger.info("=" * 50)

    if not BOT_TOKEN:
        logger.error("CLAUDE_BOT_TOKEN이 설정되지 않았습니다. ecosystem.config.js를 확인하세요.")
        return
    if not CLAUDE_ALLOWED_CHAT_IDS:
        logger.error("CLAUDE_ALLOWED_CHAT_IDS가 비어 있습니다. 보안상 봇을 시작하지 않습니다.")
        return

    try:
        resp = requests.get(f"{TELEGRAM_API}/getMe", timeout=10)
        bot_info = resp.json()
        if bot_info.get("ok"):
            logger.info(f"봇 연결 성공: @{bot_info['result']['username']}")
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
            import time
            time.sleep(5)


if __name__ == "__main__":
    main()
