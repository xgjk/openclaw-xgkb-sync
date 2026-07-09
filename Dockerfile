# 基于 Node 24 Alpine；业务代码通过 compose 挂载到 /app
FROM m.daocloud.io/docker.io/library/node:24-alpine

RUN apk add --no-cache git bash lsof wget

WORKDIR /app

EXPOSE 9090

# 入口脚本从挂载的 /app/scripts 读取，git pull 后 restart 即可生效（无需每次重建镜像）
ENTRYPOINT ["/bin/bash", "/app/scripts/docker-entrypoint.sh"]
CMD ["start"]
