# Match the job's Playwright release: its Chromium libraries are version-specific.
ARG NODE_VERSION={{nodeVersion}}
ARG NODE_SHA256={{nodeSha256}}
ARG PLAYWRIGHT_VERSION={{playwrightVersion}}
# Node is only a build tool here; jobs choose their own Node through actions/setup-node.
RUN curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
  && mkdir /tmp/node && tar -xJf /tmp/node.tar.xz -C /tmp/node --strip-components=1 \
  && PATH="/tmp/node/bin:$PATH" npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
  && rm -rf /tmp/node /tmp/node.tar.xz /root/.npm /var/lib/apt/lists/*
