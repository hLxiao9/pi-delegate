module.exports = {
  apps: [
    {
      name: 'pi-delegate-dashboard',
      cwd: '/Users/xiao9/.agents/skills/pi-delegate',
      script: '/Users/xiao9/.workbuddy/binaries/node/versions/22.22.2/bin/node',
      args: 'scripts/pi-worker.mjs serve --port 7317 --no-open',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PI_WORKER_PORT: '7317'
      }
    }
  ]
};
