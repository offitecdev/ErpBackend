"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestIp = exports.recordDocumentEvent = void 0;
const nanoid_1 = require("nanoid");
const clip = (value, max) => value == null ? null : String(value).slice(0, max);
const recordDocumentEvent = async (db, input) => {
    const actor = await db.employee.findUnique({
        where: { id: input.actorId },
        select: { firstName: true, lastName: true },
    }).catch(() => null);
    const actorName = actor ? `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || null : null;
    await db.documentEvent.create({
        data: {
            id: (0, nanoid_1.nanoid)(14),
            tenantId: input.tenantId,
            entityType: input.entityType,
            entityId: input.entityId,
            documentNumber: clip(input.documentNumber, 191),
            action: input.action,
            reason: clip(input.reason?.trim() || null, 2000),
            override: Boolean(input.override),
            overriddenBlockers: input.override ? input.override.blockers : undefined,
            snapshot: input.snapshot ?? undefined,
            projectId: input.links?.projectId ?? null,
            tenderId: input.links?.tenderId ?? null,
            salesOrderId: input.links?.salesOrderId ?? null,
            actorId: input.actorId,
            actorName: clip(actorName, 191),
            ipAddress: clip(input.ipAddress ?? null, 64),
        },
    });
};
exports.recordDocumentEvent = recordDocumentEvent;
/** Die Adresse der anfragenden Person (hinter dem Proxy die erste aus X-Forwarded-For). */
const requestIp = (req) => {
    const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    return forwarded || req.ip || req.socket?.remoteAddress || null;
};
exports.requestIp = requestIp;
//# sourceMappingURL=events.js.map