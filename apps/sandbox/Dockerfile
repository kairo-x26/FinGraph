# Local identity provider and document repository for demos. Never deploy to production.
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/sandbox ./apps/sandbox
RUN pnpm install --frozen-lockfile --filter @fingraph/sandbox...
WORKDIR /repo/apps/sandbox
ENV SANDBOX_PORT=4100 SANDBOX_HOST=0.0.0.0
EXPOSE 4100
CMD ["pnpm", "start"]
