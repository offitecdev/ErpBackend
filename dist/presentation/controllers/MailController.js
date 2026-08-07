"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MailController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const SmtpMailService_1 = require("../../infrastructure/services/SmtpMailService");
const mailSignature_1 = require("../../infrastructure/services/mailSignature");
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
                    imapHost: null,
                    imapPort: 993,
                    imapSecure: true,
                    imapUser: null,
                    sentFolder: null,
                    saveToSent: true,
                    signatureHtml: null,
                    signatureImage: null,
                    hasPassword: false,
                    hasImapPassword: false
                });
            }
            res.status(200).json({
                ...settings,
                smtpPassword: undefined,
                imapPassword: undefined,
                hasPassword: Boolean(settings.smtpPassword),
                hasImapPassword: Boolean(settings.imapPassword)
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
            // Boş şifre = "dokunma" (form kayıtlı şifreyi asla geri göstermez);
            // şifreyi silmek için gövdede açıkça null gönderilir. Baştaki/sondaki
            // boşluklar kırpılır: uygulama şifreleri çoğunlukla yapıştırılır.
            const password = body.smtpPassword === null
                ? null
                : body.smtpPassword === undefined || String(body.smtpPassword).trim() === ""
                    ? existing?.smtpPassword ?? null
                    : String(body.smtpPassword).trim();
            // IMAP şifresi SMTP'ninkiyle aynı kurala uyar: boş = dokunma,
            // açıkça null = sil.
            const imapPassword = body.imapPassword === null
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
                const sanitized = (0, mailSignature_1.sanitizeSignatureHtml)(raw);
                signatureHtml = (0, mailSignature_1.signatureHasContent)(sanitized) ? sanitized : null;
            }
            let signatureImage = existing?.signatureImage ?? null;
            if (body.signatureImage !== undefined) {
                if (!body.signatureImage) {
                    signatureImage = null;
                }
                else {
                    const parsed = (0, mailSignature_1.parseSignatureImage)(String(body.signatureImage));
                    if (!parsed) {
                        return res.status(400).json({ error: "İmza görseli geçersiz. En fazla 2 MB PNG veya JPG yükleyin." });
                    }
                    signatureImage = `data:${parsed.contentType};base64,${parsed.contentBase64}`;
                }
            }
            const settings = await prisma_client_1.default.mailSetting.upsert({
                where: { tenantId },
                update: {
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
                    id: (0, nanoid_1.nanoid)(8),
                    tenantId,
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
            res.status(200).json({
                ...settings,
                smtpPassword: undefined,
                imapPassword: undefined,
                hasPassword: Boolean(settings.smtpPassword),
                hasImapPassword: Boolean(settings.imapPassword)
            });
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
            // CC dizi ya da virgüllü tek satır olabilir; boşlar ayıklanır.
            const cc = (Array.isArray(body.cc) ? body.cc : String(body.cc || "").split(","))
                .map((value) => String(value || "").trim())
                .filter(Boolean);
            const subject = String(body.subject || "").trim();
            const text = body.text || body.message || null;
            const html = body.html || null;
            if (!to || !subject || (!text && !html)) {
                return res.status(400).json({ error: "Alıcı, konu ve mesaj zorunludur." });
            }
            // Bu uç nokta manuel/test gönderimidir: SMTP tanımlı değilse mail
            // GERÇEKTEN gitmez, bu yüzden "önizleme" sessizce başarı sayılmaz.
            if (!settings?.smtpHost || !settings?.smtpPort) {
                return res.status(400).json({
                    error: "SMTP sunucusu tanimli degil: mail gonderilmedi. Once SMTP sunucusu, port ve (gerekiyorsa) kullanici/sifre bilgilerini kaydedin.",
                });
            }
            // Tenant imzası varsa gövdenin sonuna eklenir; görseli CID'li inline
            // ek olarak gider (test maili de gerçek gönderimle aynı görünür).
            const signature = (0, mailSignature_1.buildSignatureParts)(settings);
            const htmlWithSignature = signature.html
                ? `${html || `<pre>${String(text || "")}</pre>`}${signature.html}`
                : html;
            const textWithSignature = text && signature.text ? `${text}${signature.text}` : text;
            const result = await smtp.send(settings || {}, {
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
            });
            res.status(200).json({
                message: `Mail gonderildi: ${to}`,
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