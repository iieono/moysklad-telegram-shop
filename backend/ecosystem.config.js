module.exports = {
  apps: [{
    name: 'tx-backend',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'fork',

    // Auto-restart configuration
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,

    // Resource limits
    max_memory_restart: '512M',

    // Logging
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,

    // Environment
    env_production: {
      NODE_ENV: 'production'
    },

    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,

    // Crash detection
    exp_backoff_restart_delay: 100,

    // Watch options (disabled in production)
    watch: false,
    ignore_watch: ['node_modules', 'logs']
  }]
};
