"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const reportService_1 = require("../../../application/services/tasks/reportService");
const workReportService_1 = require("../../../application/services/tasks/workReportService");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
const ResponseCacheMiddleware_1 = require("../../middlewares/ResponseCacheMiddleware");
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
const router = (0, express_1.Router)();
router.get('/work', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 30 }), (0, taskHttp_1.taskRoute)('tasks.reports.work', async (req, res) => {
    res.json(await (0, workReportService_1.getWorkReport)((0, taskMiddleware_1.tasksActor)(res), req.query));
}));
router.get('/team', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 30 }), (0, taskHttp_1.taskRoute)('tasks.reports.team', async (req, res) => {
    res.json(await (0, reportService_1.getTeamReport)((0, taskMiddleware_1.tasksActor)(res), req.query));
}));
router.get('/me', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 30 }), (0, taskHttp_1.taskRoute)('tasks.reports.me', async (req, res) => {
    res.json(await (0, reportService_1.getMyReport)((0, taskMiddleware_1.tasksActor)(res), req.query));
}));
router.get('/person/:employeeId', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 30 }), (0, taskHttp_1.taskRoute)('tasks.reports.person', async (req, res) => {
    res.json(await (0, reportService_1.getPersonReport)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'employeeId'), req.query));
}));
router.get('/task/:taskId', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 30 }), (0, taskHttp_1.taskRoute)('tasks.reports.task', async (req, res) => {
    res.json(await (0, reportService_1.getTaskReport)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId')));
}));
exports.default = router;
//# sourceMappingURL=reports.routes.js.map