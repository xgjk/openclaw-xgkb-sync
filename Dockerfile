# 基于 Node 24 Alpine；业务代码通过 compose 挂载到 /app
FROM m.daocloud.io/docker.io/library/node:24-alpine

RUN apk add --no-cache git bash lsof wget

WORKDIR /app

COPY scripts/docker-entrypoint.sh /usr/local/bin/openclaw-sync-entrypoint.sh
RUN chmod +x /usr/local/bin/openclaw-sync-entrypoint.sh

EXPOSE 9090

ENTRYPOINT ["/usr/local/bin/openclaw-sync-entrypoint.sh"]
CMD ["start"]
