import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../infrastructure/database/prisma.client";
import { nanoid } from "nanoid";
import { notifyProjectEvent } from "../../infrastructure/services/projectEventNotifications";

type ResponseInput = {
    id?: string;
    category?: string;
    label?: string;
    status?: string;
    measurement?: string | number | null;
    measurementEnabled?: boolean;
};

const VALID_STATUS = new Set(["YES", "NO", "NA"]);

// Rapor başına foto eki sınırı — imzayla aynı LongText/JSON yolundan gider;
// sınırsız base64 yığını hem satırı hem PDF üretimini şişirir.
const MAX_IMAGES = 12;

/** Rapora iliştirilen foto ekleri: [{ imageData: dataURL, caption? }]. */
function normalizeImages(raw: any): Array<{ imageData: string; caption?: string }> | null {
    if (raw === null) return null;
    if (!Array.isArray(raw)) return null;
    return raw
        .map((img: any) => ({
            imageData: String(img?.imageData || img || ""),
            ...(img?.caption ? { caption: String(img.caption) } : {}),
        }))
        .filter((img) => img.imageData.startsWith("data:image/"))
        .slice(0, MAX_IMAGES);
}

function normalizeResponses(raw: any): Array<{
    id: string;
    category: string;
    label: string;
    status: string | null;
    measurement: string;
    measurementEnabled: boolean;
}> {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((r: ResponseInput) => {
            const status = String(r?.status || "").toUpperCase();
            return {
                id: (r?.id && String(r.id)) || nanoid(8),
                category: String(r?.category || "").trim(),
                label: String(r?.label || "").trim(),
                status: VALID_STATUS.has(status) ? status : null,
                measurement: r?.measurement === null || r?.measurement === undefined ? "" : String(r.measurement),
                measurementEnabled: Boolean(r?.measurementEnabled),
            };
        })
        .filter((r) => r.label.length > 0);
}

export class DeliveryReportController {
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
    async list(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const conditions: Prisma.Sql[] = [Prisma.sql`dr.tenantId = ${tenantId}`];
            if (req.query.appointmentId) conditions.push(Prisma.sql`dr.appointmentId = ${String(req.query.appointmentId)}`);
            if (req.query.projectId) conditions.push(Prisma.sql`dr.projectId = ${String(req.query.projectId)}`);
            if (req.query.salesOrderId) conditions.push(Prisma.sql`dr.salesOrderId = ${String(req.query.salesOrderId)}`);

            const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
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
                WHERE ${Prisma.join(conditions, ' AND ')}
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getOne(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const report = await prisma.deliveryReport.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!report) return res.status(404).json({ error: "Teslim raporu bulunamadı." });
            const [project, order] = await Promise.all([
                report.projectId
                    ? prisma.project.findFirst({
                        where: { id: report.projectId, tenantId },
                        select: { projectName: true, customer: { select: { companyName: true } } },
                    })
                    : null,
                report.salesOrderId
                    ? prisma.salesOrder.findFirst({
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /** Latest delivery report for an appointment (so the technician tab can preload it). */
    async getByAppointment(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const report = await prisma.deliveryReport.findFirst({
                where: { tenantId, appointmentId: String(req.params.appointmentId) },
                orderBy: { createdAt: "desc" },
            });
            res.status(200).json(report || null);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * Technician creates and sends a delivery report. A drawn signature is
     * optional — without it the report is still saved and forwarded to the
     * administrator (isSigned = false).
     */
    async create(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const body = req.body || {};
            const responses = normalizeResponses(body.responses);
            if (responses.length === 0) {
                return res.status(400).json({ error: "Kontrol listesi yanıtları zorunludur." });
            }

            const signature = body.signatureBase64 ? String(body.signatureBase64) : null;
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
                ? await prisma.deliveryReport.findFirst({ where: dedupeWhere, orderBy: { createdAt: "desc" } })
                : null;

            if (existing) {
                const report = await prisma.deliveryReport.update({
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
                        sentAt: now,
                    },
                });
                void notifyProjectEvent({
                    tenantId, projectId: report.projectId, event: 'DELIVERY_REPORT_RECEIVED',
                    report: 'DELIVERY', reportId: report.id, actorEmployeeId: employeeId,
                });
                return res.status(200).json(report);
            }

            const report = await prisma.deliveryReport.create({
                data: {
                    id: nanoid(10),
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
                    isSigned: Boolean(signature),
                    signedAt: signature ? now : null,
                    sentAt: now,
                },
            });
            // Das Büro erfährt vom eingegangenen Übergabe-Rapport.
            void notifyProjectEvent({
                tenantId, projectId: report.projectId, event: 'DELIVERY_REPORT_RECEIVED',
                report: 'DELIVERY', reportId: report.id, actorEmployeeId: employeeId,
            });
            res.status(201).json(report);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /** Admin: edit a delivery report's checklist answers / notes after the technician sent it. */
    async update(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const body = req.body || {};
            const existing = await prisma.deliveryReport.findFirst({ where: { id: String(req.params.id), tenantId } });
            if (!existing) return res.status(404).json({ error: "Teslim raporu bulunamadı." });
            const report = await prisma.deliveryReport.update({
                where: { id: existing.id },
                data: {
                    responses: body.responses !== undefined ? normalizeResponses(body.responses) : (existing.responses as any),
                    notes: body.notes !== undefined ? (body.notes ? String(body.notes) : null) : existing.notes,
                    checklistName: body.checklistName !== undefined ? (body.checklistName ? String(body.checklistName) : null) : existing.checklistName,
                    // `images: []` leert die Anhänge; ohne Feld bleiben sie unverändert.
                    ...(body.images !== undefined ? { images: normalizeImages(body.images) ?? [] } : {}),
                },
            });
            res.status(200).json(report);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /** Attach (or replace) a customer signature on an existing delivery report. */
    async sign(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const body = req.body || {};
            const signature = body.signatureBase64 ? String(body.signatureBase64) : null;
            if (!signature) return res.status(400).json({ error: "İmza zorunludur." });
            const existing = await prisma.deliveryReport.findFirst({
                where: { id: String(req.params.id), tenantId },
            });
            if (!existing) return res.status(404).json({ error: "Teslim raporu bulunamadı." });
            const report = await prisma.deliveryReport.update({
                where: { id: existing.id },
                data: { customerSignature: signature, isSigned: true, signedAt: new Date() },
            });
            void notifyProjectEvent({
                tenantId, projectId: report.projectId, event: 'SIGNATURE_RECEIVED',
                report: 'DELIVERY', reportId: report.id, actorEmployeeId: req.user!.id,
            });
            res.status(200).json(report);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
