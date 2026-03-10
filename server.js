const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
require('dotenv').config();

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = String(process.env.JWT_SECRET || 'CHANGE_THIS_SECRET_IN_PROD');
const COOKIE_NAME = 'yucarro_session';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false') === 'true';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'dashboard.db');

const DEFAULT_LINKS = {
  cpk: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vThc6F_SNxa5JhL897dxyyl7u-g-g2q4QbTHIo8yEkDBJpHXAH9NZzx3FJFPwxvbg/pub?gid=585285912&single=true&output=csv',
  scrap: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRkZVja7KbANtJeC2ED5QZp9QPt9RGV2wp-p8_jhTJfie0OJw17RFHgjvXPr90teg/pub?gid=1264772684&single=true&output=csv',
  scrapCredit: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRkZVja7KbANtJeC2ED5QZp9QPt9RGV2wp-p8_jhTJfie0OJw17RFHgjvXPr90teg/pub?gid=362347697&single=true&output=csv',
  wash: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTCaFeNwOTwRuMkQnliCirL04_SiAHFXAzqn_TPe_Evuy6f_xuB9_insuXl3mgvRg/pub?gid=1103372447&single=true&output=csv',
  washHist: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRlZOIwJFJGVOZq2IIY2gMo1DRIwDXQXnJIom29GuKUw1MOIjCKSmMvhSaoCJgQYg/pub?gid=1734395370&single=true&output=csv',
  extra: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQsdiL36ZevOm1AY8E-PfkIhWFzimoVoeQlbWw-wq7mfHU-bE28UENuWqjLl1yb_A/pub?gid=612375241&single=true&output=csv',
  lossY: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQrVX7KEz9XHq0m50eT6wsF-kSigOp4pNiycGS9mlbFy3tl_jA-cS7jaeqkt1TtCg/pub?gid=869681452&single=true&output=csv',
  lossT: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQrVX7KEz9XHq0m50eT6wsF-kSigOp4pNiycGS9mlbFy3tl_jA-cS7jaeqkt1TtCg/pub?gid=236163936&single=true&output=csv',
  lossC: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQrVX7KEz9XHq0m50eT6wsF-kSigOp4pNiycGS9mlbFy3tl_jA-cS7jaeqkt1TtCg/pub?gid=266470563&single=true&output=csv'
};

const ALLOWED_MODULES = ['performance', 'scrap', 'strategy', 'washing', 'extra', 'loss', 'colorblind'];
const ALLOWED_LINK_ACCESS = ['performance', 'scrap', 'strategy', 'scrapCredit', 'washing', 'washingHist', 'extra', 'lossY', 'lossT', 'lossC'];
const VALID_ROLES = ['admin', 'editor', 'viewer'];

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  modules_json TEXT NOT NULL,
  link_access_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

const stmts = {
  findUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  listUsers: db.prepare('SELECT * FROM users ORDER BY CASE WHEN role = "admin" THEN 0 ELSE 1 END, username ASC'),
  upsertUser: db.prepare(`
    INSERT INTO users (username, password_hash, role, modules_json, link_access_json, created_at, updated_at)
    VALUES (@username, @password_hash, @role, @modules_json, @link_access_json, @created_at, @updated_at)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = @password_hash,
      role = @role,
      modules_json = @modules_json,
      link_access_json = @link_access_json,
      updated_at = @updated_at
  `),
  updateUserNoPassword: db.prepare(`
    UPDATE users
      SET username = @new_username,
          role = @role,
          modules_json = @modules_json,
          link_access_json = @link_access_json,
          updated_at = @updated_at
    WHERE username = @old_username
  `),
  updateUserWithPassword: db.prepare(`
    UPDATE users
      SET username = @new_username,
          password_hash = @password_hash,
          role = @role,
          modules_json = @modules_json,
          link_access_json = @link_access_json,
          updated_at = @updated_at
    WHERE username = @old_username
  `),
  deleteUser: db.prepare('DELETE FROM users WHERE username = ?'),
  countAdmins: db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = "admin"'),
  getConfig: db.prepare('SELECT value_json FROM app_config WHERE key = ?'),
  upsertConfig: db.prepare(`
    INSERT INTO app_config (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `),
  updateUserPassword: db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?')
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeStr(v) {
  return (v ?? '').toString().trim();
}

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeModules(role, modules) {
  if (role === 'admin') return ALLOWED_MODULES.slice();
  const src = Array.isArray(modules) ? modules : [];
  return Array.from(new Set(src.map(normalizeStr).filter(x => ALLOWED_MODULES.includes(x))));
}

function normalizeLinkAccess(role, links) {
  if (role === 'admin') return ALLOWED_LINK_ACCESS.slice();
  if (role === 'viewer') return [];
  const src = Array.isArray(links) ? links : [];
  return Array.from(new Set(src.map(normalizeStr).filter(x => ALLOWED_LINK_ACCESS.includes(x))));
}

function rowToUser(row) {
  if (!row) return null;
  return {
    username: row.username,
    role: row.role,
    modules: parseJsonArray(row.modules_json),
    linkAccess: parseJsonArray(row.link_access_json)
  };
}

function canEditLink(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.linkAccess) && user.linkAccess.includes(key);
}

