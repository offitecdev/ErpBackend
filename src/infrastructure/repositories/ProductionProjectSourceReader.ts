import { Prisma } from '@prisma/client';
import prisma from '../database/prisma.client';
import type { IProductionProjectSourceReader } from '../../domain/repositories/IProductionRepository';
import type { ProductionProject, ProductionProjectSource } from '../../domain/entities/Production';

/**
 * ── DAS QUELLPROJEKT, WIE DIE PROJEKTSEITE DER PRODUKTION ES ZEIGT ──────────
 *
 * Vorgabe Samet, 24.09.2026: «proje bilgileri tablo halinde, daha fazla detay
 * yazabilir». Der Spiegel (`uretim_projeler`) führt nur Nummer, Name, Kunde
 * und Stand; Leitung, Termine und Adressen stehen in Projekt und Offerte der
 * Quellfirma. EINE Abfrage je Aufruf, nichts wird geschrieben.
 *
 *   Projektauftrag  Projekt → Projektleitung, Beginn/Ende; die Offerte ist die
 *                   des Projekts, sonst die des ersten Hauptauftrags
 *   Lieferauftrag   Auftrag → seine Offerte (ein Projekt gibt es dort nicht)
 */

type SourceRow = {
    managerName?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    installationAddress?: unknown;
    deliveryAddress?: unknown;
    internalDeliveryDate?: unknown;
    commissionNumber?: unknown;
    customerReference?: unknown;
    salespersonName?: unknown;
};

const toDate = (value: unknown): Date | null => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
};

const text = (value: unknown): string | null => {
    const clean = String(value ?? '').replace(/\r\n?/g, '\n').trim();
    return clean ? clean : null;
};

const toSource = (row: SourceRow): ProductionProjectSource => ({
    managerName: text(row.managerName),
    salespersonName: text(row.salespersonName),
    startDate: toDate(row.startDate),
    endDate: toDate(row.endDate),
    deliveryDate: toDate(row.internalDeliveryDate),
    installationAddress: text(row.installationAddress),
    deliveryAddress: text(row.deliveryAddress),
    commissionNumber: text(row.commissionNumber),
    customerReference: text(row.customerReference),
});

export class PrismaProductionProjectSourceReader implements IProductionProjectSourceReader {
    async read(project: ProductionProject): Promise<ProductionProjectSource | null> {
        if (project.sourceKind === 'PROJECT' && project.sourceProjectId) {
            const rows = await prisma.$queryRaw<SourceRow[]>(Prisma.sql`
                SELECT p.startDate, p.endDate,
                       NULLIF(TRIM(CONCAT_WS(' ', e.firstName, e.lastName)), '') AS managerName,
                       t.installationAddress, t.deliveryAddress, t.internalDeliveryDate,
                       t.commissionNumber, t.customerReference, t.salespersonName
                FROM Project p
                LEFT JOIN Employee e ON e.id = p.managerId
                LEFT JOIN Tender t ON t.id = COALESCE(p.tenderId, (
                    SELECT so.tenderId FROM SalesOrder so
                    WHERE so.projectId = p.id AND so.parentSalesOrderId IS NULL AND so.tenderId IS NOT NULL
                    ORDER BY COALESCE(so.orderDate, so.createdAt) ASC
                    LIMIT 1
                ))
                WHERE p.id = ${project.sourceProjectId} AND p.tenantId = ${project.sourceTenantId}
                LIMIT 1
            `);
            return rows[0] ? toSource(rows[0]) : null;
        }

        if (project.sourceSalesOrderId) {
            const rows = await prisma.$queryRaw<SourceRow[]>(Prisma.sql`
                SELECT t.installationAddress, t.deliveryAddress, t.internalDeliveryDate,
                       t.commissionNumber, t.customerReference, t.salespersonName
                FROM SalesOrder so
                LEFT JOIN Tender t ON t.id = so.tenderId
                WHERE so.id = ${project.sourceSalesOrderId} AND so.tenantId = ${project.sourceTenantId}
                LIMIT 1
            `);
            return rows[0] ? toSource(rows[0]) : null;
        }

        return null;
    }
}
