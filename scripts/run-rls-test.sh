#!/bin/sh
# Wrapper: sets NODE_PATH so @supabase/supabase-js resolves, then runs test-rls-live.mjs.
# Usage:  sh scripts/run-rls-test.sh
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a
. "$REPO_ROOT/.env.local"
set +a
NODE_PATH="$REPO_ROOT/packages/db/node_modules" node "$REPO_ROOT/scripts/test-rls-live.mjs"
