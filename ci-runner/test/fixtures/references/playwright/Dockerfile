# Self-hosted GitHub Actions runner with checkout tools, a compiler for native npm modules,
# Chromium system libraries, an SSH client and a UTF-8 locale. Jobs cannot sudo.
# Jobs obtain Node through actions/setup-node; build-time Node only installs Playwright dependencies.
FROM ubuntu:24.04

ARG RUNNER_VERSION=2.338.2
ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
ARG NODE_VERSION=24.22.2
ARG NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
# The @playwright/test version from package-lock.json: install-deps lists the libraries of that release's Chromium.
ARG PLAYWRIGHT_VERSION=1.62.1
ARG DEBIAN_FRONTEND=noninteractive

ENV LANG=C.UTF-8

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq tar unzip xz-utils openssh-client \
     build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
  && mkdir /tmp/node && tar -xJf /tmp/node.tar.xz -C /tmp/node --strip-components=1 \
  && PATH="/tmp/node/bin:$PATH" npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
  && rm -rf /tmp/node /tmp/node.tar.xz /root/.npm /var/lib/apt/lists/*

RUN useradd -m -u 1001 runner
WORKDIR /home/runner/actions-runner
RUN curl -fsSL -o runner.tgz \
     "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  && echo "${RUNNER_SHA256}  runner.tgz" | sha256sum -c - \
  && tar xzf runner.tgz && rm runner.tgz \
  && ./bin/installdependencies.sh \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R runner:runner /home/runner
# Outside /home/runner: the volume over that dir would hide a newer copy behind the one from the first start.
COPY --chmod=755 entrypoint.sh /usr/local/bin/runner-entrypoint
USER runner
ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
