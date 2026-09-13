"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueTaskNotification = exports.notifyTaskPeople = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskConstants_1 = require("./taskConstants");
const taskPeople_1 = require("./taskPeople");
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const notifyTaskPeople = async (input) => {
    try {
        const people = await (0, taskPeople_1.getTasksPeople)(input.tenantId);
        const recipients = [...new Set([...input.recipientIds].filter((id) => Boolean(id)))]
            .filter((id) => id !== input.actorId && people.has(id));
        if (!recipients.length)
            return 0;
        const title = clip(String(input.title || ''), 191);
        const message = clip(String(input.message || ''), 2000);
        const linkUrl = clip(String(input.linkUrl || ''), 191);
        const metadata = {
            ...(input.meta ?? {}),
            module: 'tasks',
            i18n: { key: taskConstants_1.NOTIFY_I18N[input.type], params: input.params ?? {} },
        };
        let pending = recipients;
        if (input.coalesceUnread) {
            const unread = await prisma_client_1.default.notification.findMany({
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
                await prisma_client_1.default.notification.updateMany({
                    where: { id: { in: unread.map((row) => row.id) } },
                    data: { title, message, metadata, createdAt: new Date() },
                });
                const refreshed = new Set(unread.map((row) => row.recipientEmployeeId));
                pending = recipients.filter((id) => !refreshed.has(id));
            }
        }
        if (pending.length) {
            await prisma_client_1.default.notification.createMany({
                data: pending.map((recipientEmployeeId) => ({
                    id: (0, nanoid_1.nanoid)(12),
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
    }
    catch (error) {
        console.warn(`[tasks.notify] ${input.type} konnte nicht geschrieben werden`, error);
        return 0;
    }
};
exports.notifyTaskPeople = notifyTaskPeople;
/** Ohne Warten: die Antwort an den Browser hängt nicht an der Glocke. */
const queueTaskNotification = (input) => {
    void (0, exports.notifyTaskPeople)(input);
};
exports.queueTaskNotification = queueTaskNotification;
//# sourceMappingURL=taskNotify.js.map