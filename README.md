# Teleprompt

Self-hosted voice-following teleprompter for Linux. The app imports scripts, preserves line breaks and headings, and follows your place by matching recent speech against the current line and nearby lines.

License: [MIT](/Users/tim/Projects/teleprompt/LICENSE)

Turnkey installer: [`scripts/install.sh`](/Users/tim/Projects/teleprompt/scripts/install.sh)

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Fastify + WebSocket
- Database: PostgreSQL
- Speech recognition: local `whisper.cpp` HTTP server on the same host
- Recommended recognizer: `whisper.cpp`

## What works

- Import `.md`, `.txt`, `.docx`, and `.pdf`
- Persist projects and scripts in PostgreSQL
- Create a library of scripts grouped by project
- Select a stored script and run it in teleprompter mode
- Authentication with cookie sessions
- First-user bootstrap flow for the initial admin
- Admin user management for creating and updating users
- Manual scroll fallback mode with arrow-key speed control
- Preserve blank lines as blank prompt lines
- Keep Markdown headings separate from body lines
- Stream microphone audio from the browser
- Follow the script block by block based on recent transcript text
- Stronger fuzzy matching across reordered phrasing and partial paraphrase
- Stop advancing when you stop speaking

## Limits

- PDF extraction is best-effort. PDFs with poor structure or scanned pages will need cleanup.
- `.docx` heading detection depends on Word styles being used properly.
- You still need to install and configure `whisper.cpp` on the server.
- Fuzzy matching still depends on overlapping keywords. It is more tolerant now, but it is not semantic speech understanding.

## Local setup

This workspace does not currently have `node` or `npm` installed, so the code was scaffolded without a live build in this environment.

On your Linux server:

1. Install Node.js 20+.
2. Copy the project to the server.
3. Create a PostgreSQL database and user for the app.
4. Run `npm install`.
5. Copy `.env.example` to `.env`.
6. Set `DATABASE_URL`, `SESSION_SECRET`, and `WHISPER_API_URL=http://127.0.0.1:8080/inference`.
7. Run `npm run build`.
8. Run `npm start` or use PM2.

Example PostgreSQL setup:

1. `sudo -u postgres psql`
2. `create user teleprompt with password 'replace-this';`
3. `create database teleprompt owner teleprompt;`
4. `grant all privileges on database teleprompt to teleprompt;`

## Full interactive server install

For Debian/Ubuntu servers, the repo now includes an interactive installer that can:

- ask for the target domain
- install system packages
- install Node.js
- install and configure PostgreSQL
- write `.env`
- install npm dependencies and build the app
- run DB migration
- create the first admin account
- install and configure `whisper.cpp`
- create `systemd` services for Whisper and the app
- configure Nginx
- optionally install Certbot and request a Let's Encrypt certificate

Usage:

1. `chmod +x scripts/install.sh`
2. `./scripts/install.sh`

The installer asks before each major component step instead of assuming everything should be changed.

## Recommended production layout

- Run the Node app with PM2 on `127.0.0.1:3000`
- Run `whisper.cpp` with `systemd` on `127.0.0.1:8080`
- Put Nginx in front of the Node app with HTTPS

This is the simplest deployment for your server. Docker remains optional.

Remote microphone access in the browser requires HTTPS. On a public domain such as `teleprompt.opussoft.eu`, do TLS termination in Nginx.

## Speech recognition setup

The backend supports two modes:

- Preferred: `WHISPER_API_URL` for a long-running local `whisper.cpp` HTTP server
- Fallback: `TRANSCRIBE_COMMAND` for shelling out to a local command per transcript pass

Use `WHISPER_API_URL` on your server. The command fallback exists mainly for edge cases and local experimentation.

## Authentication and bootstrap

When the database is empty, the frontend shows a first-run bootstrap form.

- The first account created becomes `admin`
- Bootstrap also creates a default `General` project
- After that, normal users sign in with email and password
- Session state is stored in PostgreSQL and sent via an HTTP-only cookie

## Teleprompter modes

- `Voice follow`: uses recent transcript context and fuzzy matching to keep up with the current script position
- `Manual scroll`: fallback mode for live shoots where you want hidden control from the keyboard

Manual mode shortcuts while the teleprompter view is open:

- `ArrowUp`: increase scroll speed
- `ArrowDown`: decrease scroll speed
- `ArrowLeft`: pause manual scrolling
- `ArrowRight`: resume / speed up

### Recommended approach with `whisper.cpp`

Install `whisper.cpp` on the Linux host and run its HTTP server locally. The app already supports this through `WHISPER_API_URL`.

Recent `whisper.cpp` builds renamed the server binary from `whisper-server` to `whisper-whisper-server`, so the supplied launcher script checks for both and uses whichever exists.

Suggested host install:

1. `sudo apt-get install -y git cmake build-essential ffmpeg curl`
2. `sudo mkdir -p /opt && cd /opt`
3. `sudo git clone https://github.com/ggml-org/whisper.cpp.git`
4. `cd /opt/whisper.cpp`
5. `sudo cmake -B build`
6. `sudo cmake --build build -j --config Release`
7. `sudo ./models/download-ggml-model.sh base.en`

