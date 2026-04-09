FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN mkdir -p /app/public && cp -r src/public/* /app/public/
EXPOSE 3000
CMD ["node", "dist/index.js"]
