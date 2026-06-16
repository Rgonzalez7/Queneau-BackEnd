# Backend Queneau — corre con tsx (sin build). Node 22 slim (glibc).
FROM node:22-slim

WORKDIR /app

# Instala dependencias (incluye tsx y mongodb). Usa el lockfile para reproducibilidad.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copia el código fuente
COPY . .

# Las portadas se guardan en el volumen montado en /data/covers (ver fly.toml)
ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["npm", "start"]
