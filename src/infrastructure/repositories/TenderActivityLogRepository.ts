import { nanoid } from "nanoid";
import prisma from "../database/prisma.client";

export interface TenderActivityLogInput {
    tenantId: string;
    tenderId: string;
    positionId?: string | null;
    mappingId?: string | null;
    articleId?: string | null;
    employeeId: string;
    actionType: string;
    fieldName?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    description?: string | null;
}

export class TenderActivityLogRepository {
    async create(log: TenderActivityLogInput): Promise<any> {
        return await (prisma as any).tenderActivityLog.create({
            data: {
                id: nanoid(12),
                tenantId: log.tenantId,
                tenderId: log.tenderId,
                positionId: log.positionId ?? null,
                mappingId: log.mappingId ?? null,
                articleId: log.articleId ?? null,
                employeeId: log.employeeId,
                actionType: log.actionType,
                fieldName: log.fieldName ?? null,
                oldValue: log.oldValue ?? null,
                newValue: log.newValue ?? null,
                description: log.description ?? null,
            }
        });
    }

    async createMany(logs: TenderActivityLogInput[]): Promise<void> {
        if (logs.length === 0) return;
        await (prisma as any).tenderActivityLog.createMany({
            data: logs.map((log) => ({
                id: nanoid(12),
                tenantId: log.tenantId,
                tenderId: log.tenderId,
                positionId: log.positionId ?? null,
                mappingId: log.mappingId ?? null,
                articleId: log.articleId ?? null,
                employeeId: log.employeeId,
                actionType: log.actionType,
                fieldName: log.fieldName ?? null,
                oldValue: log.oldValue ?? null,
                newValue: log.newValue ?? null,
                description: log.description ?? null,
            }))
        });
    }

    async findByTender(tenderId: string): Promise<any[]> {
        const data = await (prisma as any).tenderActivityLog.findMany({
            where: { tenderId },
            orderBy: { createdAt: "desc" },
            take: 300,
        });
        const employeeIds: string[] = Array.from(
            new Set<string>(data.map((d: any) => String(d.employeeId)))
        );
        const employees = employeeIds.length > 0
            ? await prisma.employee.findMany({
                where: { id: { in: employeeIds } },
                select: { id: true, firstName: true, lastName: true, email: true }
            })
            : [];
        const empMap = new Map(employees.map((e) => [e.id, e]));
        return data.map((d: any) => {
            const emp = empMap.get(d.employeeId);
            return {
                ...d,
                employeeName: emp ? `${emp.firstName} ${emp.lastName}` : null,
                employeeEmail: emp?.email ?? null,
            };
        });
    }
}
