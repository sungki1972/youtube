// PM2 설정 예시 파일 - 실제 사용 시 ecosystem.config.js로 복사 후 토큰을 채워 넣으세요.
// (ecosystem.config.js는 봇 토큰이 포함되므로 .gitignore로 커밋에서 제외됨)

const BASE_DIR = "C:\\Users\\neola\\OneDrive\\문서\\cursor\\25\\8\\mp3\\mp3bot";

module.exports = {
  apps: [
    {
      name: "mp3bot",
      script: "telegram_mp3_bot.py",
      interpreter: "python",
      cwd: BASE_DIR,

      env: {
        TELEGRAM_BOT_TOKEN: "여기에_봇_토큰_입력",   // @BotFather에서 발급
        API_BASE_URL: "http://112.223.44.142:9897",
        ALLOWED_CHAT_IDS: "",   // 빈 값 = 모든 사용자 허용. 특정 사용자만: "123456,789012"

        // Claude 연동은 별도 봇(chilambot)으로 이전됨 — 이 봇에서는 비활성(빈 값 = /c 거부)
        CLAUDE_ALLOWED_CHAT_IDS: ""
      },

      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,

      log_file: BASE_DIR + "\\logs\\mp3bot.log",
      error_file: BASE_DIR + "\\logs\\mp3bot-error.log",
      out_file: BASE_DIR + "\\logs\\mp3bot-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      max_memory_restart: "500M",
      watch: false
    },

    // ============================================
    // 칠암 Claude 봇 (텔레그램 → Claude Code CLI)
    // ============================================
    {
      name: "chilambot",
      script: "claude_bot.py",
      interpreter: "python",
      cwd: BASE_DIR,

      env: {
        CLAUDE_BOT_TOKEN: "여기에_chilam_봇_토큰_입력",   // @BotFather에서 발급
        CLAUDE_CLI: "C:\\Users\\neola\\.local\\bin\\claude.exe",  // PM2 PATH 문제 회피용 절대 경로
        CLAUDE_WORKDIR: "C:\\Users\\neola\\OneDrive\\문서\\cursor\\25\\8\\mp3",
        CLAUDE_ALLOWED_CHAT_IDS: "여기에_본인_chat_id",  // 화이트리스트 (필수 — 빈 값이면 봇이 시작 거부)
        CLAUDE_TIMEOUT: "1800",                // 초 (30분 — 에이전트 활용 작업 대비)
        CLAUDE_EXTRA_ARGS: ""                  // 예: "--dangerously-skip-permissions --append-system-prompt \"...\""
      },

      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,

      log_file: BASE_DIR + "\\logs\\chilambot.log",
      error_file: BASE_DIR + "\\logs\\chilambot-error.log",
      out_file: BASE_DIR + "\\logs\\chilambot-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      max_memory_restart: "300M",
      watch: false
    }
  ]
};
