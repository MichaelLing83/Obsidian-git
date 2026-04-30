#!/usr/bin/env bash
# test.sh — run the Vitest suite for this plugin
# Usage:
#   ./test.sh              # run tests + print source coverage summary (src/)
#   ./test.sh --no-coverage # run tests only (faster, same as npm test)
#   ./test.sh --watch       # watch mode (no coverage; same as npm run test:watch)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--watch" ]] || [[ "${1:-}" == "-w" ]]; then
  exec npm run test:watch
fi

if [[ "${1:-}" == "--no-coverage" ]]; then
  exec npm test
fi

if [[ -n "${1:-}" ]]; then
  echo "Unknown option: $1" >&2
  echo "Usage: $0 [--watch|-w|--no-coverage]" >&2
  exit 1
fi

exec npm run test:coverage
