# GitHub's runner from its release tarball (checksum from the release notes), plus what the jobs call outside
# their actions: git for checkout, psql to recreate the test DB, a compiler for any native npm module.
FROM ubuntu:24.04
ARG RUNNER_VERSION=2.338.0
ARG RUNNER_SHA256=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq tar unzip xz-utils postgresql-client \
     build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1001 runner
WORKDIR /home/runner/actions-runner
RUN curl -fsSL -o runner.tgz \
     "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  && echo "${RUNNER_SHA256}  runner.tgz" | sha256sum -c - \
  && tar xzf runner.tgz && rm runner.tgz \
  && ./bin/installdependencies.sh \
  && chown -R runner:runner /home/runner
# Outside /home/runner: the volume over that dir would hide a newer copy behind the one from the first start.
COPY --chmod=755 entrypoint.sh /usr/local/bin/runner-entrypoint
USER runner
ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
