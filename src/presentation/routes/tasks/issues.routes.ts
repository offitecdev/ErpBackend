import { Router } from 'express';
import { z } from 'zod';

import {
    createTaskIssue,
    deleteTaskIssue,
    listTaskIssues,
    replyToTaskIssue,
    setTaskIssueStatus,
} from '../../../application/services/tasks/issueService';
import { ISSUE_KINDS, TASK_LIMITS } from '../../../application/services/tasks/taskConstants';
import { parseInput, routeParam, taskRoute, uploadedFiles, withTaskUpload, zId, zRequiredLine, zText } from './taskHttp';
import { tasksActor } from './taskMiddleware';
import { responseCache } from '../../middlewares/ResponseCacheMiddleware';

/* SORULAR & SORUNLAR einer Aufgabe (16.09.2026), montiert unter /api/v1/tasks.
   Anmeldung und Modulzugang prüft index.ts davor, die Regeln stehen im
   issueService. Feste Pfade vor Parameterpfaden. */

const router = Router();

/**
 * In einem multipart-Körper ist JEDES Feld eine Zeichenkette — auch die
 * Kennungslisten. Darum nimmt das Schema beides an: eine echte Liste (JSON)
 * oder eine Zeichenkette mit Komma bzw. als JSON-Text. Sonst käme aus dem
 * Fenster mit Datei eine leere Markierung zurück, aus dem ohne Datei nicht.
 */
const looseIds = (max: number) => z.preprocess((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(text);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return text.split(',');
}, z.array(zId).max(max).transform((ids) => [...new Set(ids)]));

/**
 * Der Schalter kommt aus drei Welten: als echtes `true` (JSON), als «true»/«1»
 * (multipart — dort ist jedes Feld eine Zeichenkette) und als 1/0, wenn ein
 * Aufrufer ihn als Zahl schickt. Alle drei gelten; sonst scheitert dieselbe
 * Eingabe je nachdem, ob eine Datei mitgeht.
 */
const looseFlag = z.preprocess((value) => {
    if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    if (typeof value === 'number') return value !== 0;
    return value;
}, z.boolean().optional().default(false));

const issueBody = z.object({
    kind: z.enum(ISSUE_KINDS),
    title: zRequiredLine(TASK_LIMITS.issueTitleMax, 'Eine Frage braucht eine Überschrift.'),
    text: zText(TASK_LIMITS.issueTextMax).optional(),
    important: looseFlag,
    personIds: looseIds(TASK_LIMITS.issuePeopleMax).optional(),
    taskIds: looseIds(TASK_LIMITS.issueTasksMax).optional(),
});

const replyBody = z.object({
    text: zText(TASK_LIMITS.issueTextMax).optional(),
    personIds: looseIds(TASK_LIMITS.issuePeopleMax).optional(),
});

const statusBody = z.object({ resolved: z.boolean() });

// POST /issues/:issueId/replies — antworten (Text, Dateien oder beides).
router.post(
    '/issues/:issueId/replies',
    withTaskUpload(TASK_LIMITS.issueFilesMax),
    taskRoute('tasks.issues.reply', async (req, res) => {
        const { text, personIds } = parseInput(replyBody, req.body);
        const created = await replyToTaskIssue(tasksActor(res), routeParam(req, 'issueId'), {
            text: text ?? '',
            personIds: personIds ?? [],
            files: uploadedFiles(req),
        });
        res.status(201).json(created);
    }),
);

// POST /issues/:issueId/status — «Çözüldü» bzw. wieder öffnen.
router.post('/issues/:issueId/status', taskRoute('tasks.issues.status', async (req, res) => {
    const { resolved } = parseInput(statusBody, req.body);
    res.json(await setTaskIssueStatus(tasksActor(res), routeParam(req, 'issueId'), resolved));
}));

// DELETE /issues/:issueId — wer gefragt hat oder die Leitung; die Dateien gehen mit.
router.delete('/issues/:issueId', taskRoute('tasks.issues.delete', async (req, res) => {
    await deleteTaskIssue(tasksActor(res), routeParam(req, 'issueId'));
    res.status(204).end();
}));

// GET /:taskId/issues — beide Reiter auf einmal, älteste zuerst.
router.get('/:taskId/issues', responseCache({ namespaces: ['tasks'], ttlSec: 15 }), taskRoute('tasks.issues.list', async (req, res) => {
    res.json(await listTaskIssues(tasksActor(res), routeParam(req, 'taskId')));
}));

// POST /:taskId/issues — eine Frage oder ein Problem eröffnen.
router.post(
    '/:taskId/issues',
    withTaskUpload(TASK_LIMITS.issueFilesMax),
    taskRoute('tasks.issues.create', async (req, res) => {
        const input = parseInput(issueBody, req.body);
        const created = await createTaskIssue(tasksActor(res), routeParam(req, 'taskId'), {
            kind: input.kind,
            title: input.title,
            text: input.text ?? '',
            important: input.important,
            personIds: input.personIds ?? [],
            taskIds: input.taskIds ?? [],
            files: uploadedFiles(req),
        });
        res.status(201).json(created);
    }),
);

export default router;
