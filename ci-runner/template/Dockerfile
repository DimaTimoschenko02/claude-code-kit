# Jobs cannot sudo: bake in checkout/archive tools and compilers for native npm modules.
FROM ubuntu:24.04

ARG RUNNER_VERSION={{runnerVersion}}
ARG RUNNER_SHA256={{runnerSha256}}

ARG DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

RUN apt-get update \
  && apt-get install -y --no-install-recommends {{packages}} \
  && rm -rf /var/lib/apt/lists/*
{{playwright}}
RUN useradd -m -u 1001 runner
WORKDIR /home/runner/actions-runner
RUN curl -fsSL -o runner.tgz \
     "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  && echo "${RUNNER_SHA256}  runner.tgz" | sha256sum -c - \
  && tar xzf runner.tgz && rm runner.tgz \
  && ./bin/installdependencies.sh \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R runner:runner /home/runner
# Outside /home/runner: the home volume would hide a newer entrypoint behind its first copy.
COPY --chmod=755 entrypoint.sh /usr/local/bin/runner-entrypoint
USER runner
# Explicit bash permits the generated-file header on line one, before any shebang.
ENTRYPOINT ["/bin/bash", "/usr/local/bin/runner-entrypoint"]
