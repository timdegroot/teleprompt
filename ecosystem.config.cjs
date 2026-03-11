module.exports = {
  apps: [
    {
      name: "teleprompt",
      script: "dist/server/index.js",
      cwd: "/var/www/teleprompt",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        HOST: "127.0.0.1",
        WHISPER_API_URL: "http://127.0.0.1:8080/inference"
      }
    }
  ]
};
