import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import { NOTIFY_I18N, type NotifyType } from './taskConstants';
import { getTasksPeople } from './taskPeople';

/**
 * ── BENACHRICHTIGUNGEN DES GÖREVLER-MODULS ──────────────────────────────────
 *
 * Schreibt in die gemeinsame Tabelle `Notification`: Glocke und macOS-Banner
 * der Oberfläche holen die Zeilen von selbst (Abfrage alle 60 s). Regeln:
 *   • nie an die handelnde Person selbst;
 *   • nur an Personen der Firma, die das Modul benutzen dürfen — immer mit
 *     Empfänger (`recipientEmployeeId: null` wäre eine Rundmeldung an alle);
 *   • `metadata.i18n` trägt Schlüssel + Parameter, damit jede Leserin den Satz
 *     in ihrer Sprache sieht; `title`/`message` sind nur das Rückfallnetz;
 *   • `coalesceUnread` (Chat): eine noch ungelesene Meldung desselben Typs auf
 *     dasselbe Ziel wird aufgefrischt statt eine zweite anzulegen — sonst
 *     stapelt jede Chatnachricht einen eigenen Banner.
 * Ein Fehler hier bricht nie die eigentliche Handlung ab: er wird protokolliert.
 */

export interface TaskNotificationInput {
    tenantId: string;
    type: NotifyType;
    recipientIds: Iterable<string | null | undefined>;
    /** Wird nie benachrichtigt. */
    actorId?: string | null;
    /** Deutsches Rückfallnetz (Titel höchstens 191 Zeichen). */
    title: string;
    message: string;
    linkUrl: string;
    /** i18n-Parameter, z. B. { actor, title }. */
    params?: Record<string, unknown>;
    /** Zusätzliche Kennungen in metadata (taskId, roomId, itemId …). */
    meta?: Record<string, unknown>;
    coalesceUnread?: boolean;
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export const notifyTaskPeople = async (input: TaskNotificationInput): Promise<number> => {
    try {
        const people = await getTasksPeople(input.tenantId);
        const recipients = [...new Set([...input.recipientIds].filter((id): id is string => Boolean(id)))]
            .filter((id) => id !== input.actorId && people.has(id));
        if (!recipients.length) return 0;

        const title = clip(String(input.title || ''), 191);
        const message = clip(String(input.message || ''), 2000);
        const linkUrl = clip(String(input.linkUrl || ''), 191);
        const metadata = {
            ...(input.meta ?? {}),
            module: 'tasks',
            i18n: { key: NOTIFY_I18N[input.type], params: input.params ?? {} },
        } as Prisma.InputJsonValue;

        let pending = recipients;
        if (input.coalesceUnread) {
            const unread = await prisma.notification.findMany({
                where: {
                    tenantId: input.tenantId,
                    type: input.type,
                    linkUrl,
                    isRead: false,
                    recipientEmployeeId: { in: recipients },
                },
                select: { id: true, recipientEmployeeId: true },
            });
            if (unread.length) {
                await prisma.notification.updateMany({
                    where: { id: { in: unread.map((row) => row.id) } },
                    data: { title, message, metadata, createdAt: new Date() },
                });
                const refreshed = new Set(unread.map((row) => row.recipientEmployeeId));
                pending = recipients.filter((id) => !refreshed.has(id));
            }
        }

        if (pending.length) {
            await prisma.notification.createMany({
                data: pending.map((recipientEmployeeId) => ({
                    id: nanoid(12),
                    tenantId: input.tenantId,
                    recipientEmployeeId,
                    type: input.type,
                    title,
                    message,
                    linkUrl,
                    metadata,
                })),
            });
        }
        return recipients.length;
    } catch (error) {
        console.warn(`[tasks.notify] ${input.type} konnte nicht geschrieben werden`, error);
        return 0;
    }
};

/** Ohne Warten: die Antwort an den Browser hängt nicht an der Glocke. */
export const queueTaskNotification = (input: TaskNotificationInput): void => {
    void notifyTaskPeople(input);
};
