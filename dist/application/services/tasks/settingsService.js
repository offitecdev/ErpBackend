"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveMyTaskSettings = exports.getMyTaskSettings = exports.getReminderLeadMinutes = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskConstants_1 = require("./taskConstants");
/** Vorlauf einer Person in Minuten (auch für den Bootstrap der Oberfläche). */
const getReminderLeadMinutes = async (employeeId) => {
    const row = await prisma_client_1.default.taskUserSetting.findUnique({
        where: { employeeId },
        select: { reminderLeadMinutes: true },
    });
    return row?.reminderLeadMinutes ?? taskConstants_1.DEFAULT_REMINDER_LEAD_MINUTES;
};
exports.getReminderLeadMinutes = getReminderLeadMinutes;
const getMyTaskSettings = async (actor) => ({
    reminderLeadMinutes: await (0, exports.getReminderLeadMinutes)(actor.employeeId),
});
exports.getMyTaskSettings = getMyTaskSettings;
/**
 * Speichern als EINE Anweisung: ein Vorablesen plus Anlegen kostete zwei
 * Rundgänge und liesse zwei gleichzeitige Speicherungen am eindeutigen
 * Schlüssel (employeeId) zusammenstossen.
 */
const saveMyTaskSettings = async (actor, input) => {
    const now = new Date();
    await prisma_client_1.default.$executeRaw(client_1.Prisma.sql `
        INSERT INTO TaskUserSetting (id, employeeId, reminderLeadMinutes, createdAt, updatedAt)
        VALUES (${(0, nanoid_1.nanoid)(12)}, ${actor.employeeId}, ${input.reminderLeadMinutes}, ${now}, ${now})
        ON DUPLICATE KEY UPDATE reminderLeadMinutes = ${input.reminderLeadMinutes}, updatedAt = ${now}
    `);
    return { reminderLeadMinutes: input.reminderLeadMinutes };
};
exports.saveMyTaskSettings = saveMyTaskSettings;
//# sourceMappingURL=settingsService.js.map