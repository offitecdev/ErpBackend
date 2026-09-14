import { Router } from 'express';

import {
    getMyReport,
    getPersonReport,
    getTaskReport,
    getTeamReport,
} from '../../../application/services/tasks/reportService';
import { getWorkReport } from '../../../application/services/tasks/workReportService';
import { routeParam, taskRoute } from './taskHttp';
import { tasksActor } from './taskMiddleware';
import { responseCache } from '../../middlewares/ResponseCacheMiddleware';

/* BERICHTE, montiert unter /api/v1/tasks/reports. Vorgabe Samet: «raporlar da
   sadece pdf olsun grafik falan olmasın» — hier stehen nur Zahlen und
   Tabellen, das PDF baut die Oberfläche. Zeitraum: `range` = 7|30|90|all oder
   `from`/`to` (ISO).
     GET /team              Teambericht (Leitung)
     GET /me                eigener Bericht (jede Person des Moduls)
     GET /person/:id        Bericht einer Person (Leitung, oder die Person selbst)
     GET /task/:taskId      Aufgabenbericht (Leitung)
     GET /work              Arbeitsrapport EINER Person, Tag/Woche: `from`/`to` (ISO) + `person`
                            (leer = selbst; Teammitglied = nur sich selbst) */

const router = Router();

router.get('/work', responseCache({ namespaces: ['tasks'], ttlSec: 30 }), taskRoute('tasks.reports.work', async (req, res) => {
    res.json(await getWorkReport(tasksActor(res), req.query as Record<string, unknown>));
}));

router.get('/team', responseCache({ namespaces: ['tasks'], ttlSec: 30 }), taskRoute('tasks.reports.team', async (req, res) => {
    res.json(await getTeamReport(tasksActor(res), req.query as Record<string, unknown>));
}));

router.get('/me', responseCache({ namespaces: ['tasks'], ttlSec: 30 }), taskRoute('tasks.reports.me', async (req, res) => {
    res.json(await getMyReport(tasksActor(res), req.query as Record<string, unknown>));
}));

router.get('/person/:employeeId', responseCache({ namespaces: ['tasks'], ttlSec: 30 }), taskRoute('tasks.reports.person', async (req, res) => {
    res.json(await getPersonReport(tasksActor(res), routeParam(req, 'employeeId'), req.query as Record<string, unknown>));
}));

router.get('/task/:taskId', responseCache({ namespaces: ['tasks'], ttlSec: 30 }), taskRoute('tasks.reports.task', async (req, res) => {
    res.json(await getTaskReport(tasksActor(res), routeParam(req, 'taskId')));
}));

export default router;
