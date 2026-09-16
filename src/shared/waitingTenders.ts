import prisma from '../infrastructure/database/prisma.client';

/**
 * ── OFFERTEN, DIE AUF EIN PROJEKT WARTEN (16.09.2026) ───────────────────────
 *
 * Vorgabe Samet: «siparişi taslağa alınca sipariş numarası kayboluyor ve ben
 * hangi teklif olduğunu unutuyorum». Geht ein Auftrag zurück in den Entwurf,
 * trägt seine Offerte `revertedProjectId` — dieses Projekt wartet auf sie.
 * Die Projektseite zeigt daraus eine Karte: welche Offerte, welche frühere
 * AB-Nummer, wer/wann, und wie viele angesetzte Termine auf den neuen
 * Auftrag warten.
 *
 * Eine Offerte, die inzwischen wieder einen Auftrag hat oder storniert ist,
 * wartet nicht mehr. Im Normalfall ist die Liste leer und kostet genau eine
 * indizierte Abfrage.
 */
export interface WaitingTender {
    id: string;
    tenderNumber: string;
    version: number;
    revertedOrderNumber: string | null;
    revertedAt: Date | null;
    revertedBy: string | null;
    parkedAppointmentCount: number;
}

export const loadWaitingTenders = async (projectId: string, tenantId: string): Promise<WaitingTender[]> => {
    const tenders: any[] = await (prisma as any).tender.findMany({
        where: {
            tenantId,
            revertedProjectId: projectId,
            cancelledAt: null,
            salesOrder: { is: null },
        },
        select: {
            id: true,
            tenderNumber: true,
            version: true,
            revertedOrderNumber: true,
            revertedAt: true,
            revertedById: true,
        },
        orderBy: { revertedAt: 'desc' },
    });
    if (!tenders.length) return [];

    const employeeIds = [...new Set(tenders.map((row) => row.revertedById).filter(Boolean))] as string[];
    const [employees, parked] = await Promise.all([
        employeeIds.length
            ? (prisma as any).employee.findMany({
                where: { id: { in: employeeIds } },
                select: { id: true, firstName: true, lastName: true },
            })
            : Promise.resolve([]),
        (prisma as any).appointment.groupBy({
            by: ['detachedFromTenderId'],
            where: {
                tenantId,
                projectId,
                detachedFromTenderId: { in: tenders.map((row) => row.id) },
                startTime: { gte: new Date() },
                NOT: { status: 'CANCELLED' },
            },
            _count: { _all: true },
        }),
    ]);
    const nameOf = new Map<string, string>(
        (employees as any[]).map((row) => [row.id, `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim()]),
    );
    const parkedOf = new Map<string, number>(
        (parked as any[]).map((row) => [row.detachedFromTenderId, Number(row._count?._all ?? 0)]),
    );

    return tenders.map((row) => ({
        id: row.id,
        tenderNumber: row.tenderNumber,
        version: Number(row.version ?? 1),
        revertedOrderNumber: row.revertedOrderNumber ?? null,
        revertedAt: row.revertedAt ?? null,
        revertedBy: row.revertedById ? nameOf.get(row.revertedById) || null : null,
        parkedAppointmentCount: parkedOf.get(row.id) ?? 0,
    }));
};
