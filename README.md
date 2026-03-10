# Version Backend - Dashboard Yucarro

Esta carpeta contiene una versión migrada a backend para poner en línea el dashboard con:

- autenticación en servidor
- usuarios/roles/permisos centralizados
- enlaces CSV centralizados
- sesión persistente por cookie segura (`HttpOnly`)

## Estructura

- `server.js`: API + servidor web
- `package.json`: dependencias y scripts
- `.env.example`: variables de entorno base
- `data/`: base SQLite (`dashboard.db` se crea automáticamente)
- `public/`: frontend final
  - `Index.html`
  - `dashboard.app.js`
  - `backend.preload.js`
  - `backend.patch.js`
  - `users.vault.js`
  - `logo Yucarro.png`

## Despliegue

1. Copia esta carpeta al servidor.
2. Entra a la carpeta:
   - `cd "Version Backend"`
3. Instala dependencias:
   - `npm install`
4. Crea `.env` basado en `.env.example` y cambia al menos:
   - `JWT_SECRET`
   - `ADMIN_PASS`
5. Inicia:
   - `npm start`
6. Abre:
   - `http://localhost:8080`

## Variables recomendadas

- `PORT=8080`
- `JWT_SECRET=<secreto-largo-y-unico>`
- `COOKIE_SECURE=true` (si usas HTTPS en producción)
- `DB_FILE=./data/dashboard.db`
- `ADMIN_USER=yucadmin`
- `ADMIN_PASS=<tu-password-admin>`

## Notas operativas

- Usuarios y enlaces se guardan en SQLite servidor (`data/dashboard.db`).
- En frontend se usa `localStorage` solo como caché de sesión/UI.
- Para respaldo real, guarda copia periódica de `data/dashboard.db`.
