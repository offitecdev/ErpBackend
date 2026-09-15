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

export const TASKS_MODULE_KEY = 'tasks';

export const TASKS_PERMISSIONS = {
    view: 'tasks.view',
    manage: 'tasks.manage',
    delete: 'tasks.delete',
} as const;

export const TASKS_PERMISSION_NAMES: readonly string[] = Object.values(TASKS_PERMISSIONS);

/* ── Zustände ───────────────────────────────────────────────────────────── */

export const TASK_STATUSES = [
    'NOT_STARTED',
    'IN_PROGRESS',
    'REVIEW',            // Abschluss beantragt, Leitung entscheidet
    'PENDING_APPROVAL',  // von einem Teammitglied angelegt, Leitung prüft
    'COMPLETED',
    'BLOCKED',           // «Yapılamadı», mit Grund
    'REJECTED',          // Vorschlag eines Teammitglieds abgelehnt
] as const;
export type TaskStatusKey = typeof TASK_STATUSES[number];

/** Zustände, in denen eine Aufgabe nicht mehr offen ist. */
export const CLOSED_TASK_STATUSES: readonly TaskStatusKey[] = ['COMPLETED', 'REJECTED'];

/** Was die Leitung von Hand setzen darf (Menü «Durum», Spalten der Pano). */
export const MANUAL_TASK_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED'] as const;
export type ManualTaskStatus = typeof MANUAL_TASK_STATUSES[number];

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];

export const TASK_ORIGINS = ['MANAGER', 'MEMBER'] as const;
export type TaskOrigin = typeof TASK_ORIGINS[number];

/** Abschlussanfrage eines Verantwortlichen. */
export const APPROVAL_STATES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type ApprovalState = typeof APPROVAL_STATES[number];

/** Prüfung einer Aufgabe, die ein Teammitglied selbst angelegt hat. */
export const REVIEW_STATES = ['APPROVED', 'PENDING', 'REJECTED'] as const;
export type ReviewState = typeof REVIEW_STATES[number];

export const isTaskStatus = (value: unknown): value is TaskStatusKey =>
    typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);

export const isOpenTaskStatus = (status: string): boolean =>
    !(CLOSED_TASK_STATUSES as readonly string[]).includes(status);

/* ── Etiketten ──────────────────────────────────────────────────────────── */

/** Die ruhige Palette aus Görevly — keine bunten Sonderfarben. */
export const LABEL_COLORS = ['gray', 'blue', 'green', 'orange', 'red', 'purple'] as const;
export type LabelColor = typeof LABEL_COLORS[number];

/** Farbe aus dem Namen, wortgleich zu Görevly `U.colorFor`. */
export const labelColorFor = (seed: string): LabelColor => {
    let hash = 0;
    const text = String(seed || '');
    for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) % 99991;
    }
    return LABEL_COLORS[hash % LABEL_COLORS.length] ?? 'gray';
};

/* ── Persönliche Einstellungen ──────────────────────────────────────────── */

export const REMINDER_LEAD_MINUTES = [10, 30, 60, 120] as const;
export const DEFAULT_REMINDER_LEAD_MINUTES = 30;

/* ── Verlauf («Geçmiş») ─────────────────────────────────────────────────── */

export const ACTIVITY = {
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
    PARTNER_REQUESTED: 'PARTNER_REQUESTED',
    PARTNER_REQUEST_CANCELLED: 'PARTNER_REQUEST_CANCELLED',
    PARTNER_REJECTED: 'PARTNER_REJECTED',
} as const;
export type ActivityType = typeof ACTIVITY[keyof typeof ACTIVITY];

/* ── Benachrichtigungen (Tabelle Notification) ──────────────────────────────
   Typnamen bewusst mit TASKS_-Vorsatz und ohne «REPORT»/«ERROR»/«STAFF»:
   das Glockensymbol der Oberfläche wählt die Farbe nach Teilwörtern. */

export const NOTIFY = {
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
    PARTNER_REQUEST: 'TASKS_PARTNER_REQUEST',
    PARTNER_APPROVED: 'TASKS_PARTNER_APPROVED',
    PARTNER_REJECTED: 'TASKS_PARTNER_REJECTED',
} as const;
export type NotifyType = typeof NOTIFY[keyof typeof NOTIFY];

/** i18n-Schlüssel der Oberfläche: `${key}.title` / `.message` / `.messageNoActor`. */
export const NOTIFY_I18N: Record<NotifyType, string> = {
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
    TASKS_PARTNER_REQUEST: 'notify.tasksModule.partnerRequest',
    TASKS_PARTNER_APPROVED: 'notify.tasksModule.partnerApproved',
    TASKS_PARTNER_REJECTED: 'notify.tasksModule.partnerRejected',
};

/** Adressen der Oberfläche, auf die eine Benachrichtigung springt. */
export const taskLinkUrl = (taskId: string): string => `/tasks/${taskId}`;
export const roomLinkUrl = (roomId: string): string => `/tasks/chat/${roomId}`;

/* ── Erinnerungsschleife ────────────────────────────────────────────────── */

export const REMINDER_KINDS = ['REMINDER', 'DUE_SOON', 'OVERDUE', 'CHECK_REMINDER'] as const;
export type ReminderKind = typeof REMINDER_KINDS[number];

/* ── Inhalt (Blockeditor) ───────────────────────────────────────────────── */

export const BLOCK_TYPES = ['p', 'h2', 'h3', 'bullet', 'number', 'quote', 'divider', 'table', 'checklist', 'image', 'file'] as const;
export type BlockType = typeof BLOCK_TYPES[number];

/** Blöcke mit Inline-Auszeichnung im `text`. */
export const TEXT_BLOCK_TYPES: ReadonlySet<string> = new Set(['p', 'h2', 'h3', 'bullet', 'number', 'quote']);

/** Nur die Leitung darf diese Blöcke NEU einfügen (Görevly `editor.full`). */
export const MANAGER_ONLY_BLOCK_TYPES: ReadonlySet<string> = new Set(['table', 'divider']);

export const BLOCK_ALIGNMENTS = ['left', 'center', 'right'] as const;

/* ── Dateien und Chat ───────────────────────────────────────────────────── */

export const ATTACHMENT_KINDS = ['TASK', 'COMMENT', 'CHAT'] as const;
export type AttachmentKind = typeof ATTACHMENT_KINDS[number];

export const CHAT_MESSAGE_TYPES = ['TEXT', 'SYSTEM'] as const;
export const CHAT_SYSTEM_EVENTS = ['ROOM_CREATED', 'MEMBER_ADDED', 'MEMBER_REMOVED', 'TASK_LINKED'] as const;
export type ChatSystemEvent = typeof CHAT_SYSTEM_EVENTS[number];

/* ── Grenzen ────────────────────────────────────────────────────────────── */

export const TASK_LIMITS = {
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
} as const;

/** Position einer neuen Karte auf der Pano: Abstand zwischen zwei Karten. */
export const BOARD_POSITION_STEP = 1024;
