import { nanoid } from "nanoid";
import prisma from "../database/prisma.client";

const DB_TEXT_SAFE_BYTES = 60000;

const clampText = (value?: string | null): string | null => {
    if (value == null) return null;
    const text = String(value);
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength <= DB_TEXT_SAFE_BYTES) return text;

    const suffix = `\n...[log truncated: ${byteLength} bytes]`;
    const maxBodyBytes = Math.max(0, DB_TEXT_SAFE_BYTES - Buffer.byteLength(suffix, "utf8") - 4);
    return Buffer.from(text, "utf8").subarray(0, maxBodyBytes).toString("utf8") + suffix;
};

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
    private normalize(log: TenderActivityLogInput) {
        return {
            id: nanoid(12),
            tenantId: log.tenantId,
            tenderId: log.tenderId,
            positionId: log.positionId ?? null,
            mappingId: log.mappingId ?? null,
            articleId: log.articleId ?? null,
            employeeId: log.employeeId,
            actionType: log.actionType,
            fieldName: log.fieldName ?? null,
            oldValue: clampText(log.oldValue),
            newValue: clampText(log.newValue),
            description: clampText(log.description),
        };
    }

    async create(log: TenderActivityLogInput): Promise<any> {
        return await (prisma as any).tenderActivityLog.create({
            data: this.normalize(log)
        });
    }

    async createMany(logs: TenderActivityLogInput[]): Promise<void> {
        if (logs.length === 0) return;
        await (prisma as any).tenderActivityLog.createMany({
            data: logs.map((log) => this.normalize(log))
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
