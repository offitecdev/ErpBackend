"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProductionProjectSourceReader = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const toDate = (value) => {
    if (!value)
        return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
};
const text = (value) => {
    const clean = String(value ?? '').replace(/\r\n?/g, '\n').trim();
    return clean ? clean : null;
};
const toSource = (row) => ({
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
class PrismaProductionProjectSourceReader {
    async read(project) {
        if (project.sourceKind === 'PROJECT' && project.sourceProjectId) {
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
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
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
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
exports.PrismaProductionProjectSourceReader = PrismaProductionProjectSourceReader;
//# sourceMappingURL=ProductionProjectSourceReader.js.map