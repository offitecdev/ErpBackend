import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import type { TasksActor } from './taskActor';
import { DEFAULT_REMINDER_LEAD_MINUTES, type REMINDER_LEAD_MINUTES } from './taskConstants';

/**
 * ── PERSÖNLICHE EINSTELLUNGEN («Ayarlar») ───────────────────────────────────
 *
 * Von Görevlys Einstellungen gehört nur EINE auf den Server: der
 * «Hatırlatma payı» — wie lange vor dem Ende «Termin naht» kommt (10, 30, 60
 * oder 120 Minuten). Thema und Desktopmeldungen bleiben Sache des Browsers,
 * Sicherung und Zurücksetzen entfallen (die Daten liegen auf dem Server).
 *
 * Die Zeile gilt je Person über alle Firmen (TaskUserSetting ohne tenantId):
 * niemand will seine Vorwarnzeit je Firma neu setzen. Ohne Zeile gelten
 * 30 Minuten — dieselbe Rückfallzahl nimmt die Erinnerungsschleife.
 */

export type ReminderLeadMinutes = typeof REMINDER_LEAD_MINUTES[number];

export interface TaskSettingsDto {
    reminderLeadMinutes: number;
}

/** Vorlauf einer Person in Minuten (auch für den Bootstrap der Oberfläche). */
export const getReminderLeadMinutes = async (employeeId: string): Promise<number> => {
    const row = await prisma.taskUserSetting.findUnique({
        where: { employeeId },
        select: { reminderLeadMinutes: true },
    });
    return row?.reminderLeadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES;
};

export const getMyTaskSettings = async (actor: TasksActor): Promise<TaskSettingsDto> => ({
    reminderLeadMinutes: await getReminderLeadMinutes(actor.employeeId),
});

/**
 * Speichern als EINE Anweisung: ein Vorablesen plus Anlegen kostete zwei
 * Rundgänge und liesse zwei gleichzeitige Speicherungen am eindeutigen
 * Schlüssel (employeeId) zusammenstossen.
 */
export const saveMyTaskSettings = async (
    actor: TasksActor,
    input: { reminderLeadMinutes: ReminderLeadMinutes },
): Promise<TaskSettingsDto> => {
    const now = new Date();
    await prisma.$executeRaw(Prisma.sql`
        INSERT INTO TaskUserSetting (id, employeeId, reminderLeadMinutes, createdAt, updatedAt)
        VALUES (${nanoid(12)}, ${actor.employeeId}, ${input.reminderLeadMinutes}, ${now}, ${now})
        ON DUPLICATE KEY UPDATE reminderLeadMinutes = ${input.reminderLeadMinutes}, updatedAt = ${now}
    `);
    return { reminderLeadMinutes: input.reminderLeadMinutes };
};
