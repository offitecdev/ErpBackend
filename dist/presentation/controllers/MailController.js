"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MailController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const SmtpMailService_1 = require("../../infrastructure/services/SmtpMailService");
const nanoid_1 = require("nanoid");
const smtp = new SmtpMailService_1.SmtpMailService();
class MailController {
    async getSettings(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId } });
            if (!settings) {
                return res.status(200).json({
                    tenantId,
                    fromName: null,
                    fromEmail: req.user.email,
                    replyTo: null,
                    smtpHost: null,
                    smtpPort: 587,
                    smtpSecure: false,
                    smtpUser: null,
                    hasPassword: false
                });
            }
            res.status(200).json({
                ...settings,
                smtpPassword: undefined,
                hasPassword: Boolean(settings.smtpPassword)
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async saveSettings(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const body = req.body || {};
            const existing = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId } });
            const password = body.smtpPassword === undefined || body.smtpPassword === ""
                ? existing?.smtpPassword ?? null
                : String(body.smtpPassword);
            const settings = await prisma_client_1.default.mailSetting.upsert({
                where: { tenantId },
                update: {
                    fromName: body.fromName || null,
                    fromEmail: body.fromEmail || null,
                    replyTo: body.replyTo || null,
                    smtpHost: body.smtpHost || null,
                    smtpPort: Number(body.smtpPort || 587),
                    smtpSecure: Boolean(body.smtpSecure),
                    smtpUser: body.smtpUser || null,
                    smtpPassword: password
                },
                create: {
                    id: (0, nanoid_1.nanoid)(8),
                    tenantId,
                    fromName: body.fromName || null,
                    fromEmail: body.fromEmail || null,
                    replyTo: body.replyTo || null,
                    smtpHost: body.smtpHost || null,
                    smtpPort: Number(body.smtpPort || 587),
                    smtpSecure: Boolean(body.smtpSecure),
                    smtpUser: body.smtpUser || null,
                    smtpPassword: password
                }
            });
            res.status(200).json({ ...settings, smtpPassword: undefined, hasPassword: Boolean(settings.smtpPassword) });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async send(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId } });
            const body = req.body || {};
            const fromEmail = body.fromEmail || settings?.fromEmail || req.user.email;
            const fromName = body.fromName || settings?.fromName || "Offitec ERP";
            const to = String(body.to || "").trim();
            const subject = String(body.subject || "").trim();
            const text = body.text || body.message || null;
            const html = body.html || null;
            if (!to || !subject || (!text && !html)) {
                return res.status(400).json({ error: "Alıcı, konu ve mesaj zorunludur." });
            }
            const result = await smtp.send(settings || {}, {
                fromEmail,
                fromName,
                to,
                subject,
                text,
                html,
                replyTo: body.replyTo || settings?.replyTo || null,
                attachments: Array.isArray(body.attachments) ? body.attachments : []
            });
            res.status(200).json({
                message: result.preview
                    ? "SMTP ayari olmadigi icin mail onizleme olarak hazirlandi."
                    : "Mail gonderildi.",
                ...result
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.MailController = MailController;
//# sourceMappingURL=MailController.js.map