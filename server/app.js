import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';

const COOKIE = 'stake_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = token => createHash('sha256').update(token).digest('hex');
const publicUser = ({ id, name, email, role }) => ({ id, name, email, role });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } });
const fail = (res, status, message) => res.status(status).json({ error: message });

export function createApp({ db, uploadDir, appOrigin = 'http://localhost:5173', production = false, serveFrontend = production }) {
  const app = express();
  const photosDir = path.resolve(uploadDir);
  app.disable('x-powered-by');
  app.use(helmet({ strictTransportSecurity: production ? undefined : false }));
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-Stake-Request') !== '1' || (req.get('Origin') && req.get('Origin') !== appOrigin)) {
        return fail(res, 403, 'This request did not come from the Stake app.');
      }
    }
    next();
  });

  app.get('/api/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in 15 minutes.' } });

  async function sessionUser(req, res, next) {
    const token = req.cookies[COOKIE];
    if (!token || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return fail(res, 401, 'Please log in to continue.');
    const { rows } = await db.query(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.account_status = 'active'`, [hashToken(token)]);
    if (!rows.length) return fail(res, 401, 'Your session has expired. Please log in again.');
    req.user = rows[0];
    next();
  }

  async function beginSession(req, res, user) {
    if (req.cookies[COOKIE]) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(req.cookies[COOKIE])]);
    await db.query('DELETE FROM sessions WHERE expires_at <= now()');
    const token = randomBytes(32).toString('hex');
    await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [hashToken(token), user.id, new Date(Date.now() + SESSION_MS)]);
    res.cookie(COOKIE, token, { httpOnly: true, secure: production, sameSite: 'lax', path: '/', maxAge: SESSION_MS });
  }

  app.post('/api/auth/register', authLimit, async (req, res) => {
    const { name, email, password } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 ||
        typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
        typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) {
      return fail(res, 400, 'Enter a name, a valid email, and a password of at least 12 characters.');
    }
    const passwordHash = await bcrypt.hash(password, 12);
    let user;
    try {
      const { rows } = await db.query(`INSERT INTO users (id, name, email, password_hash)
        VALUES ($1, $2, $3, $4) RETURNING id, name, email, role`,
      [randomUUID(), name.trim(), email.trim().toLowerCase(), passwordHash]);
      user = rows[0];
    } catch (error) {
      if (error.code === '23505') return fail(res, 409, 'An account with that email already exists.');
      throw error;
    }
    await beginSession(req, res, user);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', authLimit, async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || Buffer.byteLength(password) > 72) {
      return fail(res, 400, 'Enter your email and password.');
    }
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = rows[0];
    // A valid fixed bcrypt hash avoids a fast response for nonexistent accounts.
    const matched = await bcrypt.compare(password, user?.password_hash ?? '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW');
    if (!matched || !user || user.account_status !== 'active') return fail(res, 401, 'Email or password is incorrect.');
    await beginSession(req, res, user);
    res.json({ user: publicUser(user) });
  });

  app.get('/api/auth/me', sessionUser, (req, res) => res.json({ user: publicUser(req.user) }));
  app.post('/api/auth/logout', async (req, res) => {
    if (req.cookies[COOKIE]) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(req.cookies[COOKIE])]);
    res.clearCookie(COOKIE, { httpOnly: true, secure: production, sameSite: 'lax', path: '/' });
    res.status(204).end();
  });

  app.get('/api/goals', sessionUser, async (req, res) => {
    const { rows } = await db.query(`SELECT g.*, p.id AS stake_photo_id FROM goals g
      LEFT JOIN photos p ON p.goal_id = g.id WHERE g.owner_id = $1 ORDER BY g.created_at DESC`, [req.user.id]);
    res.json({ goals: rows });
  });

  app.post('/api/goals', sessionUser, async (req, res) => {
    const { title, description = '', targetDate = null } = req.body ?? {};
    const validDate = targetDate === null || (typeof targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) &&
      Number.isFinite(Date.parse(targetDate)) && new Date(targetDate).toISOString().slice(0, 10) === targetDate);
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || typeof description !== 'string' || description.length > 1000 || !validDate) {
      return fail(res, 400, 'Enter a goal title (up to 120 characters), a short description, and a valid target date.');
    }
    const { rows } = await db.query(`INSERT INTO goals (id, owner_id, title, description, target_date)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`, [randomUUID(), req.user.id, title.trim(), description.trim(), targetDate]);
    res.status(201).json({ goal: { ...rows[0], stake_photo_id: null } });
  });

  async function ownGoal(req, res, next) {
    if (!uuid.test(req.params.id)) return fail(res, 404, 'Goal not found.');
    const { rows } = await db.query('SELECT id FROM goals WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
    if (!rows.length) return fail(res, 404, 'Goal not found.');
    next();
  }

  app.post('/api/goals/:id/stake', sessionUser, ownGoal,
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 40 }), upload.single('photo'), async (req, res) => {
      if (!req.file) return fail(res, 400, 'Choose a JPEG, PNG, or WebP photo.');
      let image;
      try {
        const decoder = sharp(req.file.buffer, { limitInputPixels: 16000000, animated: false });
        const metadata = await decoder.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image');
        // Re-encoding removes uploaded filenames, location metadata, and non-image payloads.
        image = await decoder.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
      } catch {
        return fail(res, 400, 'This file is not a supported image. Use a JPEG, PNG, or WebP of at most 5 MB.');
      }
      const id = randomUUID();
      const storageKey = `${id}.webp`;
      const filePath = path.join(photosDir, storageKey);
      await mkdir(photosDir, { recursive: true, mode: 0o700 });
      await writeFile(filePath, image, { mode: 0o600, flag: 'wx' });
      try {
        await db.query('INSERT INTO photos (id, goal_id, storage_key, content_type, byte_size) VALUES ($1, $2, $3, $4, $5)',
          [id, req.params.id, storageKey, 'image/webp', image.length]);
      } catch (error) {
        await unlink(filePath);
        if (error.code === '23505') return fail(res, 409, 'This goal already has a stake photo.');
        throw error;
      }
      res.status(201).json({ photo: { id, url: `/api/photos/${id}` } });
    });

  app.get('/api/photos/:id', sessionUser, async (req, res) => {
    if (!uuid.test(req.params.id)) return fail(res, 404, 'Photo not found.');
    const { rows } = await db.query(`SELECT p.storage_key FROM photos p JOIN goals g ON g.id = p.goal_id
      WHERE p.id = $1 AND g.owner_id = $2`, [req.params.id, req.user.id]);
    if (!rows.length) return fail(res, 404, 'Photo not found.');
    const bytes = await readFile(path.join(photosDir, rows[0].storage_key));
    res.type('webp').send(bytes);
  });

  app.get('/api/admin/users', sessionUser, async (req, res) => {
    if (req.user.role !== 'admin') return fail(res, 403, 'Administrator access is required.');
    const { rows } = await db.query('SELECT id, name, email, role, account_status FROM users ORDER BY created_at DESC LIMIT 100');
    res.json({ users: rows });
  });

  app.use('/api', (_req, res) => fail(res, 404, 'Endpoint not found.'));
  if (serveFrontend) {
    app.use(express.static(path.resolve('dist')));
    app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
  }
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) return fail(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'Upload one photo of at most 5 MB.');
    if (error.type === 'entity.parse.failed') return fail(res, 400, 'The request body is not valid JSON.');
    if (error.type === 'entity.too.large') return fail(res, 413, 'The request is too large.');
    console.error('Request failed:', error.code ?? error.name);
    fail(res, 500, 'Something went wrong. Please try again.');
  });
  return app;
}
