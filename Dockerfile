FROM node:20-bullseye-slim

# Install k6 (the server spawns the `k6` CLI to run generated test scripts)
RUN apt-get update \
    && apt-get install -y --no-install-recommends gnupg curl ca-certificates \
    && curl -fsSL https://dl.k6.io/key.gpg | gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" > /etc/apt/sources.list.d/k6.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends k6 \
    && apt-get purge -y gnupg curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY public ./public

RUN mkdir -p generated

ENV PORT=4600
EXPOSE 4600

CMD ["node", "server/server.js"]
