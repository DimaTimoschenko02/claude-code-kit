# ci-runner

One Docker runner canon for projects whose GitHub-hosted Actions are blocked by billing.
Each project keeps `infra/ci-runner/runner.json`; this kit renders its Dockerfile, entrypoint and
Compose file. Deployment stays on that project's server; the host is configuration.
Requires Node 22+, no npm dependencies. Install also needs authenticated `gh` with repository admin
access, OpenSSH (`scp -O`), and a Linux x86-64 server with Docker Compose v2 and an SSH user allowed
to create the target directory and run Docker. This tool does not provision the server.

```sh
node /path/to/claude-code-kit/ci-runner/bin/ci-runner.mjs render "/path/to/project"
node /path/to/claude-code-kit/ci-runner/bin/ci-runner.mjs check "/path/to/project"
node /path/to/claude-code-kit/ci-runner/bin/ci-runner.mjs install "/path/to/project" --dry-run
node /path/to/claude-code-kit/ci-runner/bin/ci-runner.mjs install "/path/to/project"
```

Commit `runner.json` and the three generated files in the project. Re-render after kit/config changes;
`check` exits 1 and names missing or changed files. Install requires a clean `check`; dry-run prints
the plan without writing files, requesting a token, or executing any external commands.
Output is LF with a generated header on line one. `compose.yaml` uses JSON flow syntax, valid YAML,
to keep quoting and semantic tests dependency-free.

## Configuration

Complete example: [`test/fixtures/pgvector.runner.json`](test/fixtures/pgvector.runner.json).
The [Playwright](test/fixtures/playwright.runner.json) and [main + light runner](test/fixtures/two-runners.runner.json)
fixtures cover the other options. Unknown fields, duplicate names/labels and unsafe values are errors.

| Field | Contract |
|---|---|
| `repo` | Required `owner/name`. |
| `host` | Required SSH alias or `[user@]hostname`; override for one install with `CI_RUNNER_HOST`. |
| `dir` | Required absolute server directory; spaces allowed, shell metacharacters and `.`/`..` segments forbidden. |
| `composeName` | Required lowercase Compose project name: letters, digits, `_`, `-`. Keep stable to retain volumes. |
| `runnerVersion`, `runnerSha256` | Required exact `x.y.z` release and its 64-hex Linux x64 tarball checksum. |
| `runners` | Nonempty list of `{ name, labels, limits, testDb? }`. Names/labels: 1–64 letters, digits, `.`, `_`, `-`, starting alphanumeric; labels nonempty. `testDb` is `true` or omitted. |
| `limits` | Required `mem` (positive Docker size string, e.g. `1536m`); optional `cpuset` (`2,3`, `0-2`), `cpus` (>0), `cpuShares` (integer 2–262144), `oomScoreAdj` (integer −1000…1000), `pids` (positive integer), `shm` (size string). |
| `testDb` | Optional `{ image, port, user, db, cpus, mem }`, all fields required when present. PostgreSQL-compatible image, port 1–65535, SQL identifiers for user/db, positive CPU/memory. At least one runner must opt in. |
| `extraApt` | Optional package-name array, e.g. `["postgresql-client"]`; versions/options/shell fragments forbidden. |
| `features` | Optional array; only `"playwright"` is supported. |
| `playwrightVersion`, `nodeVersion`, `nodeSha256` | Required only with Playwright: exact versions and Node Linux x64 checksum. Match the workflow's Playwright version; set `limits.shm` for Chromium (e.g. `1g`). Build-time Node is removed; jobs use `actions/setup-node`. |

The first runner's service/volume is `runner`. Further names prefixed with `<first-name>-` become
`runner-<suffix>` (main + light gives `runner-light`); otherwise `runner-<full-name>`. Collisions fail
validation. Keep runner order and names stable to retain registration/cache volumes.

