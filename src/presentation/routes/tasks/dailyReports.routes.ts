import { Router } from 'express';
import { z } from 'zod';

import {
    DAILY_REPORT_LIMITS,
    getDailyReportSetting,
    getMyDailyReport,
    saveDailyReportSetting,
    saveMyDailyReport,
    uploadDailyReportFiles,
} from '../../../application/services/tasks/dailyReportService';
import { parseInput, taskRoute, uploadedFiles, withTaskUpload, zText } from './taskHttp';
import { tasksActor } from './taskMiddleware';

/* GÜN SONU RAPORU, montiert unter /api/v1/tasks/daily-reports — für JEDE Person
   des Moduls (nicht nur Admins): sie schreibt ihren eigenen Rapport, ein freies
   Blatt in Markdown mit Bildern und Dateien (16.09.2026). Gelesen wird er von
   der Leitung im Arbeitsrapport (/reports/work).
     GET  /me        ?date=YYYY-MM-DD&from=ISO&to=ISO&weekStart=YYYY-MM-DD
     PUT  /me        { date, from, to, body }
     POST /me/files  multipart `files` + Felder date/from/to
   Kein responseCache: der Stand des Tages läuft live mit. */

const router = Router();

const settingsBody = z.object({
    promptTime: z.string().trim().max(5),
    endTime: z.string().trim().max(5).optional(),
});

const dayFields = {
    date: z.string().trim().max(10),
    from: z.string().trim().max(40),
    to: z.string().trim().max(40),
};

const saveBody = z.object({
    ...dayFields,
    body: zText(DAILY_REPORT_LIMITS.bodyChars),
});

const filesBody = z.object(dayFields);

/* Uhrzeit des Fensters je Firma: GET jede Person, PUT nur die Leitung. */
router.get('/settings', taskRoute('tasks.dailyReports.settings.get', async (_req, res) => {
    res.json({ settings: await getDailyReportSetting(tasksActor(res).tenantId) });
}));

router.put('/settings', taskRoute('tasks.dailyReports.settings.save', async (req, res) => {
    const body = parseInput(settingsBody, req.body);
    res.json({ settings: await saveDailyReportSetting(tasksActor(res), body) });
}));

router.get('/me', taskRoute('tasks.dailyReports.get', async (req, res) => {
    res.json(await getMyDailyReport(tasksActor(res), req.query as Record<string, unknown>));
}));

router.put('/me', taskRoute('tasks.dailyReports.save', async (req, res) => {
    const body = parseInput(saveBody, req.body);
    res.json({ report: await saveMyDailyReport(tasksActor(res), body) });
}));

// POST /me/files — Bilder/PDF/Dateien des Blattes (multipart `files`).
router.post(
    '/me/files',
    withTaskUpload(DAILY_REPORT_LIMITS.filesPerUpload),
    taskRoute('tasks.dailyReports.files.upload', async (req, res) => {
        const day = parseInput(filesBody, req.body);
        res.status(201).json(await uploadDailyReportFiles(tasksActor(res), day, uploadedFiles(req)));
    }),
);

export default router;
