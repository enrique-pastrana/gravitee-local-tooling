FROM node:20-alpine

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --omit=dev

COPY server.js /app/server.js
COPY zendeskClient.js /app/zendeskClient.js
COPY attachments.js /app/attachments.js

CMD ["node", "server.js"]
