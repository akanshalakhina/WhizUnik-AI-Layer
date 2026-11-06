import { Router } from 'express';
import type { AppConfig } from '../config';
import { authenticate } from '../middleware';
import { getRecord, listRecords, recordTypesFor } from '../services/records.service';
import type { Db } from '../types';

/** Read-only record viewer used by AI source links. Every query is scoped to the caller's client and role. */
export function createRecordsRouter(cfg: AppConfig, db: Db, now: () => Date): Router {
  const router = Router();
  router.use(authenticate(cfg, db));

  router.get('/', (req, res) => {
    res.json({ types: recordTypesFor(req.user!.role) });
  });

  router.get('/:type', (req, res, next) => {
    try {
      res.json(listRecords(db, req.user!.clientId, req.user!.role, req.params.type, now()));
    } catch (e) {
      next(e);
    }
  });

  router.get('/:type/:ref', (req, res, next) => {
    try {
      res.json(getRecord(db, req.user!.clientId, req.user!.role, req.params.type, req.params.ref, now()));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
