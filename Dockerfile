ARG BUN_IMAGE=oven/bun:1.4.4
FROM ${BUN_IMAGE}

WORKDIR /app
RUN rm -rf /app/* /app/.[!.]* /app/..?* || true

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .
RUN chmod +x docker/entrypoint.sh

ARG TOWER_GIT_COMMIT
ARG TOWER_GIT_BRANCH
ARG TOWER_BUILD_TIME
ENV TOWER_GIT_COMMIT=${TOWER_GIT_COMMIT}
ENV TOWER_GIT_BRANCH=${TOWER_GIT_BRANCH}
ENV TOWER_BUILD_TIME=${TOWER_BUILD_TIME}

ENV NODE_ENV=production
ENV PORT=3100

EXPOSE 3100 3180 3190

CMD ["sh", "docker/entrypoint.sh"]
