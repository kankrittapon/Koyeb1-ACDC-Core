FROM node:22-alpine AS base
WORKDIR /app

RUN apk add --no-cache \
  chromium \
  python3 \
  py3-pip \
  py3-pillow \
  py3-qrcode \
  py3-cairo \
  py3-gobject3 \
  fontconfig \
  font-noto-thai \
  pango

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY requirements.txt ./

RUN npm run build

EXPOSE 8001

CMD ["npm", "start"]
