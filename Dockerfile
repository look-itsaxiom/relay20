# Coordinator image — stateless, in-memory, no LLM, no secrets. Runs on the homelab.
FROM node:22-slim
WORKDIR /app

# Install production deps only. tsx is a runtime dependency so the TS entrypoint runs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The coordinator only imports src/shared + src/coordinator (src/app is ignored — see .dockerignore).
COPY tsconfig.json ./
COPY src ./src

ENV PORT=8787
EXPOSE 8787
CMD ["npm", "run", "coordinator"]
