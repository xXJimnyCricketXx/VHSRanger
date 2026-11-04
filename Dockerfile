FROM node:24-alpine

RUN apk add --no-cache su-exec

ENV NODE_ENV=production
ENV HOME=/tmp

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

# A Windows checkout may have turned the line endings into CRLF.
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

EXPOSE 3098

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "app.js"]
