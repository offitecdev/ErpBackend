"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeliveryReportController = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const nanoid_1 = require("nanoid");
const projectEventNotifications_1 = require("../../infrastructure/services/projectEventNotifications");
const VALID_STATUS = new Set(["YES", "NO", "NA"]);
// Rapor başına foto eki sınırı — imzayla aynı LongText/JSON yolundan gider;
// sınırsız base64 yığını hem satırı hem PDF üretimini şişirir.
const MAX_IMAGES = 12;
/** Rapora iliştirilen foto ekleri: [{ imageData: dataURL, caption? }]. */
function normalizeImages(raw) {
    if (raw === null)
        return null;
    if (!Array.isArray(raw))
        return null;
    return raw
        .map((img) => ({
        imageData: String(img?.imageData || img || ""),
        ...(img?.caption ? { caption: String(img.caption) } : {}),
    }))
        .filter((img) => img.imageData.startsWith("data:image/"))
        .slice(0, MAX_IMAGES);
}
/** Signaturfeld aus dem Body: leerer String / null => gelöscht. */
function signatureOf(raw) {
    const value = raw === null || raw === undefined ? "" : String(raw);
    return value.startsWith("data:image/") ? value : null;
}
function normalizeResponses(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((r) => {
        const status = String(r?.status || "").toUpperCase();
        return {
            id: (r?.id && String(r.id)) || (0, nanoid_1.nanoid)(8),
            category: String(r?.category || "").trim(),
            label: String(r?.label || "").trim(),
            status: VALID_STATUS.has(status) ? status : null,
            measurement: r?.measurement === null || r?.measurement === undefined ? "" : String(r.measurement),
            measurementEnabled: Boolean(r?.measurementEnabled),
        };
    })
        .filter((r) => r.label.length > 0);
}
class DeliveryReportController {
    /**
     * Admin listing of delivery reports, optionally scoped to an order/project/appointment.
     *
     * LİSTE GÖVDESİ — rapor içeriği taşınmaz. `responses` (kontrol listesi
     * cevapları) ve `customerSignature` (LongText, base64 imza görseli) satır
     * başına yüz kilobaytlara çıkabiliyor ve tablo bunların HİÇBİRİNİ çizmiyor;
     * yalnızca PDF üretilirken gerekiyorlar ve o an `GET /delivery-reports/:id`
     * ile tek rapor için çekiliyorlar.
     *
     * Etiketler (proje / müşteri / sipariş) tek JOIN'de gelir: DeliveryReport'un
     * Prisma ilişkisi yok, eskiden ayrı toplu sorgularla çözülüyordu ve uzak
     * veritabanında her ifade ~100 ms.
     */
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            // Project-list progress needs one bit per project/order group: a row
            // exists (ongoing) and whether any such row is signed (completed).
            // No joins and none of the report/document columns are needed.
            if (String(req.query.view || '') === 'project-list') {
                const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                    SELECT dr.projectId, dr.salesOrderId, MAX(dr.isSigned) AS isSigned
                    FROM DeliveryReport dr
                    WHERE dr.tenantId = ${tenantId}
                      AND dr.projectId IS NOT NULL
                    GROUP BY dr.projectId, dr.salesOrderId
                `);
                return res.status(200).json(rows.map((row) => ({
                    projectId: row.projectId ?? null,
                    salesOrderId: row.salesOrderId ?? null,
                    isSigned: Boolean(row.isSigned),
                })));
            }
            const conditions = [client_1.Prisma.sql `dr.tenantId = ${tenantId}`];
            if (req.query.appointmentId)
                conditions.push(client_1.Prisma.sql `dr.appointmentId = ${String(req.query.appointmentId)}`);
            if (req.query.projectId)
                conditions.push(client_1.Prisma.sql `dr.projectId = ${String(req.query.projectId)}`);
            if (req.query.salesOrderId)
                conditions.push(client_1.Prisma.sql `dr.salesOrderId = ${String(req.query.salesOrderId)}`);
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT
                    dr.id, dr.tenantId, dr.projectId, dr.salesOrderId, dr.appointmentId,
                    dr.employeeId, dr.checklistTemplateId, dr.checklistName,
                    dr.isSigned, dr.signedAt, dr.sentAt, dr.createdAt, dr.updatedAt,
                    p.projectName AS projectName,
                    c.companyName AS customerName,
                    so.orderNumber AS orderNumber
                FROM DeliveryReport dr
                LEFT JOIN Project p ON p.id = dr.projectId AND p.tenantId = dr.tenantId
                LEFT JOIN Customer c ON c.id = p.customerId
                LEFT JOIN SalesOrder so ON so.id = dr.salesOrderId AND so.tenantId = dr.tenantId
                WHERE ${client_1.Prisma.join(conditions, ' AND ')}
                ORDER BY dr.createdAt DESC
            `);
            const reports = rows.map((row) => ({
                id: row.id,
                tenantId: row.tenantId,
                projectId: row.projectId ?? null,
                salesOrderId: row.salesOrderId ?? null,
                appointmentId: row.appointmentId ?? null,
                employeeId: row.employeeId ?? null,
                checklistTemplateId: row.checklistTemplateId ?? null,
                checklistName: row.checklistName ?? null,
                isSigned: Boolean(row.isSigned),
                signedAt: row.signedAt ?? null,
                sentAt: row.sentAt ?? null,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                projectName: row.projectName ?? null,
                customerName: row.customerName ?? null,
                orderNumber: row.orderNumber ?? null,
            }));
            res.status(200).json(reports);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getOne(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const report = await prisma_client_1.default.deliveryReport.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!report)
                return res.status(404).json({ error: "Teslim raporu bulunamadı." });
            const [project, order] = await Promise.all([
                report.projectId
                    ? prisma_client_1.default.project.findFirst({
                        where: { id: report.projectId, tenantId },
                        select: { projectName: true, customer: { select: { companyName: true } } },
                    })
                    : null,
                report.salesOrderId
                    ? prisma_client_1.default.salesOrder.findFirst({
                        where: { id: report.salesOrderId, tenantId },
                        select: { orderNumber: true },
                    })
                    : null,
            ]);
            res.status(200).json({
                ...report,
                projectName: project?.projectName || null,
                customerName: project?.customer?.companyName || null,
                orderNumber: order?.orderNumber || null,
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /** Latest delivery report for an appointment (so the technician tab can preload it). */
    async getByAppointment(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const report = await prisma_client_1.default.deliveryReport.findFirst({
                where: { tenantId, appointmentId: String(req.params.appointmentId) },
                orderBy: { createdAt: "desc" },
            });
            res.status(200).json(report || null);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * Technician creates and sends a delivery report. A drawn signature is
     * optional — without it the report is still saved and forwarded to the
     * administrator (isSigned = false).
     */
    async create(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const body = req.body || {};
            const responses = normalizeResponses(body.responses);
            if (responses.length === 0) {
                return res.status(400).json({ error: "Kontrol listesi yanıtları zorunludur." });
            }
            const signature = body.signatureBase64 ? String(body.signatureBase64) : null;
            // Zweite Signatur: der ausführende Techniker unterschreibt den
            // Rapport auf seinem Tablet; sie ist unabhängig von `isSigned`,
            // das weiterhin allein die KUNDENSIGNATUR meldet.
            const technicianSignature = body.technicianSignatureBase64 ? String(body.technicianSignatureBase64) : null;
            const now = new Date();
            const projectId = body.projectId ? String(body.projectId) : null;
            const salesOrderId = body.salesOrderId ? String(body.salesOrderId) : null;
            const appointmentId = body.appointmentId ? String(body.appointmentId) : null;
            const checklistTemplateId = body.checklistTemplateId ? String(body.checklistTemplateId) : null;
            const checklistName = body.checklistName ? String(body.checklistName) : null;
            const notes = body.notes ? String(body.notes) : null;
            const images = normalizeImages(body.images);
            // A delivery report belongs to the concrete appointment. The same
            // sales order may have several visits, so order-level deduplication
            // must only be the fallback for legacy records without appointmentId.
            const dedupeWhere = appointmentId
                ? { tenantId, appointmentId }
                : salesOrderId
                    ? { tenantId, salesOrderId, appointmentId: null }
                    : null;
            const existing = dedupeWhere
                ? await prisma_client_1.default.deliveryReport.findFirst({ where: dedupeWhere, orderBy: { createdAt: "desc" } })
                : null;
            if (existing) {
                const report = await prisma_client_1.default.deliveryReport.update({
                    where: { id: existing.id },
                    data: {
                        employeeId,
                        projectId: projectId ?? existing.projectId,
                        appointmentId: appointmentId ?? existing.appointmentId,
                        checklistTemplateId,
                        checklistName,
                        responses,
                        notes,
                        ...(images !== null ? { images } : {}),
                        // Only overwrite the signature when a fresh one is supplied.
                        ...(signature ? { customerSignature: signature, isSigned: true, signedAt: now } : {}),
                        ...(technicianSignature ? { technicianSignature, technicianSignedAt: now } : {}),
                        sentAt: now,
                    },
                });
                void (0, projectEventNotifications_1.notifyProjectEvent)({
                    tenantId, projectId: report.projectId, event: 'DELIVERY_REPORT_RECEIVED',
                    report: 'DELIVERY', reportId: report.id, actorEmployeeId: employeeId,
                });
                return res.status(200).json(report);
            }
            const report = await prisma_client_1.default.deliveryReport.create({
                data: {
                    id: (0, nanoid_1.nanoid)(10),
                    tenantId,
                    employeeId,
                    projectId,
                    salesOrderId,
                    appointmentId,
                    checklistTemplateId,
                    checklistName,
                    responses,
                    notes,
                    ...(images !== null ? { images } : {}),
                    customerSignature: signature,
                    technicianSignature,
                    technicianSignedAt: technicianSignature ? now : null,
                    isSigned: Boolean(signature),
                    signedAt: signature ? now : null,
                    sentAt: now,
                },
            });
            // Das Büro erfährt vom eingegangenen Übergabe-Rapport.
            void (0, projectEventNotifications_1.notifyProjectEvent)({
                tenantId, projectId: report.projectId, event: 'DELIVERY_REPORT_RECEIVED',
                report: 'DELIVERY', reportId: report.id, actorEmployeeId: employeeId,
            });
            res.status(201).json(report);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /** Admin: edit a delivery report's checklist answers / notes after the technician sent it. */
    async update(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const body = req.body || {};
            const existing = await prisma_client_1.default.deliveryReport.findFirst({ where: { id: String(req.params.id), tenantId } });
            if (!existing)
                return res.status(404).json({ error: "Teslim raporu bulunamadı." });
            const report = await prisma_client_1.default.deliveryReport.update({
                where: { id: existing.id },
                data: {
                    responses: body.responses !== undefined ? normalizeResponses(body.responses) : existing.responses,
                    notes: body.notes !== undefined ? (body.notes ? String(body.notes) : null) : existing.notes,
                    checklistName: body.checklistName !== undefined ? (body.checklistName ? String(body.checklistName) : null) : existing.checklistName,
                    // `images: []` leert die Anhänge; ohne Feld bleiben sie unverändert.
                    ...(body.images !== undefined ? { images: normalizeImages(body.images) ?? [] } : {}),
                    // Unterschriften: nur wenn das Feld MITGESCHICKT wurde. `null`
                    // löscht sie bewusst (Signatur neu aufnehmen), ein fehlendes
                    // Feld lässt sie unangetastet.
                    ...(body.technicianSignature !== undefined ? {
                        technicianSignature: signatureOf(body.technicianSignature),
                        technicianSignedAt: signatureOf(body.technicianSignature) ? (existing.technicianSignedAt || new Date()) : null,
                    } : {}),
                    ...(body.customerSignature !== undefined ? {
                        customerSignature: signatureOf(body.customerSignature),
                        isSigned: Boolean(signatureOf(body.customerSignature)),
                        signedAt: signatureOf(body.customerSignature) ? (existing.signedAt || new Date()) : null,
                    } : {}),
                },
            });
            res.status(200).json(report);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * Attach (or replace) a signature on an existing delivery report.
     * `role: 'TECHNICIAN'` stores the technician's own signature — only the
     * CUSTOMER signature flips `isSigned` and notifies the office.
     */
    async sign(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const body = req.body || {};
            const signature = body.signatureBase64 ? String(body.signatureBase64) : null;
            if (!signature)
                return res.status(400).json({ error: "İmza zorunludur." });
            const technician = String(body.role || "").toUpperCase() === "TECHNICIAN";
            const existing = await prisma_client_1.default.deliveryReport.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!existing)
                return res.status(404).json({ error: "Teslim raporu bulunamadı." });
            const report = await prisma_client_1.default.deliveryReport.update({
                where: { id: existing.id },
                data: technician
                    ? { technicianSignature: signature, technicianSignedAt: new Date() }
                    : { customerSignature: signature, isSigned: true, signedAt: new Date() },
            });
            if (!technician) {
                void (0, projectEventNotifications_1.notifyProjectEvent)({
                    tenantId, projectId: report.projectId, event: 'SIGNATURE_RECEIVED',
                    report: 'DELIVERY', reportId: report.id, actorEmployeeId: req.user.id,
                });
            }
            res.status(200).json(report);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.DeliveryReportController = DeliveryReportController;
//# sourceMappingURL=DeliveryReportController.js.map