`testDb` is a disposable Postgres on a named `pgdata` volume, with no published port. Opted-in runners
use `network_mode: service:postgres` and connect to `127.0.0.1:<port>`; other runners use the Compose
network. It uses trust auth, and `jit`, `fsync`, `synchronous_commit`, `full_page_writes` are off.
Explicit `PGDATA=/var/lib/postgresql/ci-data` works across old/new image defaults
([Postgres image documentation](https://hub.docker.com/_/postgres)). Jobs recreate the test database;
this is not a production database. Multiple DB-enabled runners share it: coordinate destructive tests.

## Invariants and workflow

- Jobs run as non-root `runner` (uid 1001). No Docker socket, host mounts or published ports.
- All services have a hard memory cap with `memswap_limit = mem_limit`, `restart: unless-stopped`,
  and json-file logs capped at 10m × 3. CPU/shm/pid/OOM settings come from config.
- The registration token goes from `gh` into SSH stdin, never argv, a file or logs. Install buffers
  the short response in memory until `gh` succeeds; token-step diagnostics are suppressed to prevent
  leaking it. Restart needs no token; registration only runs while `.runner` is absent. The entrypoint
  unsets `RUNNER_TOKEN` before jobs. Compose still retains its container environment: Docker admin is trusted.
- Install fetches **all pages**, refuses if **any repository runner** is busy, then creates the directory
  (mode 700), copies the three files and runs Compose with `--build --wait`. This is a point-in-time
  busy check: avoid queueing work during maintenance. Failures stop the sequence; no automatic rollback.
- **Docker-based actions (e.g. `appleboy/ssh-action`) and `services:` containers do not work.**
  Deploy with plain `ssh`/`scp`: provide a verified host public key through a temporary `known_hosts`,
  use `HostKeyAlias`, `UserKnownHostsFile` and `StrictHostKeyChecking=yes`,
  with project values supplied by workflow configuration. Use `testDb`,
  not workflow `services:`. Pinning SSH host keys also applies to the operator's install connection.
- The home volume holds registration, self-updates, tool caches and workspaces. A new image pin seeds
  **empty volumes only**; existing runners self-update. Restrict which workflow code can run on a
  persistent runner sharing a production host (for example, reject fork PRs in the workflow).

Move servers: change `host`, render/check, install on the new server, then stop/remove the old
container. Keep the same runner names (`--replace` replaces their GitHub registrations). Wait for
idle and pause workflow dispatch during the move; stop the old runner before resuming jobs. Volumes
do not migrate: the new server gets fresh registration, caches and test data. No volume deletion is
part of install.

## Reference parity and tests

```sh
node --test ci-runner/test
node --test tests/*.test.mjs  # existing kit root suite
```

Tests need Node and Bash (Git Bash on Windows), no Docker daemon, SSH or GitHub access. Anonymized
reference files live under `test/fixtures/references`; private-original source hashes are omitted.
Only identifying names and comments were neutralized; limits, images, versions, release checksums
and packages are preserved. `compose.semantic.json` was captured
with `docker compose config --no-interpolate --no-normalize --format json`: absolute build contexts
become `.`, named-volume objects become `source:target`, `depends_on` becomes a service list. Tests
compare entire models ignoring key order/comments and null-vs-empty volume declarations; Dockerfile
comparisons parse instructions and sort ARG/ENV keys and package names. The pgvector fixture has full byte snapshots.

Intentional semantic differences from the references (the tests enumerate them):

- Both: explicit Bash entrypoint so the generated header can occupy line one. First-start registration,
  `--replace`, token cleanup and runner self-updates are unchanged.
- The two-runner reference: add `openssh-client`, `LANG=C.UTF-8`, noninteractive apt and final apt-cache cleanup to match
  the common image. Repo URL, name and labels move from entrypoint literals/defaults to explicit env.
- The two-runner reference: disable swap for all services, add capped Postgres logs and the busy-runner install guard.
- The two-runner reference: explicit `PGDATA` moves disposable test data within the same `pgdata` volume from the image's
  default `18/docker` to `ci-data`. First migration initializes fresh test data; production is untouched.

Images, release checksums, services, build context, volume names/mounts, resource limits, database command,
network namespace and packages otherwise reproduce the references. JSON/YAML layout and comments are
format-only differences. Generated-file headers and generic validation/errors replace project-specific text.
