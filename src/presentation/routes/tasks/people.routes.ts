import { Router } from 'express';

import { getPeopleStats, listTasksDirectory } from '../../../application/services/tasks/peopleService';
import { assertSystemAdmin } from '../../../application/services/tasks/taskActor';
import { taskRoute } from './taskHttp';
import { tasksActor } from './taskMiddleware';
import { responseCache } from '../../middlewares/ResponseCacheMiddleware';

/* PERSONEN DES MODULS, montiert unter /api/v1/tasks/people.
     GET /directory  — wer in der ausgewählten Firma das Modul benutzen darf
                       (Auswahllisten), für jede Person des Moduls
     GET /           — «Kişiler»: Zähler und Zeiten je Person, nur die Leitung
                       (Zeitraum über `range` = 7|30|90|all oder `from`/`to`) */

const router = Router();

router.get('/directory', responseCache({ namespaces: ['tasks', 'staff'], ttlSec: 120 }), taskRoute('tasks.people.directory', async (_req, res) => {
    res.json({ data: await listTasksDirectory(tasksActor(res)) });
}));

router.get('/', responseCache({ namespaces: ['tasks', 'staff'], ttlSec: 30 }), taskRoute('tasks.people.stats', async (req, res) => {
    // Kişiler: nur die Administratorrolle; /directory (Personenwahl) bleibt für alle.
    assertSystemAdmin(tasksActor(res));
    res.json(await getPeopleStats(tasksActor(res), req.query as Record<string, unknown>));
}));

export default router;
