#!/usr/bin/env bash
# First start registers the runner with the one-hour token install.sh passes in; the registration stays in the volume,
# so restarts and image rebuilds go straight to run.sh. The runner updates itself inside that volume.
set -euo pipefail
cd /home/runner/actions-runner
if [ ! -f .runner ]; then
  : "${RUNNER_TOKEN:?the first start needs RUNNER_TOKEN — run infra/ci-runner/install.sh}"
  ./config.sh --unattended --replace --url "$RUNNER_REPO_URL" --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work
fi
unset RUNNER_TOKEN
exec ./run.sh
