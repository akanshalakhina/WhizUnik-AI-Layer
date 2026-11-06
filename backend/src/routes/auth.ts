import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { AppError } from '../errors';
import { authenticate, signToken } from '../middleware';
import type { Db, Role } from '../types';

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().min(3).max(200),
  password: z.string().min(1).max(200),
});

export function createAuthRouter(cfg: AppConfig, db: Db): Router {
  const router = Router();
  // Compared against when the e-mail is unknown, so response time does not reveal which e-mails exist.
  const dummyHash = bcrypt.hashSync('not-a-real-password', cfg.bcryptRounds);

  router.post('/login', (req, res, next) => {
    try {
      const body = LoginBody.parse(req.body);
      const user = db
        .prepare(
          `SELECT u.id, u.client_id, u.name, u.email, u.role, u.password_hash, c.name AS client_name
             FROM users u JOIN clients c ON c.id = u.client_id WHERE u.email = ? AND u.active = 1`,
        )
        .get(body.email) as
        | { id: number; client_id: number; name: string; email: string; role: Role; password_hash: string; client_name: string }
        | undefined;
      const ok = bcrypt.compareSync(body.password, user?.password_hash ?? dummyHash);
      if (!user || !ok) throw new AppError('INVALID_CREDENTIALS', 401, 'Incorrect e-mail or password.');
      res.json({
        token: signToken(cfg, user.id),
        user: { id: user.id, name: user.name, email: user.email, role: user.role, clientId: user.client_id, clientName: user.client_name },
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/me', authenticate(cfg, db), (req, res) => {
    const u = req.user!;
    const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(u.clientId) as { name: string };
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, clientId: u.clientId, clientName: client.name } });
  });

  return router;
}
