"use strict";
/**
 * ── GÖREVLER / TASKS-MODUL: FESTE WERTE (13.09.2026, Vorgabe Samet) ─────────
 *
 * Ein eigenständiges Aufgabenmodul nach dem Vorbild «Görevly». Diese Datei
 * hält nur Werte und reine Hilfen — keine Datenbank, kein Express. Alles, was
 * zwei Stellen des Moduls gemeinsam wissen müssen, steht hier genau einmal.
 *
 * Rollen: Die Leitung («Yönetici») trägt `tasks.manage` (Seitenstufe 2), ein
 * Teammitglied («Ekip üyesi») nur `tasks.view` (Stufe 1); Stufe 3 bringt
 * zusätzlich `tasks.delete`. Die Administratorrolle hat alles.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOARD_POSITION_STEP = exports.TASK_LIMITS = exports.CHAT_SYSTEM_EVENTS = exports.CHAT_MESSAGE_TYPES = exports.ATTACHMENT_KINDS = exports.BLOCK_ALIGNMENTS = exports.MANAGER_ONLY_BLOCK_TYPES = exports.TEXT_BLOCK_TYPES = exports.BLOCK_TYPES = exports.REMINDER_KINDS = exports.roomLinkUrl = exports.taskLinkUrl = exports.NOTIFY_I18N = exports.NOTIFY = exports.ACTIVITY = exports.DEFAULT_REMINDER_LEAD_MINUTES = exports.REMINDER_LEAD_MINUTES = exports.labelColorFor = exports.LABEL_COLORS = exports.isOpenTaskStatus = exports.isTaskStatus = exports.REVIEW_STATES = exports.APPROVAL_STATES = exports.TASK_ORIGINS = exports.TASK_PRIORITIES = exports.MANUAL_TASK_STATUSES = exports.CLOSED_TASK_STATUSES = exports.TASK_STATUSES = exports.TASKS_PERMISSION_NAMES = exports.TASKS_PERMISSIONS = exports.TASKS_MODULE_KEY = void 0;
exports.TASKS_MODULE_KEY = 'tasks';
exports.TASKS_PERMISSIONS = {
    view: 'tasks.view',
    manage: 'tasks.manage',
    delete: 'tasks.delete',
};
exports.TASKS_PERMISSION_NAMES = Object.values(exports.TASKS_PERMISSIONS);
/* ── Zustände ───────────────────────────────────────────────────────────── */
exports.TASK_STATUSES = [
    'NOT_STARTED',
    'IN_PROGRESS',
    'REVIEW', // Abschluss beantragt, Leitung entscheidet
    'PENDING_APPROVAL', // von einem Teammitglied angelegt, Leitung prüft
    'COMPLETED',
    'BLOCKED', // «Yapılamadı», mit Grund
    'REJECTED', // Vorschlag eines Teammitglieds abgelehnt
];
/** Zustände, in denen eine Aufgabe nicht mehr offen ist. */
exports.CLOSED_TASK_STATUSES = ['COMPLETED', 'REJECTED'];
/** Was die Leitung von Hand setzen darf (Menü «Durum», Spalten der Pano). */
exports.MANUAL_TASK_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED'];
exports.TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];
exports.TASK_ORIGINS = ['MANAGER', 'MEMBER'];
/** Abschlussanfrage eines Verantwortlichen. */
exports.APPROVAL_STATES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'];
/** Prüfung einer Aufgabe, die ein Teammitglied selbst angelegt hat. */
exports.REVIEW_STATES = ['APPROVED', 'PENDING', 'REJECTED'];
const isTaskStatus = (value) => typeof value === 'string' && exports.TASK_STATUSES.includes(value);
exports.isTaskStatus = isTaskStatus;
const isOpenTaskStatus = (status) => !exports.CLOSED_TASK_STATUSES.includes(status);
exports.isOpenTaskStatus = isOpenTaskStatus;
/* ── Etiketten ──────────────────────────────────────────────────────────── */
/** Die ruhige Palette aus Görevly — keine bunten Sonderfarben. */
exports.LABEL_COLORS = ['gray', 'blue', 'green', 'orange', 'red', 'purple'];
/** Farbe aus dem Namen, wortgleich zu Görevly `U.colorFor`. */
const labelColorFor = (seed) => {
    let hash = 0;
    const text = String(seed || '');
    for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) % 99991;
    }
    return exports.LABEL_COLORS[hash % exports.LABEL_COLORS.length] ?? 'gray';
};
exports.labelColorFor = labelColorFor;
/* ── Persönliche Einstellungen ──────────────────────────────────────────── */
exports.REMINDER_LEAD_MINUTES = [10, 30, 60, 120];
exports.DEFAULT_REMINDER_LEAD_MINUTES = 30;
/* ── Verlauf («Geçmiş») ─────────────────────────────────────────────────── */
exports.ACTIVITY = {
    CREATED: 'CREATED',
    DUPLICATED: 'DUPLICATED',
    UPDATED: 'UPDATED',
    STATUS: 'STATUS',
    ASSIGNED: 'ASSIGNED',
    UNASSIGNED: 'UNASSIGNED',
    COMMENT: 'COMMENT',
    ATTACHMENT: 'ATTACHMENT',
    TIMER_START: 'TIMER_START',
    TIMER_PAUSE: 'TIMER_PAUSE',
    CHECK_DONE: 'CHECK_DONE',
    CHECK_UNDONE: 'CHECK_UNDONE',
    CHECKLIST_ADD: 'CHECKLIST_ADD',
    COMPLETION_REQUESTED: 'COMPLETION_REQUESTED',
    COMPLETION_APPROVED: 'COMPLETION_APPROVED',
    COMPLETION_REJECTED: 'COMPLETION_REJECTED',
    COMPLETION_CANCELLED: 'COMPLETION_CANCELLED',
    REVIEW_APPROVED: 'REVIEW_APPROVED',
    REVIEW_REJECTED: 'REVIEW_REJECTED',
    BLOCKED: 'BLOCKED',
    DELETE_REQUESTED: 'DELETE_REQUESTED',
    DELETE_REQUEST_CANCELLED: 'DELETE_REQUEST_CANCELLED',
    DELETE_REJECTED: 'DELETE_REJECTED',
};
/* ── Benachrichtigungen (Tabelle Notification) ──────────────────────────────
   Typnamen bewusst mit TASKS_-Vorsatz und ohne «REPORT»/«ERROR»/«STAFF»:
   das Glockensymbol der Oberfläche wählt die Farbe nach Teilwörtern. */
