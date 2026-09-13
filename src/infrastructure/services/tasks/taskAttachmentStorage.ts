import path from 'path';

import { DocumentStorage } from '../LocalFileStorage';

/**
 * GÖREVLER-DATEIEN (13.09.2026, Vorgabe Samet): Bilder, PDFs und Büro-
 * dokumente an Aufgaben, Kommentaren und Chatnachrichten des Görevler-Moduls.
 * Eigene Ablage mit eigenem Vorsatz — die Anhänge der CRM-Aufgaben
 * (`crm-task-document`) sind ein anderes Modul und bleiben unberührt.
 *
 * CLOUDFLARE DIREKT (13.09.2026, Samet: «görseller ve PDF'ler Cloudflare'de
 * olmalı»): Bilder und PDFs liefert die eigene Domain am Eimer aus
 * (`R2_PUBLIC_URL`, wie die Terminunterlagen) — schnell, zwischengespeichert,
 * ohne Umweg über den Server. Der Preis wie dort: die Adresse läuft nicht ab,
 * der Schlüssel ist eine UUID. Office-Dateien und Downloads gehen weiter über
 * `GET /tasks/attachments/:id/content`, wo die Berechtigung geprüft wird.
 */
export const taskAttachmentStorage = new DocumentStorage({
    prefix: 'local:tasks-file/',
    directory: process.env.OFFITEC_TASKS_UPLOAD_DIR
        || path.join(process.cwd(), 'storage', 'tasks-files'),
    preferPublicUrl: true,
    extraTypes: {
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-excel': 'xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.ms-powerpoint': 'ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
        'application/vnd.oasis.opendocument.text': 'odt',
        'application/vnd.oasis.opendocument.spreadsheet': 'ods',
        'text/plain': 'txt',
        'text/csv': 'csv',
        'application/zip': 'zip',
    },
});
