import { Request, Response } from "express";
import prisma from "../../infrastructure/database/prisma.client";
import { SmtpMailService } from "../../infrastructure/services/SmtpMailService";
import {
    buildSignatureParts,
    parseSignatureImage,
    sanitizeSignatureHtml,
    signatureHasContent,
} from "../../infrastructure/services/mailSignature";
import { nanoid } from "nanoid";
import { resetTransporters } from "../../infrastructure/services/NodemailerTransport";
import { dispatchMail } from "../../infrastructure/services/outlook/MailDispatchService";

// Der eigentliche Versand läuft über dispatchMail (Outlook-Postfach des
// Benutzers, sonst SMTP); die Klasse bleibt für die Typen importiert.
void SmtpMailService;

/** Antwortform der Einstellungen: Geheimnisse nie, nur "ist gesetzt". */
const settingsDto = (settings: any) => ({
    ...settings,
    smtpPassword: undefined,
    imapPassword: undefined,
    // Die Spalten der ausgemusterten Microsoft-Anbindung bleiben in der
    // Tabelle, gehen die Oberflaeche aber nichts mehr an.
    msClientId: undefined,
    msClientSecret: undefined,
    msTenantId: undefined,
    msSyncDays: undefined,
    imapUidValidity: undefined,
    imapLastUid: undefined,
    hasPassword: Boolean(settings.smtpPassword),
    hasImapPassword: Boolean(settings.imapPassword),
});

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
                    imapHost: null,
                    imapPort: 993,
                    imapSecure: true,
                    imapUser: null,
                    sentFolder: null,
                    saveToSent: true,
                    signatureHtml: null,
                    signatureImage: null,
                    imapCaptureEnabled: false,
                    imapInboxFolder: null,
                    imapCaptureRepliesOnly: false,
                    imapLastSyncAt: null,
                    imapLastSummary: null,
                    imapLastError: null,
                    hasPassword: false,
                    hasImapPassword: false,
                });
            }

            res.status(200).json(settingsDto(settings));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async saveSettings(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const body = req.body || {};
            const existing = await prisma.mailSetting.findUnique({ where: { tenantId } });
            // Boş şifre = "dokunma" (form kayıtlı şifreyi asla geri göstermez);
            // şifreyi silmek için gövdede açıkça null gönderilir. Baştaki/sondaki
            // boşluklar kırpılır: uygulama şifreleri çoğunlukla yapıştırılır.
            const password =
                body.smtpPassword === null
                    ? null
                    : body.smtpPassword === undefined || String(body.smtpPassword).trim() === ""
                        ? existing?.smtpPassword ?? null
                        : String(body.smtpPassword).trim();

            // IMAP şifresi SMTP'ninkiyle aynı kurala uyar: boş = dokunma,
            // açıkça null = sil.
            const imapPassword =
                body.imapPassword === null
                    ? null
                    : body.imapPassword === undefined || String(body.imapPassword).trim() === ""
                        ? existing?.imapPassword ?? null
                        : String(body.imapPassword).trim();

            const port = Number(body.smtpPort);
            if (body.smtpPort !== undefined && body.smtpPort !== null && body.smtpPort !== ""
                && (!Number.isInteger(port) || port < 1 || port > 65535)) {
                return res.status(400).json({ error: "SMTP portu 1-65535 araliginda olmalidir." });
            }

            const imapPort = Number(body.imapPort);
            if (body.imapPort !== undefined && body.imapPort !== null && body.imapPort !== ""
                && (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535)) {
                return res.status(400).json({ error: "IMAP portu 1-65535 araliginda olmalidir." });
            }

            // Gönderilenler kopyası alanları: alan gönderilmediyse mevcut
            // değer korunur (kısmi kayıtlar ayarı sıfırlamasın).
            const imapFields = {
                imapHost: body.imapHost === undefined
                    ? existing?.imapHost ?? null
                    : String(body.imapHost || "").trim() || null,
                imapPort: imapPort || existing?.imapPort || 993,
                imapSecure: body.imapSecure === undefined
                    ? existing?.imapSecure ?? true
                    : Boolean(body.imapSecure),
                imapUser: body.imapUser === undefined
                    ? existing?.imapUser ?? null
                    : String(body.imapUser || "").trim() || null,
                imapPassword,
                sentFolder: body.sentFolder === undefined
                    ? existing?.sentFolder ?? null
                    : String(body.sentFolder || "").trim() || null,
                saveToSent: body.saveToSent === undefined
                    ? existing?.saveToSent ?? true
                    : Boolean(body.saveToSent),
            };

            // İmza HTML'i kayıtta temizlenir (editörün üretebildiği biçimlendirme
            // dışındaki her şey atılır); görsel yalnızca sınırlı boyutta PNG/JPG
            // data URI olabilir. Alan gönderilmediyse mevcut değer korunur.
            // Üst sınır cömerttir çünkü Outlook/Word'den yapıştırılan imzalar
            // satır içi data URI görseller taşır (görsel başına ≤ 2 MB, base64
            // ~4/3 şişirir).
            let signatureHtml = existing?.signatureHtml ?? null;
            if (body.signatureHtml !== undefined) {
                const raw = String(body.signatureHtml || "");
                if (raw.length > 8 * 1024 * 1024) {
                    return res.status(400).json({ error: "İmza çok büyük." });
                }
                const sanitized = sanitizeSignatureHtml(raw);
                signatureHtml = signatureHasContent(sanitized) ? sanitized : null;
            }
            let signatureImage = existing?.signatureImage ?? null;
            if (body.signatureImage !== undefined) {
                if (!body.signatureImage) {
                    signatureImage = null;
                } else {
                    const parsed = parseSignatureImage(String(body.signatureImage));
                    if (!parsed) {
                        return res.status(400).json({ error: "İmza görseli geçersiz. En fazla 2 MB PNG veya JPG yükleyin." });
                    }
                    signatureImage = `data:${parsed.contentType};base64,${parsed.contentBase64}`;
                }
            }

            // POSTEINGANG DES EIGENEN SERVERS: Schalter des IMAP-Abrufs. Nicht
            // gesendete Felder bleiben unangetastet (Teilspeicherungen sollen
            // den Abruf nicht heimlich abschalten).
            const captureFields = {
                imapCaptureEnabled: body.imapCaptureEnabled === undefined
                    ? existing?.imapCaptureEnabled ?? false
                    : Boolean(body.imapCaptureEnabled),
                imapInboxFolder: body.imapInboxFolder === undefined
                    ? existing?.imapInboxFolder ?? null
                    : String(body.imapInboxFolder || "").trim() || null,
                imapCaptureRepliesOnly: body.imapCaptureRepliesOnly === undefined
                    ? existing?.imapCaptureRepliesOnly ?? false
                    : Boolean(body.imapCaptureRepliesOnly),
            };

            const settings = await prisma.mailSetting.upsert({
                where: { tenantId },
                update: {
                    ...captureFields,
                    fromName: body.fromName || null,
                    fromEmail: body.fromEmail || null,
                    replyTo: body.replyTo || null,
                    smtpHost: String(body.smtpHost || "").trim() || null,
                    smtpPort: port || 587,
                    smtpSecure: Boolean(body.smtpSecure),
                    smtpUser: String(body.smtpUser || "").trim() || null,
                    smtpPassword: password,
                    ...imapFields,
                    signatureHtml,
                    signatureImage
                },
                create: {
                    id: nanoid(8),
                    tenantId,
                    ...captureFields,
                    fromName: body.fromName || null,
                    fromEmail: body.fromEmail || null,
                    replyTo: body.replyTo || null,
                    smtpHost: String(body.smtpHost || "").trim() || null,
                    smtpPort: port || 587,
                    smtpSecure: Boolean(body.smtpSecure),
                    smtpUser: String(body.smtpUser || "").trim() || null,
                    smtpPassword: password,
                    ...imapFields,
                    signatureHtml,
                    signatureImage
                }
            });

            // Geänderte Zugangsdaten dürfen nicht in einem Verbindungspool
            // weiterleben: der nächste Versand baut die Verbindung neu auf.
            resetTransporters();
            res.status(200).json(settingsDto(settings));
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
            // CC dizi ya da virgüllü tek satır olabilir; boşlar ayıklanır.
            const cc = (Array.isArray(body.cc) ? body.cc : String(body.cc || "").split(","))
                .map((value: unknown) => String(value || "").trim())
                .filter(Boolean);
            const subject = String(body.subject || "").trim();
            const text = body.text || body.message || null;
            const html = body.html || null;

            if (!to || !subject || (!text && !html)) {
                return res.status(400).json({ error: "Alıcı, konu ve mesaj zorunludur." });
            }
            // Bu uç nokta manuel/test gönderimidir: mail YALNIZCA firmanın kendi
            // SMTP sunucusundan çıkar. Sunucu tanımlı değilse mail GERÇEKTEN
            // gitmez, bu yüzden "önizleme" sessizce başarı sayılmaz.
            if (!settings?.smtpHost || !settings?.smtpPort) {
                return res.status(400).json({
                    error: "SMTP sunucusu tanimli degil: mail gonderilmedi. Once SMTP sunucusu, port ve (gerekiyorsa) kullanici/sifre bilgilerini kaydedin.",
                    code: "no_transport",
                });
            }
            // Kundenbezug (optional): landet als MailMessage in der Kundenkommunikation.
            let record: { customerId: string | null; contactId: string | null; entityType: string | null; entityId: string | null; entityLabel: string | null } | null = null;
            if (body.customerId) {
                const customer = await prisma.customer.findFirst({ where: { id: String(body.customerId), tenantId }, select: { id: true } });
                if (customer) {
                    record = {
                        customerId: customer.id,
                        contactId: body.contactId ? String(body.contactId) : null,
                        entityType: body.entityType ? String(body.entityType).toUpperCase().slice(0, 24) : null,
                        entityId: body.entityId ? String(body.entityId) : null,
                        entityLabel: body.entityLabel ? String(body.entityLabel).slice(0, 64) : null,
                    };
                }
            }

            // Tenant imzası varsa gövdenin sonuna eklenir; görseli CID'li inline
            // ek olarak gider (test maili de gerçek gönderimle aynı görünür).
            const signature = buildSignatureParts(settings);
            const htmlWithSignature = signature.html
                ? `${html || `<pre>${String(text || "")}</pre>`}${signature.html}`
                : html;
            const textWithSignature = text && signature.text ? `${text}${signature.text}` : text;

            const result = await dispatchMail({ tenantId, employeeId: req.user!.id }, settings, {
                fromEmail,
                fromName,
                to,
                cc,
                subject,
                text: textWithSignature,
                html: htmlWithSignature,
                replyTo: body.replyTo || settings?.replyTo || null,
                attachments: Array.isArray(body.attachments) ? body.attachments : [],
                inlineImages: signature.inlineImages
            }, {
                // Test gönderimi Gönderilenler kopyasının DURUMUNU da bildirir
                // ("kopya klasöre yazıldı / yazılamadı"), bu yüzden burada —
                // ve yalnızca burada — kopya beklenir.
                waitForSentCopy: true,
                record,
            });

            res.status(200).json({
                message: `Mail gonderildi: ${to}`,
                ...result
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
