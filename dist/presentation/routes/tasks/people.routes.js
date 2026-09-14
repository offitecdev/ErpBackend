"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const peopleService_1 = require("../../../application/services/tasks/peopleService");
const taskActor_1 = require("../../../application/services/tasks/taskActor");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
const ResponseCacheMiddleware_1 = require("../../middlewares/ResponseCacheMiddleware");
/* PERSONEN DES MODULS, montiert unter /api/v1/tasks/people.
     GET /directory  — wer in der ausgewählten Firma das Modul benutzen darf
                       (Auswahllisten), für jede Person des Moduls
     GET /           — «Kişiler»: Zähler und Zeiten je Person, nur die Leitung
                       (Zeitraum über `range` = 7|30|90|all oder `from`/`to`) */
const router = (0, express_1.Router)();
router.get('/directory', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks', 'staff'], ttlSec: 120 }), (0, taskHttp_1.taskRoute)('tasks.people.directory', async (_req, res) => {
    res.json({ data: await (0, peopleService_1.listTasksDirectory)((0, taskMiddleware_1.tasksActor)(res)) });
}));
router.get('/', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks', 'staff'], ttlSec: 30 }), (0, taskHttp_1.taskRoute)('tasks.people.stats', async (req, res) => {
    // Kişiler: nur die Administratorrolle; /directory (Personenwahl) bleibt für alle.
    (0, taskActor_1.assertSystemAdmin)((0, taskMiddleware_1.tasksActor)(res));
    res.json(await (0, peopleService_1.getPeopleStats)((0, taskMiddleware_1.tasksActor)(res), req.query));
}));
exports.default = router;
//# sourceMappingURL=people.routes.js.map