Use `base.en` first if you want lower CPU use. Move to `small.en` if the server can handle it and you want better recognition.

Then copy:

- [`deploy/run-whisper-server.sh`](/Users/tim/Projects/teleprompt/deploy/run-whisper-server.sh) to the server and make it executable
- [`deploy/teleprompt-whisper.service`](/Users/tim/Projects/teleprompt/deploy/teleprompt-whisper.service) to `/etc/systemd/system/teleprompt-whisper.service`
- [`deploy/teleprompt-whisper.env.example`](/Users/tim/Projects/teleprompt/deploy/teleprompt-whisper.env.example) to `/etc/teleprompt/whisper.env`

Example service setup:

1. `sudo mkdir -p /etc/teleprompt`
2. `sudo cp /var/www/teleprompt/deploy/teleprompt-whisper.env.example /etc/teleprompt/whisper.env`
3. Edit `/etc/teleprompt/whisper.env` if you want a different model or thread count.
4. `sudo cp /var/www/teleprompt/deploy/teleprompt-whisper.service /etc/systemd/system/teleprompt-whisper.service`
5. `sudo chmod +x /var/www/teleprompt/deploy/run-whisper-server.sh`
6. `sudo systemctl daemon-reload`
7. `sudo systemctl enable --now teleprompt-whisper`

Health check:

- `curl -F "file=@/path/to/test.wav" http://127.0.0.1:8080/inference`

## Environment

See [`.env.example`](/Users/tim/Projects/teleprompt/.env.example).

- `PORT`: HTTP port for the Node app
- `HOST`: bind address
- `UPLOAD_DIR`: uploaded file storage directory
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: secret used to hash session tokens
- `SESSION_COOKIE_NAME`: cookie name for the app session
- `SESSION_DURATION_DAYS`: session lifetime
- `WHISPER_API_URL`: local Whisper HTTP endpoint such as `http://127.0.0.1:8080/inference`
- `WHISPER_API_TIMEOUT_MS`: timeout for each transcript request
- `TRANSCRIBE_COMMAND`: local recognizer command template with `{audioPath}`
- `TRANSCRIBE_INTERVAL_MS`: how often to try a transcript pass
- `TRANSCRIBE_WINDOW_SECONDS`: rolling speech window length
- `TRANSCRIBE_MIN_CHUNK_SECONDS`: minimum new speech before another pass
- `TRANSCRIBE_SILENCE_MS`: how long to wait before flushing a final short transcript after you stop speaking

## Development

- `npm run dev`: Vite frontend + Fastify backend
- `npm run build`: build client and server
- `npm start`: run compiled server

In development, Vite serves the frontend and proxies `/api` and `/ws` to the backend.

## Deployment

PM2 example: [`ecosystem.config.cjs`](/Users/tim/Projects/teleprompt/ecosystem.config.cjs)

Systemd app template: [`deploy/teleprompt-app.service.template`](/Users/tim/Projects/teleprompt/deploy/teleprompt-app.service.template)

Systemd Whisper template: [`deploy/teleprompt-whisper.service.template`](/Users/tim/Projects/teleprompt/deploy/teleprompt-whisper.service.template)

Nginx example: [`deploy/nginx.teleprompt.conf`](/Users/tim/Projects/teleprompt/deploy/nginx.teleprompt.conf)

Generic Nginx template: [`deploy/nginx.site.conf.template`](/Users/tim/Projects/teleprompt/deploy/nginx.site.conf.template)

Instance setup helper: [`scripts/setup-instance.sh`](/Users/tim/Projects/teleprompt/scripts/setup-instance.sh)

### Node app with PM2

1. `cp .env.example .env`
2. Set `DATABASE_URL=postgres://teleprompt:password@127.0.0.1:5432/teleprompt`
3. Set a strong `SESSION_SECRET`
4. Set `WHISPER_API_URL=http://127.0.0.1:8080/inference`
5. `npm install`
6. `npm run build`
7. `pm2 start ecosystem.config.cjs`
8. `pm2 save`

### Nginx for your domain
For a public deployment, generate domain-specific files first:

1. `./scripts/setup-instance.sh teleprompt.opussoft.eu`
2. Copy `deploy/generated/teleprompt.opussoft.eu/nginx.teleprompt.opussoft.eu.conf` to `/etc/nginx/sites-available/teleprompt.opussoft.eu`
3. `sudo ln -s /etc/nginx/sites-available/teleprompt.opussoft.eu /etc/nginx/sites-enabled/teleprompt.opussoft.eu`
4. `sudo nginx -t`
5. `sudo systemctl reload nginx`

The setup script also writes a generated `.env` file with a fresh session secret.

## Next steps worth adding

- OCR fallback for scanned PDFs
- Per-project membership and access controls
- Playback history / saved prompt positions
- Health checks and automated tests
