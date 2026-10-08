FROM node:24-bookworm-slim
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/cloud/admin.js"]
