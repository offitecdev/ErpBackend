import { Request } from 'express';
import { nanoid } from 'nanoid';
import prisma from '../database/prisma.client';

export interface AuditEntry {
    action: string;            // e.g. 'auth.login.success', 'employee.ban'
    tenantId?: string | null;
    employeeId?: string | null; // the actor
    entityType?: string | null; // e.g. 'Employee', 'Customer'
    entityId?: string | null;   // the affected row
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail for sensitive operations: who did what, when, from
 * which IP, on which data. Writes are fire-and-forget — an audit failure is
 * logged but never breaks the business operation itself.
 */
export class AuditLogService {
    log(entry: AuditEntry): void {
        prisma.auditLog.create({
            data: {
                id: nanoid(12),
                action: entry.action,
                tenantId: entry.tenantId ?? null,
                employeeId: entry.employeeId ?? null,
                entityType: entry.entityType ?? null,
                entityId: entry.entityId ?? null,
                ipAddress: entry.ipAddress ?? null,
                userAgent: entry.userAgent ?? null,
                metadata: (entry.metadata ?? undefined) as any,
            },
        }).catch((error) => {
            console.error('[AuditLog] write failed:', entry.action, error?.message || error);
        });
    }

    /** Extract client context (IP + user agent) from the request. */
    context(req: Request): { ipAddress: string | null; userAgent: string | null } {
        return {
            ipAddress: req.ip || req.socket?.remoteAddress || null,
            userAgent: (req.headers['user-agent'] || '').slice(0, 512) || null,
        };
    }
}

export const auditLog = new AuditLogService();
