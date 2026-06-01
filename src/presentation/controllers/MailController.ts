import { Request, Response } from "express";
import prisma from "../../infrastructure/database/prisma.client";
import { SmtpMailService } from "../../infrastructure/services/SmtpMailService";
import { nanoid } from "nanoid";

const smtp = new SmtpMailService();

export class MailController {
    async getSettings(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const settings = await prisma.mailSetting.findUnique({ where: { tenantId } });
            if (!settings) {
                return res.status(200).json({
                    tenantId,
                    fromName: null,
                    fromEmail: req.user!.email,
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async saveSettings(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const body = req.body || {};
            const existing = await prisma.mailSetting.findUnique({ where: { tenantId } });
            const password =
                body.smtpPassword === undefined || body.smtpPassword === ""
                    ? existing?.smtpPassword ?? null
                    : String(body.smtpPassword);

            const settings = await prisma.mailSetting.upsert({
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
                    id: nanoid(8),
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async send(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const settings = await prisma.mailSetting.findUnique({ where: { tenantId } });
            const body = req.body || {};
            const fromEmail = body.fromEmail || settings?.fromEmail || req.user!.email;
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
