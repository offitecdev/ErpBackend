"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logTaskActivity = exports.logTaskActivities = void 0;
const nanoid_1 = require("nanoid");
const trimMeta = (meta) => {
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined)
            continue;
        out[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
    return out;
};
const logTaskActivities = async (db, tenantId, actorId, entries) => {
    if (!entries.length)
        return;
    await db.taskActivity.createMany({
        data: entries.map((entry) => ({
            id: (0, nanoid_1.nanoid)(12),
            tenantId,
            taskId: entry.taskId,
            actorId: entry.actorId === undefined ? actorId : entry.actorId,
            type: entry.type,
            ...(entry.meta ? { meta: trimMeta(entry.meta) } : {}),
        })),
    });
};
exports.logTaskActivities = logTaskActivities;
const logTaskActivity = (db, tenantId, actorId, entry) => (0, exports.logTaskActivities)(db, tenantId, actorId, [entry]);
exports.logTaskActivity = logTaskActivity;
//# sourceMappingURL=taskActivity.js.map