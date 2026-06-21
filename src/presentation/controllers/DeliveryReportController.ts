import { Request, Response } from "express";
import prisma from "../../infrastructure/database/prisma.client";
import { nanoid } from "nanoid";

type ResponseInput = {
    id?: string;
    category?: string;
    label?: string;
    status?: string;
    measurement?: string | number | null;
    measurementEnabled?: boolean;
};

const VALID_STATUS = new Set(["YES", "NO", "NA"]);

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
    /** Admin listing of delivery reports, optionally scoped to an order/project/appointment. */
    async list(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const where: any = { tenantId };
            if (req.query.appointmentId) where.appointmentId = String(req.query.appointmentId);
            if (req.query.projectId) where.projectId = String(req.query.projectId);
            if (req.query.salesOrderId) where.salesOrderId = String(req.query.salesOrderId);
            const reports = await prisma.deliveryReport.findMany({
                where,
                orderBy: { createdAt: "desc" },
            });

            // Enrich with project + customer + order labels (no Prisma relation on
            // DeliveryReport, so we resolve names in a couple of batched lookups).
            const projectIds = [...new Set(reports.map((r) => r.projectId).filter(Boolean) as string[])];
            const orderIds = [...new Set(reports.map((r) => r.salesOrderId).filter(Boolean) as string[])];
            const [projects, orders] = await Promise.all([
                projectIds.length
                    ? prisma.project.findMany({
                          where: { id: { in: projectIds } },
                          select: { id: true, projectName: true, customer: { select: { companyName: true } } },
                      })
                    : Promise.resolve([]),
                orderIds.length
                    ? prisma.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true } })
                    : Promise.resolve([]),
            ]);
            const projectMap = new Map(projects.map((p) => [p.id, p]));
            const orderMap = new Map(orders.map((o) => [o.id, o]));
            const enriched = reports.map((r) => ({
                ...r,
                projectName: r.projectId ? projectMap.get(r.projectId)?.projectName ?? null : null,
                customerName: r.projectId ? projectMap.get(r.projectId)?.customer?.companyName ?? null : null,
                orderNumber: r.salesOrderId ? orderMap.get(r.salesOrderId)?.orderNumber ?? null : null,
            }));
            res.status(200).json(enriched);
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
            res.status(200).json(report);
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

            // One delivery report per order: the technician owns it and re-submitting
            // updates the existing report instead of creating a duplicate. Scope by
            // order when available, otherwise by appointment.
            const dedupeWhere = salesOrderId
                ? { tenantId, salesOrderId }
                : appointmentId
                    ? { tenantId, appointmentId }
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
                        // Only overwrite the signature when a fresh one is supplied.
                        ...(signature ? { customerSignature: signature, isSigned: true, signedAt: now } : {}),
                        sentAt: now,
                    },
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
                    customerSignature: signature,
                    isSigned: Boolean(signature),
                    signedAt: signature ? now : null,
                    sentAt: now,
                },
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
            res.status(200).json(report);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
