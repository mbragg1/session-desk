#!/bin/sh
# Stands in for the login shell the app runs claude through: no rc files, and
# the fake claude in bin/ first on PATH. Never runs the real claude.
PATH="$BENCH_BIN:/usr/bin:/bin" exec /bin/zsh -f "$@"
