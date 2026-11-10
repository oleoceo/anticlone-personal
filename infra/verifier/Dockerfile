# Disposable pre-VPS verification laboratory, not a public service.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
WORKDIR /verifier
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY apps/installation-browser.mjs ./
USER pwuser
ENTRYPOINT ["node", "installation-browser.mjs"]
