# Official Playwright image: Chromium + all system libs preinstalled.
# Keep this version in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Install deps WITHOUT the postinstall browser download (browsers already in image)
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

COPY . .

ENV PORT=8080
# Set API_KEY at deploy time (Render/Railway/Fly env vars), do not hardcode it.
EXPOSE 8080

CMD ["node", "server.js"]