function getLinks() {
  const row = stmts.getConfig.get('cloud_links');
  if (!row) return { ...DEFAULT_LINKS };
  try {
    const parsed = JSON.parse(row.value_json);
    return { ...DEFAULT_LINKS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (_) {
    return { ...DEFAULT_LINKS };
  }
}

function saveLinks(links) {
  const clean = { ...DEFAULT_LINKS, ...(links && typeof links === 'object' ? links : {}) };
  stmts.upsertConfig.run('cloud_links', JSON.stringify(clean), nowIso());
  return clean;
}

function listUsersPublic() {
  return stmts.listUsers.all().map(rowToUser);
}

function ensureBootstrapData() {
  if (!stmts.getConfig.get('cloud_links')) saveLinks(DEFAULT_LINKS);

  const adminUser = normalizeStr(process.env.ADMIN_USER || 'yucadmin');
  const adminPass = normalizeStr(process.env.ADMIN_PASS || 'ChangeMe123!');
  const existing = stmts.findUser.get(adminUser);
  const ts = nowIso();
  const adminPayload = {
    username: adminUser,
    password_hash: bcrypt.hashSync(adminPass, 10),
    role: 'admin',
    modules_json: JSON.stringify(ALLOWED_MODULES),
    link_access_json: JSON.stringify(ALLOWED_LINK_ACCESS),
    created_at: ts,
    updated_at: ts
  };

  if (!existing) {
    stmts.upsertUser.run(adminPayload);
    return;
  }

  // Mantener usuario admin consistente; contraseña solo se actualiza si viene por env.
  const update = {
    old_username: existing.username,
    new_username: existing.username,
    role: 'admin',
    modules_json: JSON.stringify(ALLOWED_MODULES),
    link_access_json: JSON.stringify(ALLOWED_LINK_ACCESS),
    updated_at: ts
  };

  if (process.env.ADMIN_PASS) {
    stmts.updateUserWithPassword.run({ ...update, password_hash: bcrypt.hashSync(adminPass, 10) });
  } else {
    stmts.updateUserNoPassword.run(update);
  }
}

ensureBootstrapData();

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

function readSession(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !payload.sub) return null;
    const row = stmts.findUser.get(payload.sub);
    return rowToUser(row);
  } catch (_) {
    return null;
  }
}

function setSession(res, username) {
  const token = jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function requireAuth(req, res, next) {
  const me = readSession(req);
  if (!me) return res.status(401).json({ ok: false, error: 'No autenticado' });
  req.user = me;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Solo administrador' });
  }
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: nowIso() });
});

app.get('/api/bootstrap', (req, res) => {
  const me = readSession(req);
  const links = getLinks();
  if (!me) {
    return res.json({ ok: true, me: null, users: [], links });
  }

  const users = me.role === 'admin'
    ? listUsersPublic()
    : [me];

  return res.json({ ok: true, me, users, links });
});

app.post('/api/auth/login', (req, res) => {
  const username = normalizeStr(req.body && req.body.username);
  const password = normalizeStr(req.body && req.body.password);
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Usuario y contraseña requeridos' });
  }

  const row = stmts.findUser.get(username);
  if (!row) return res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
  const valid = bcrypt.compareSync(password, row.password_hash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Credenciales inválidas' });

  setSession(res, row.username);
  const me = rowToUser(row);
  const users = me.role === 'admin' ? listUsersPublic() : [me];
  const links = getLinks();
  return res.json({ ok: true, me, users, links });
});

app.post('/api/auth/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const me = readSession(req);
  res.json({ ok: true, me: me || null });
});

app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ok: true, users: listUsersPublic() });
});

