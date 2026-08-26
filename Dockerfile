# KOS container jail: harness + CLI only; workspace mounted at runtime.
# The agent cannot see the host beyond /workspace.

FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm -C packages/ui build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV KOS_WORKSPACE=/workspace
ENV KOS_HOST=0.0.0.0
ENV KOS_PORT=4317

# ripgrep backs the search.grep tool; without it search is dead inside the jail.
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --uid 10001 kos \
  && mkdir -p /workspace \
  && chown -R kos:kos /workspace

COPY --from=build /src /app
# Drop build tooling weight is left for simplicity; image is still self-contained.

USER kos
WORKDIR /app
VOLUME ["/workspace"]
EXPOSE 4317

# Default: dashboard (API + static UI). Override for chat/discord.
CMD ["node", "packages/cli/dist/main.js", "serve", "--host", "0.0.0.0", "--port", "4317"]
