import { Router } from 'express';

import {
    attachmentPublicUrl,
    deleteAttachment,
    listTaskAttachments,
    readAttachmentContent,
    uploadTaskAttachments,
} from '../../../application/services/tasks/attachmentService';
import { TASK_LIMITS } from '../../../application/services/tasks/taskConstants';
import { contentDisposition, isInlineContentType } from '../../../application/services/tasks/taskFiles';
import { queryFlag, routeParam, taskRoute, uploadedFiles, withTaskUpload } from './taskHttp';
import { tasksActor } from './taskMiddleware';
import { responseCache } from '../../middlewares/ResponseCacheMiddleware';

/* DATEIEN DES GÖREVLER-MODULS, montiert unter /api/v1/tasks: der Reiter
   «Dosyalar» einer Aufgabe und der EINE Weg, auf dem der Browser die Bytes
   irgendeiner Moduldatei liest (Aufgabe, Kommentar, Chat). Anmeldung und
   Modulzugang prüft index.ts davor, die Regeln stehen im attachmentService.
   Feste Pfade vor Parameterpfaden. */

const router = Router();

/* GET /attachments/:attachmentId/content — Bilder und PDFs zeigt der Browser
   an, alles andere lädt er herunter; `?download=1` erzwingt den Download.
   Nur privat zwischengespeichert: ob jemand die Datei sehen darf, gilt je Person. */
router.get('/attachments/:attachmentId/content', taskRoute('tasks.attachments.content', async (req, res) => {
    const download = queryFlag(req.query.download);
    // Bild/PDF in R2 zum Ansehen: nach der Prüfung direkt zu Cloudflare weiterleiten.
    const direct = download ? null : await attachmentPublicUrl(tasksActor(res), routeParam(req, 'attachmentId'));
    if (direct) {
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.redirect(302, direct);
        return;
    }
    const file = await readAttachmentContent(tasksActor(res), routeParam(req, 'attachmentId'));
    const inline = isInlineContentType(file.contentType) && !download;
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('Content-Disposition', contentDisposition(file.fileName, inline));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(file.body);
}));

// DELETE /attachments/:attachmentId — die Regel je Art (Aufgabe, Kommentar, Chat) steht im Dienst.
router.delete('/attachments/:attachmentId', taskRoute('tasks.attachments.delete', async (req, res) => {
    await deleteAttachment(tasksActor(res), routeParam(req, 'attachmentId'));
    res.status(204).end();
}));

// GET /:taskId/attachments — die Dateien des Reiters «Dosyalar».
router.get('/:taskId/attachments', responseCache({ namespaces: ['tasks'], ttlSec: 15 }), taskRoute('tasks.attachments.list', async (req, res) => {
    res.json(await listTaskAttachments(tasksActor(res), routeParam(req, 'taskId')));
}));

// POST /:taskId/attachments — multipart `files`.
router.post(
    '/:taskId/attachments',
    withTaskUpload(TASK_LIMITS.filesPerUpload),
    taskRoute('tasks.attachments.upload', async (req, res) => {
        const created = await uploadTaskAttachments(tasksActor(res), routeParam(req, 'taskId'), uploadedFiles(req));
        res.status(201).json(created);
    }),
);

export default router;