app.post('/api/users/upsert', requireAuth, requireAdmin, (req, res) => {
  const originalUsername = normalizeStr(req.body && req.body.originalUsername);
  const username = normalizeStr(req.body && req.body.username);
  const password = normalizeStr(req.body && req.body.password);
  const roleRaw = normalizeStr(req.body && req.body.role).toLowerCase();
  const role = VALID_ROLES.includes(roleRaw) ? roleRaw : 'editor';

  if (!username) return res.status(400).json({ ok: false, error: 'Usuario requerido' });

  const modules = normalizeModules(role, req.body && req.body.modules);
  const linkAccess = normalizeLinkAccess(role, req.body && req.body.linkAccess);
  const ts = nowIso();

  const exists = originalUsername ? stmts.findUser.get(originalUsername) : stmts.findUser.get(username);
  const targetOld = exists ? exists.username : null;
  const renamedConflict = targetOld && username !== targetOld ? stmts.findUser.get(username) : null;
  if (renamedConflict) {
    return res.status(409).json({ ok: false, error: 'Ya existe un usuario con ese nombre' });
  }

  if (!exists) {
    if (!password || password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Para crear usuario, define contraseña (mín. 6)' });
    }
    stmts.upsertUser.run({
      username,
      password_hash: bcrypt.hashSync(password, 10),
      role,
      modules_json: JSON.stringify(modules),
      link_access_json: JSON.stringify(linkAccess),
      created_at: ts,
      updated_at: ts
    });
    return res.json({ ok: true, users: listUsersPublic() });
  }

  if (exists.role === 'admin' && role !== 'admin') {
    const adminCount = Number(stmts.countAdmins.get().c || 0);
    if (adminCount <= 1) {
      return res.status(400).json({ ok: false, error: 'Debe existir al menos un administrador' });
    }
  }

  if (password) {
    stmts.updateUserWithPassword.run({
      old_username: targetOld,
      new_username: username,
      password_hash: bcrypt.hashSync(password, 10),
      role,
      modules_json: JSON.stringify(modules),
      link_access_json: JSON.stringify(linkAccess),
      updated_at: ts
    });
  } else {
    stmts.updateUserNoPassword.run({
      old_username: targetOld,
      new_username: username,
      role,
      modules_json: JSON.stringify(modules),
      link_access_json: JSON.stringify(linkAccess),
      updated_at: ts
    });
  }

  return res.json({ ok: true, users: listUsersPublic() });
});

app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  const username = normalizeStr(req.params.username);
  const target = stmts.findUser.get(username);
  if (!target) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

  if (target.role === 'admin') {
    const adminCount = Number(stmts.countAdmins.get().c || 0);
    if (adminCount <= 1) return res.status(400).json({ ok: false, error: 'No puedes eliminar al único administrador' });
  }

  if (req.user && req.user.username === username) {
    return res.status(400).json({ ok: false, error: 'No puedes eliminar tu propia sesión activa' });
  }

  stmts.deleteUser.run(username);
  return res.json({ ok: true, users: listUsersPublic() });
});

app.post('/api/users/change-password', requireAuth, (req, res) => {
  const currentPass = normalizeStr(req.body && req.body.currentPass);
  const newPass = normalizeStr(req.body && req.body.newPass);

  if (!currentPass || !newPass) {
    return res.status(400).json({ ok: false, error: 'Datos incompletos' });
  }
  if (newPass.length < 6) {
    return res.status(400).json({ ok: false, error: 'Nueva contraseña mínima de 6 caracteres' });
  }

  const row = stmts.findUser.get(req.user.username);
  if (!row) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
  const valid = bcrypt.compareSync(currentPass, row.password_hash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Contraseña actual incorrecta' });

  stmts.updateUserPassword.run(bcrypt.hashSync(newPass, 10), nowIso(), row.username);
  res.json({ ok: true });
});

app.get('/api/links', (_req, res) => {
  res.json({ ok: true, links: getLinks() });
});

app.put('/api/links', requireAuth, (req, res) => {
  const links = getLinks();
  const updatesRaw = req.body && typeof req.body === 'object' ? req.body : {};
  const updatedKeys = [];

  for (const [key, value] of Object.entries(updatesRaw)) {
    if (!(key in DEFAULT_LINKS)) continue;
    if (!canEditLink(req.user, key)) {
      return res.status(403).json({ ok: false, error: `Sin permiso para editar ${key}` });
    }
    links[key] = normalizeStr(value) || DEFAULT_LINKS[key];
    updatedKeys.push(key);
  }

  const saved = saveLinks(links);
  res.json({ ok: true, links: saved, updatedKeys });
});

app.post('/api/links/reset', requireAuth, (req, res) => {
  const links = getLinks();
  const reqKeys = Array.isArray(req.body && req.body.keys) ? req.body.keys : Object.keys(DEFAULT_LINKS);
  const keys = reqKeys.map(normalizeStr).filter(k => k in DEFAULT_LINKS);

  keys.forEach((k) => {
    if (!canEditLink(req.user, k)) return;
    links[k] = DEFAULT_LINKS[k];
  });

  const saved = saveLinks(links);
  res.json({ ok: true, links: saved });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'Index.html'));
});

app.listen(PORT, () => {
  console.log(`Dashboard backend running on http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASS) {
    console.warn('ADMIN_PASS no definido. Se usó contraseña temporal por defecto. Configura .env antes de producción.');
  }
  if (JWT_SECRET === 'CHANGE_THIS_SECRET_IN_PROD') {
    console.warn('JWT_SECRET está en valor por defecto. Cámbialo en .env para producción.');
  }
});
