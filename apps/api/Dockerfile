# syntax=docker/dockerfile:1.7
# Builds the API and the background worker (same image, different command).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/sandbox/package.json ./apps/sandbox/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @fingraph/api...
RUN pnpm --filter @fingraph/api build
RUN pnpm --filter @fingraph/api deploy --legacy --prod /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0
WORKDIR /app
RUN groupadd -r fingraph && useradd -r -g fingraph -d /app fingraph && mkdir -p /app/.data && chown fingraph:fingraph /app/.data
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
USER fingraph
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
