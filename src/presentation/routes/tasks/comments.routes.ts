import { Router } from 'express';
import { z } from 'zod';

import { addTaskComment, deleteTaskComment, listTaskComments } from '../../../application/services/tasks/commentService';
import { TASK_LIMITS } from '../../../application/services/tasks/taskConstants';
import { parseInput, routeParam, taskRoute, uploadedFiles, withTaskUpload, zText } from './taskHttp';
import { tasksActor } from './taskMiddleware';
import { responseCache } from '../../middlewares/ResponseCacheMiddleware';

/* KOMMENTARE EINER AUFGABE (Reiter «Yorumlar»), montiert unter /api/v1/tasks.
   Anmeldung und Modulzugang prüft index.ts davor, die Regeln stehen im
   commentService. Feste Pfade vor Parameterpfaden. */

const router = Router();

/** JSON `{ text }` oder multipart mit dem Textfeld `text` und den Dateien `files`. */
const commentBody = z.object({ text: zText(TASK_LIMITS.commentMax).optional() });

// DELETE /comments/:commentId — wer ihn geschrieben hat oder die Leitung; die Dateien gehen mit.
router.delete('/comments/:commentId', taskRoute('tasks.comments.delete', async (req, res) => {
    await deleteTaskComment(tasksActor(res), routeParam(req, 'commentId'));
    res.status(204).end();
}));

// GET /:taskId/comments — alle Kommentare samt Dateien, älteste zuerst.
router.get('/:taskId/comments', responseCache({ namespaces: ['tasks'], ttlSec: 15 }), taskRoute('tasks.comments.list', async (req, res) => {
    res.json(await listTaskComments(tasksActor(res), routeParam(req, 'taskId')));
}));

// POST /:taskId/comments — Text, Dateien oder beides.
router.post(
    '/:taskId/comments',
    withTaskUpload(TASK_LIMITS.commentFilesMax),
    taskRoute('tasks.comments.create', async (req, res) => {
        const { text } = parseInput(commentBody, req.body);
        const created = await addTaskComment(tasksActor(res), routeParam(req, 'taskId'), {
            text: text ?? '',
            files: uploadedFiles(req),
        });
        res.status(201).json(created);
    }),
);

export default router;
