# 示例被测应用的部署镜像；由外部 CI/CD 构建，平台不参与。
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY server.mjs package.json ./

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
