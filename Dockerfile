FROM node:22-alpine AS base
WORKDIR /app

RUN apk add --no-cache python3 py3-pip py3-pillow py3-qrcode

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY requirements.txt ./

RUN npm run build

EXPOSE 8001

CMD ["npm", "start"]
