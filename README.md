# Teleprompt

Self-hosted teleprompter for speakers, presenters, churches, studios, and video production teams who want the prompt to follow live speech on their own server.

Teleprompt lets you:

- import scripts from `.md`, `.txt`, `.docx`, and `.pdf`
- organize scripts by project
- sign in with user accounts and admin management
- run a teleprompter view with:
  - voice-follow mode
  - manual scroll mode
  - pause/resume with spacebar
  - adjustable prompt size
  - adjustable active-line position
  - fine manual speed control

The app is built for self-hosting on Linux and uses a local `whisper.cpp` HTTP server for speech recognition.

## What It Does

In teleprompter mode, Teleprompt continuously listens to the microphone, compares recognized speech against the script, and moves the active line forward as you read.

The current implementation combines:

- low-latency local speech recognition through `whisper.cpp`
- chunk-based matching against the script
- continuous pace-following between recognition updates
- manual fallback controls when you want explicit operator control

This makes it usable both as a speech-following teleprompter and as a more traditional manual prompter.

## Current Feature Set

- project and script library stored in PostgreSQL
- first-user bootstrap flow for the first admin account
- admin user management
- import support for Markdown, plain text, DOCX, and PDF
- teleprompter voice-follow mode
- teleprompter manual scroll mode
- active line highlight with configurable on-screen anchor height
- keyboard controls for manual mode
- spacebar pause/resume for prompt motion
- local HTTPS deployment behind Nginx
- installer for Debian/Ubuntu-based servers

## Technical Stack

- Frontend: React + Vite + TypeScript
- Backend: Fastify + WebSocket
- Database: PostgreSQL
- Speech recognition: local `whisper.cpp` HTTP server
- Process management: `systemd` for production services
- Reverse proxy / TLS: Nginx + Certbot

## Requirements

Recommended production host:

- Debian or Ubuntu server
- Node.js 20+
- PostgreSQL
- Nginx
- `whisper.cpp`
- HTTPS on the public domain if microphone access is needed in the browser

Browser microphone access requires HTTPS on public deployments.

## Installation

The recommended installation path is the interactive installer.

### 1. Clone the repository

```bash
git clone <your-repo-url> teleprompt
cd teleprompt
```

### 2. Run the installer

```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

The installer can:

- install required system packages
- install or verify Node.js
- configure PostgreSQL
- write the app `.env`
- install npm dependencies
- build the app
- run database migration
- create the first admin account
- install and configure `whisper.cpp`
- create `systemd` services for the app and Whisper
- configure Nginx
- optionally request a Let's Encrypt certificate with Certbot

It now also checks whether the chosen app port and Whisper port are already in use, and re-prompts if needed.

## Production Deployment Layout

Typical production layout:

- Teleprompt app bound to `127.0.0.1:<app-port>`
- `whisper.cpp` bound to `127.0.0.1:<whisper-port>`
- Nginx proxying the public domain to the app
- Certbot managing TLS certificates

## Environment

See [`.env.example`](.env.example).

Important settings:

- `PORT`: internal HTTP port for the Teleprompt app
- `HOST`: bind address
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: session signing secret
- `WHISPER_API_URL`: local Whisper HTTP endpoint
- `WHISPER_API_TIMEOUT_MS`: timeout per transcription request
- `TRANSCRIBE_INTERVAL_MS`: how often the server attempts recognition
- `TRANSCRIBE_WINDOW_SECONDS`: rolling audio window for recognition
- `TRANSCRIBE_MIN_CHUNK_SECONDS`: minimum new speech before another pass
- `TRANSCRIBE_SILENCE_MS`: silence threshold before flushing trailing speech

## Manual Development

Install dependencies:

```bash
npm install
```

Run development mode:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Run the compiled server:

```bash
npm start
```

## Teleprompter Controls

### Voice Follow

- `Start`: begin microphone capture and speech following
- `Stop`: stop listening
- `Reset`: return to the start of the prompt
- `Space`: pause or resume prompt motion

### Manual Scroll

- `ArrowUp`: increase scroll speed
- `ArrowDown`: decrease scroll speed
- `ArrowLeft`: pause manual scrolling
- `ArrowRight`: resume manual scrolling

## Recognition Notes

This is not semantic understanding. It still depends on overlap between recognized speech and the script text.

What works best:

- clean microphone input
- a local `whisper.cpp` server on the same machine
- scripts with sensible punctuation
- speech that stays reasonably close to the written wording

What still has limits:

- PDFs are best-effort and may need cleanup
- scanned PDFs are not OCR-processed
- DOCX heading detection depends on actual Word heading styles
- recognition lag and matching accuracy depend on host performance and audio quality

## Deployment Files

Useful deployment files in this repo:

- [scripts/install.sh](scripts/install.sh)
- [scripts/setup-instance.sh](scripts/setup-instance.sh)
- [deploy/teleprompt-app.service.template](deploy/teleprompt-app.service.template)
- [deploy/teleprompt-whisper.service.template](deploy/teleprompt-whisper.service.template)
- [deploy/nginx.site.conf.template](deploy/nginx.site.conf.template)
- [deploy/run-whisper-server.sh](deploy/run-whisper-server.sh)

## Roadmap

Likely next improvements:

- even smoother pace-follow behavior
- OCR fallback for scanned PDFs
- better recognition tuning per host performance
- saved reading positions / resume points
- automated tests

## License

MIT
