module.exports = {
  apps: [{
    name: 'sermon-server',
    script: 'server.js',
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'development',
      PORT: 9897
    },
    // 로그 설정
    log_file: 'logs/combined.log',
    out_file: 'logs/out.log',
    error_file: 'logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // 자동 재시작
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 3000,
    // 크래시 시 지수 백오프
    exp_backoff_restart_delay: 100
  }]
};
