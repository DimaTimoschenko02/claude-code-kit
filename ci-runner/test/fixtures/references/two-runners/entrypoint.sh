#!/usr/bin/env bash
# Register on first start with a one-hour token, then take jobs one at a time.
# Registration stays in the volume, so a restart needs no token.
set -euo pipefail
cd /home/runner/actions-runner
if [ ! -f .runner ]; then
  : "${RUNNER_TOKEN:?the first start needs RUNNER_TOKEN — run infra/deploy.sh ci-runner}"
  ./config.sh --unattended --replace --url https://github.com/example-owner/two-runners --token "$RUNNER_TOKEN" \
    --name "${RUNNER_NAME:-two-runners-ci}" --labels "${RUNNER_LABELS:-two-runners}" --work _work
fi
unset RUNNER_TOKEN
exec ./run.sh
