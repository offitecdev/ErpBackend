"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const liveService_1 = require("../../../application/services/tasks/liveService");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
/* CANLI, montiert unter /api/v1/tasks/live.
     GET /   wer heute woran arbeitet — Leitung: alle Personen des Moduls,
             Teammitglied: nur sich selbst. Tagesgrenzen über `from`/`to` (ISO). */
const router = (0, express_1.Router)();
router.get('/', (0, taskHttp_1.taskRoute)('tasks.live', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await (0, liveService_1.getLiveOverview)((0, taskMiddleware_1.tasksActor)(res), req.query));
}));
exports.default = router;
//# sourceMappingURL=live.routes.js.map