exports.NOTIFY = {
    ASSIGNED: 'TASKS_ASSIGNED',
    REVIEW_REQUEST: 'TASKS_REVIEW_REQUEST',
    COMPLETION_REQUEST: 'TASKS_COMPLETION_REQUEST',
    COMPLETION_APPROVED: 'TASKS_COMPLETION_APPROVED',
    COMPLETION_REJECTED: 'TASKS_COMPLETION_REJECTED',
    REVIEW_APPROVED: 'TASKS_REVIEW_APPROVED',
    REVIEW_REJECTED: 'TASKS_REVIEW_REJECTED',
    COMMENT: 'TASKS_COMMENT',
    REMINDER: 'TASKS_REMINDER',
    DUE_SOON: 'TASKS_DUE_SOON',
    OVERDUE: 'TASKS_OVERDUE',
    CHECK_REMINDER: 'TASKS_CHECK_REMINDER',
    CHAT_ADDED: 'TASKS_CHAT_ADDED',
    CHAT_MESSAGE: 'TASKS_CHAT_MESSAGE',
    DELETE_REQUEST: 'TASKS_DELETE_REQUEST',
    DELETE_APPROVED: 'TASKS_DELETE_APPROVED',
    DELETE_REJECTED: 'TASKS_DELETE_REJECTED',
};
/** i18n-Schlüssel der Oberfläche: `${key}.title` / `.message` / `.messageNoActor`. */
exports.NOTIFY_I18N = {
    TASKS_ASSIGNED: 'notify.tasksModule.assigned',
    TASKS_REVIEW_REQUEST: 'notify.tasksModule.reviewRequest',
    TASKS_COMPLETION_REQUEST: 'notify.tasksModule.completionRequest',
    TASKS_COMPLETION_APPROVED: 'notify.tasksModule.completionApproved',
    TASKS_COMPLETION_REJECTED: 'notify.tasksModule.completionRejected',
    TASKS_REVIEW_APPROVED: 'notify.tasksModule.reviewApproved',
    TASKS_REVIEW_REJECTED: 'notify.tasksModule.reviewRejected',
    TASKS_COMMENT: 'notify.tasksModule.comment',
    TASKS_REMINDER: 'notify.tasksModule.reminder',
    TASKS_DUE_SOON: 'notify.tasksModule.dueSoon',
    TASKS_OVERDUE: 'notify.tasksModule.overdue',
    TASKS_CHECK_REMINDER: 'notify.tasksModule.checkReminder',
    TASKS_CHAT_ADDED: 'notify.tasksModule.chatAdded',
    TASKS_CHAT_MESSAGE: 'notify.tasksModule.chatMessage',
    TASKS_DELETE_REQUEST: 'notify.tasksModule.deleteRequest',
    TASKS_DELETE_APPROVED: 'notify.tasksModule.deleteApproved',
    TASKS_DELETE_REJECTED: 'notify.tasksModule.deleteRejected',
};
/** Adressen der Oberfläche, auf die eine Benachrichtigung springt. */
const taskLinkUrl = (taskId) => `/tasks/${taskId}`;
exports.taskLinkUrl = taskLinkUrl;
const roomLinkUrl = (roomId) => `/tasks/chat/${roomId}`;
exports.roomLinkUrl = roomLinkUrl;
/* ── Erinnerungsschleife ────────────────────────────────────────────────── */
exports.REMINDER_KINDS = ['REMINDER', 'DUE_SOON', 'OVERDUE', 'CHECK_REMINDER'];
/* ── Inhalt (Blockeditor) ───────────────────────────────────────────────── */
exports.BLOCK_TYPES = ['p', 'h2', 'h3', 'bullet', 'number', 'quote', 'divider', 'table', 'checklist', 'image', 'file'];
/** Blöcke mit Inline-Auszeichnung im `text`. */
exports.TEXT_BLOCK_TYPES = new Set(['p', 'h2', 'h3', 'bullet', 'number', 'quote']);
/** Nur die Leitung darf diese Blöcke NEU einfügen (Görevly `editor.full`). */
exports.MANAGER_ONLY_BLOCK_TYPES = new Set(['table', 'divider']);
exports.BLOCK_ALIGNMENTS = ['left', 'center', 'right'];
/* ── Dateien und Chat ───────────────────────────────────────────────────── */
exports.ATTACHMENT_KINDS = ['TASK', 'COMMENT', 'CHAT'];
exports.CHAT_MESSAGE_TYPES = ['TEXT', 'SYSTEM'];
exports.CHAT_SYSTEM_EVENTS = ['ROOM_CREATED', 'MEMBER_ADDED', 'MEMBER_REMOVED', 'TASK_LINKED'];
/* ── Grenzen ────────────────────────────────────────────────────────────── */
exports.TASK_LIMITS = {
    titleMax: 200,
    descriptionMax: 10_000,
    noteMax: 2_000,
    labelNameMax: 40,
    checklistTitleMax: 200,
    checklistItemTextMax: 500,
    commentMax: 5_000,
    chatMessageMax: 5_000,
    roomNameMax: 80,
    blocksMax: 500,
    blockIdMax: 40,
    blockTextMax: 20_000,
    blocksBytesMax: 512 * 1024,
    tableRowsMax: 50,
    tableColsMax: 12,
    tableCellMax: 500,
    fileBytesMax: 12 * 1024 * 1024,
    filesPerUpload: 20,
    commentFilesMax: 10,
    chatFilesMax: 10,
    taskFilesBytesMax: 100 * 1024 * 1024,
    listPageSizeDefault: 200,
    listPageSizeMax: 500,
    searchLimit: 30,
    activityLimit: 300,
    chatPageDefault: 50,
    chatPageMax: 200,
    idsPerRequestMax: 200,
    /** Kürzere Messungen zählen nicht (Görevly: «2 sn altı kayıtları yok say»). */
    sessionMinMs: 2_000,
    /** Obergrenze einer Messung — die Spalte ist ein INT. */
    sessionMaxMs: 2_000_000_000,
};
/** Position einer neuen Karte auf der Pano: Abstand zwischen zwei Karten. */
exports.BOARD_POSITION_STEP = 1024;
//# sourceMappingURL=taskConstants.js.map