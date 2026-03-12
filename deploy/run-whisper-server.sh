#!/usr/bin/env sh
set -eu

WHISPER_DIR="${WHISPER_DIR:-/opt/whisper.cpp}"
MODEL_PATH="${MODEL_PATH:-$WHISPER_DIR/models/ggml-base.en.bin}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
LANGUAGE="${LANGUAGE:-en}"
THREADS="${THREADS:-4}"
PROCESSORS="${PROCESSORS:-1}"
EXTRA_ARGS="${EXTRA_ARGS:-}"

if [ -x "$WHISPER_DIR/build/bin/whisper-whisper-server" ]; then
  SERVER_BIN="$WHISPER_DIR/build/bin/whisper-whisper-server"
elif [ -x "$WHISPER_DIR/build/bin/whisper-server" ]; then
  SERVER_BIN="$WHISPER_DIR/build/bin/whisper-server"
else
  echo "Could not find whisper server binary in $WHISPER_DIR/build/bin" >&2
  exit 1
fi

exec "$SERVER_BIN" \
  --host "$HOST" \
  --port "$PORT" \
  --language "$LANGUAGE" \
  --model "$MODEL_PATH" \
  --threads "$THREADS" \
  --processors "$PROCESSORS" \
  $EXTRA_ARGS
