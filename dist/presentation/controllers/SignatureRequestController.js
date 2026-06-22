"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignatureRequestController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const SmtpMailService_1 = require("../../infrastructure/services/SmtpMailService");
const nanoid_1 = require("nanoid");
const smtp = new SmtpMailService_1.SmtpMailService();
const VALID_TYPES = new Set(["FIELD", "DELIVERY", "GENERAL"]);
function frontendUrl() {
    return process.env.OFFITEC_FRONTEND_URL || "http://localhost:5173";
}
class SignatureRequestController {
    /** Admin: list signature requests, optionally filtered by report type (the 3 tabs). */
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const where = { tenantId };
            if (req.query.reportType)
                where.reportType = String(req.query.reportType).toUpperCase();
            if (req.query.status)
                where.status = String(req.query.status).toUpperCase();
            const rows = await prisma_client_1.default.signatureRequest.findMany({
                where,
                orderBy: { createdAt: "desc" },
                // Keep the list light — the signature image/snapshot can be large.
                select: {
                    id: true, reportType: true, reportId: true, projectId: true, token: true,
                    customerEmail: true, title: true, status: true, signedAt: true, createdAt: true,
                },
            });
            const withLink = rows.map((r) => ({ ...r, link: `${frontendUrl()}/report-sign/${r.token}` }));
            res.status(200).json(withLink);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * Admin: create a signature request for any report kind. The client passes a
     * render-ready `snapshot` (it already shows the preview), so general reports
     * — which aren't otherwise persisted — can be signed as well. Optionally emails
     * the public link to the customer.
     */
    async create(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const body = req.body || {};
            const reportType = String(body.reportType || "").toUpperCase();
            if (!VALID_TYPES.has(reportType)) {
                return res.status(400).json({ error: "Geçersiz rapor türü." });
            }
            if (!body.snapshot || typeof body.snapshot !== "object") {
                return res.status(400).json({ error: "Rapor özeti (snapshot) zorunludur." });
            }
            // A signature may be supplied inline (admin captured it in-app on the
            // Project Details signature pad) — in that case the request is stored as
            // already SIGNED and written back to the underlying report.
            const inlineSignature = body.signatureBase64 ? String(body.signatureBase64) : null;
            const now = new Date();
            const reportId = body.reportId ? String(body.reportId) : null;
            const token = (0, nanoid_1.nanoid)(32);
            const request = await prisma_client_1.default.signatureRequest.create({
                data: {
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId,
                    reportType,
                    reportId,
                    projectId: body.projectId ? String(body.projectId) : null,
                    token,
                    customerEmail: body.customerEmail ? String(body.customerEmail) : null,
                    title: body.title ? String(body.title) : null,
                    snapshot: body.snapshot,
                    status: inlineSignature ? "SIGNED" : "PENDING",
                    signatureBase64: inlineSignature,
                    signedAt: inlineSignature ? now : null,
                },
            });
            if (inlineSignature && reportId) {
                try {
                    if (reportType === "FIELD") {
                        await prisma_client_1.default.projectReport.update({ where: { id: reportId }, data: { isSigned: true, customerSignature: inlineSignature, signedAt: now } });
                    }
                    else if (reportType === "DELIVERY") {
                        await prisma_client_1.default.deliveryReport.update({ where: { id: reportId }, data: { isSigned: true, customerSignature: inlineSignature, signedAt: now } });
                    }
                }
                catch (writeErr) {
                    console.warn("[SignatureRequest] inline write-back failed:", writeErr?.message);
                }
            }
            const link = `${frontendUrl()}/report-sign/${token}`;
            let emailed = false;
            if (!inlineSignature && body.sendEmail && request.customerEmail) {
                try {
                    const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId } });
                    const fromEmail = String(body.fromEmail || settings?.fromEmail || req.user.email || "").trim();
                    const fromName = body.fromName || settings?.fromName || "Offitec ERP";
                    const subject = String(body.subject || `${request.title || "Rapor"} - imza talebi`).trim();
                    const message = String(body.message || "Raporunuz imza için hazır. Aşağıdaki bağlantıdan görüntüleyip imzalayabilirsiniz.").trim();
                    if (fromEmail) {
                        await smtp.send(settings || {}, {
                            fromEmail,
                            fromName,
                            to: request.customerEmail,
                            subject,
                            text: `${message}\n\n${link}`,
                            html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937"><p>${message}</p><p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#272f67;color:#fff;border-radius:8px;text-decoration:none">Raporu Görüntüle ve İmzala</a></p><p style="color:#6b7280;font-size:12px">${link}</p></div>`,
                            replyTo: body.replyTo || settings?.replyTo || null,
                        });
                        emailed = true;
                    }
                }
                catch (mailErr) {
                    // Don't fail the whole request if email delivery fails — the link still works.
                    console.warn("[SignatureRequest] email failed:", mailErr?.message);
                }
            }
            // Optionally notify the assigned technician in-app so they can capture
            // the customer signature on the technician screen.
            let notified = false;
            if (!inlineSignature && body.notifyTechnician) {
                try {
                    let techId = null;
                    if (reportType === "FIELD" && reportId) {
                        techId = (await prisma_client_1.default.projectReport.findUnique({ where: { id: reportId }, select: { employeeId: true } }))?.employeeId ?? null;
                    }
                    else if (reportType === "DELIVERY" && reportId) {
                        techId = (await prisma_client_1.default.deliveryReport.findUnique({ where: { id: reportId }, select: { employeeId: true } }))?.employeeId ?? null;
                    }
                    if (!techId && request.projectId) {
                        const appt = await prisma_client_1.default.appointment.findFirst({
                            where: { projectId: request.projectId, assignedTechId: { not: null } },
                            orderBy: { startTime: "desc" },
                            select: { assignedTechId: true },
                        });
                        techId = appt?.assignedTechId ?? null;
                    }
                    if (techId) {
                        await prisma_client_1.default.notification.create({
                            data: {
                                id: (0, nanoid_1.nanoid)(12),
                                tenantId,
                                recipientEmployeeId: techId,
                                type: "REPORT_SIGNATURE_REQUEST",
                                title: "İmza talebi",
                                message: `${request.title || "Rapor"} için müşteri imzası alınması gerekiyor.`,
                                linkUrl: "/projects/installation/tasks",
                                metadata: { signatureRequestId: request.id, reportType, reportId, projectId: request.projectId },
                            },
                        });
                        notified = true;
                    }
                }
                catch (notifyErr) {
                    console.warn("[SignatureRequest] technician notify failed:", notifyErr?.message);
                }
            }
            res.status(201).json({ ...request, link, emailed, notified });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async remove(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const existing = await prisma_client_1.default.signatureRequest.findFirst({ where: { id: String(req.params.id), tenantId } });
            if (!existing)
                return res.status(404).json({ error: "İmza talebi bulunamadı." });
            await prisma_client_1.default.signatureRequest.delete({ where: { id: existing.id } });
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // ── PUBLIC (no auth) ────────────────────────────────────────────────────
    /** Public: render-ready snapshot for the tokenized sign page. */
    async getByToken(req, res) {
        try {
            const token = String(req.params.token);
            const request = await prisma_client_1.default.signatureRequest.findUnique({ where: { token } });
            if (!request)
                return res.status(404).json({ error: "Bağlantı geçersiz veya süresi dolmuş." });
            res.status(200).json({
                reportType: request.reportType,
                title: request.title,
                snapshot: request.snapshot,
                status: request.status,
                signedAt: request.signedAt,
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * Public: the customer signs (or submits without signature). When signed, the
     * signature is written back to the underlying field/delivery report too.
     */
    async signByToken(req, res) {
        try {
            const token = String(req.params.token);
            const body = req.body || {};
            const signature = body.signatureBase64 ? String(body.signatureBase64) : null;
            const request = await prisma_client_1.default.signatureRequest.findUnique({ where: { token } });
            if (!request)
                return res.status(404).json({ error: "Bağlantı geçersiz veya süresi dolmuş." });
            if (request.status === "SIGNED") {
                return res.status(409).json({ error: "Bu rapor zaten imzalanmış." });
            }
            const now = new Date();
            await prisma_client_1.default.signatureRequest.update({
                where: { id: request.id },
                data: {
                    signatureBase64: signature,
                    status: signature ? "SIGNED" : "SUBMITTED",
                    signedAt: signature ? now : null,
                },
            });
            // Write the signature back to the underlying report, when there is one.
            if (signature && request.reportId) {
                try {
                    if (request.reportType === "FIELD") {
                        await prisma_client_1.default.projectReport.update({
                            where: { id: request.reportId },
                            data: { isSigned: true, customerSignature: signature, signedAt: now },
                        });
                    }
                    else if (request.reportType === "DELIVERY") {
                        await prisma_client_1.default.deliveryReport.update({
                            where: { id: request.reportId },
                            data: { isSigned: true, customerSignature: signature, signedAt: now },
                        });
                    }
                }
                catch (writeErr) {
                    console.warn("[SignatureRequest] write-back failed:", writeErr?.message);
                }
            }
            res.status(200).json({ message: signature ? "İmza kaydedildi." : "Rapor imzasız olarak kaydedildi.", signed: Boolean(signature) });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.SignatureRequestController = SignatureRequestController;
//# sourceMappingURL=SignatureRequestController.js.map