import prisma from '../../../infrastructure/database/prisma.client';

/**
 * Datenbankzugang des Görevler-Moduls: entweder der gemeinsame Client oder die
 * Verbindung einer laufenden Transaktion — dieselben Delegates, dieselben
 * Raw-Aufrufe. Hilfen, die in beiden Lagen laufen, nehmen `db: TasksDb`.
 */
export type TasksDb = Pick<typeof prisma,
    | 'task'
    | 'taskAssignee'
    | 'taskLabel'
    | 'taskLabelLink'
    | 'taskContent'
    | 'taskChecklist'
    | 'taskChecklistItem'
    | 'taskComment'
    | 'taskAttachment'
    | 'taskTimeSession'
    | 'taskActivity'
    | 'taskChatRoom'
    | 'taskChatMember'
    | 'taskChatRoomTask'
    | 'taskChatMessage'
    | 'taskNotifyDispatch'
    | 'taskUserSetting'
    | 'notification'
    | '$executeRaw'
    | '$queryRaw'
>;

export const tasksDb: TasksDb = prisma;

/**
 * Eine Transaktion mit Zeitreserve für die ferne Datenbank (~50–170 ms je
 * Anweisung): Zustandswechsel sperren die Aufgabenzeile (`FOR UPDATE`) und
 * brauchen darum mehrere Rundgänge in EINER Verbindung.
 */
export const runTasksTransaction = <T>(work: (tx: TasksDb) => Promise<T>): Promise<T> =>
    prisma.$transaction((tx) => work(tx as unknown as TasksDb), { maxWait: 10_000, timeout: 30_000 });
