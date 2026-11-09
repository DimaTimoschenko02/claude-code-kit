# Registration survives restarts/rebuilds in the home volume; the runner self-updates there.
set -euo pipefail
cd /home/runner/actions-runner
if [ ! -f .runner ]; then
  : "${RUNNER_TOKEN:?the first start needs RUNNER_TOKEN — run ci-runner install}"
  ./config.sh --unattended --replace --url "$RUNNER_REPO_URL" --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work
fi
# Job processes must not inherit the one-hour registration token.
unset RUNNER_TOKEN
exec ./run.sh
