FROM node:18-bullseye-slim

WORKDIR /app

# Instalar dependencias del sistema necesarias para compilar gyp (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copiar configuración de node
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el código fuente
COPY . .

# Exponer el puerto
EXPOSE 8080

# Iniciar servidor
CMD ["npm", "start"]
