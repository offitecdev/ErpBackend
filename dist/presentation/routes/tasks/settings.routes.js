"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const settingsService_1 = require("../../../application/services/tasks/settingsService");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
const ResponseCacheMiddleware_1 = require("../../middlewares/ResponseCacheMiddleware");
/* PERSÖNLICHE EINSTELLUNGEN, montiert unter /api/v1/tasks/settings — heute nur
   der Vorlauf für «Termin naht» (10 | 30 | 60 | 120 Minuten). */
const router = (0, express_1.Router)();
const settingsBody = zod_1.z.object({
    reminderLeadMinutes: zod_1.z.number().int().refine((value) => taskConstants_1.REMINDER_LEAD_MINUTES.includes(value), { message: `Erlaubt: ${taskConstants_1.REMINDER_LEAD_MINUTES.join(', ')}` }),
});
router.get('/me', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 60 }), (0, taskHttp_1.taskRoute)('tasks.settings.get', async (_req, res) => {
    res.json({ settings: await (0, settingsService_1.getMyTaskSettings)((0, taskMiddleware_1.tasksActor)(res)) });
}));
router.put('/me', (0, taskHttp_1.taskRoute)('tasks.settings.save', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(settingsBody, req.body);
    const settings = await (0, settingsService_1.saveMyTaskSettings)((0, taskMiddleware_1.tasksActor)(res), {
        reminderLeadMinutes: body.reminderLeadMinutes,
    });
    res.json({ settings });
}));
exports.default = router;
//# sourceMappingURL=settings.routes.js.map