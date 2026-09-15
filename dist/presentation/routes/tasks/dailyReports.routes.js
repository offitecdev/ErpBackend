"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const dailyReportService_1 = require("../../../application/services/tasks/dailyReportService");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
/* GÜN SONU RAPORU, montiert unter /api/v1/tasks/daily-reports — für JEDE Person
   des Moduls (nicht nur Admins): sie schreibt ihren eigenen Rapport. Gelesen
   wird er von der Leitung im Arbeitsrapport (/reports/work).
     GET /me   ?date=YYYY-MM-DD&from=ISO&to=ISO&weekStart=YYYY-MM-DD
     PUT /me   { date, from, to, items: string[] }
   Kein responseCache: die Aufgabenzeiten laufen live mit. */
const router = (0, express_1.Router)();
const settingsBody = zod_1.z.object({
    promptTime: zod_1.z.string().trim().max(5),
    endTime: zod_1.z.string().trim().max(5).optional(),
});
const saveBody = zod_1.z.object({
    date: zod_1.z.string().trim().max(10),
    from: zod_1.z.string().trim().max(40),
    to: zod_1.z.string().trim().max(40),
    items: zod_1.z.array((0, taskHttp_1.zText)(dailyReportService_1.DAILY_REPORT_LIMITS.itemChars)).max(dailyReportService_1.DAILY_REPORT_LIMITS.itemsMax),
});
/* Uhrzeit des Fensters je Firma: GET jede Person, PUT nur die Leitung. */
router.get('/settings', (0, taskHttp_1.taskRoute)('tasks.dailyReports.settings.get', async (_req, res) => {
    res.json({ settings: await (0, dailyReportService_1.getDailyReportSetting)((0, taskMiddleware_1.tasksActor)(res).tenantId) });
}));
router.put('/settings', (0, taskHttp_1.taskRoute)('tasks.dailyReports.settings.save', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(settingsBody, req.body);
    res.json({ settings: await (0, dailyReportService_1.saveDailyReportSetting)((0, taskMiddleware_1.tasksActor)(res), body) });
}));
router.get('/me', (0, taskHttp_1.taskRoute)('tasks.dailyReports.get', async (req, res) => {
    res.json(await (0, dailyReportService_1.getMyDailyReport)((0, taskMiddleware_1.tasksActor)(res), req.query));
}));
router.put('/me', (0, taskHttp_1.taskRoute)('tasks.dailyReports.save', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(saveBody, req.body);
    res.json({ report: await (0, dailyReportService_1.saveMyDailyReport)((0, taskMiddleware_1.tasksActor)(res), body) });
}));
exports.default = router;
//# sourceMappingURL=dailyReports.routes.js.map