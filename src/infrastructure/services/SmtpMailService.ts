import { ImapMailService, ImapSettings, SentCopyResult, sentCopyBudgetMs } from "./ImapMailService";
import { budgetForMessage } from "./mailSocket";
import { sendRawMessage } from "./NodemailerTransport";

/**
 * Bir gönderimin TOPLAM süre bütçesi. Normal bir gönderim 1-3 saniyede biter;
 * bu bütçe yalnızca patolojik durumlar (paket düşüren güvenlik duvarı, yanıt
 * vermeyen sunucu) için bir tavandır. Ortamdan büyütülüp küçültülebilir.
 */
const SEND_BUDGET_MS = Number(process.env.MAIL_SEND_TIMEOUT_MS) > 0
    ? Number(process.env.MAIL_SEND_TIMEOUT_MS)
    : 30_000;
/** Büyük eklerin yazımı için boyuta göre verilen ek pay (tavanı). */
const SEND_BUDGET_MAX_EXTRA_MS = 90_000;

export interface MailSettings extends ImapSettings {
    fromName?: string | null;
    fromEmail?: string | null;
    replyTo?: string | null;
    smtpHost?: string | null;
    smtpPort?: number | null;
    smtpSecure?: boolean | null;
    smtpUser?: string | null;
    smtpPassword?: string | null;
}

export interface SendMailInput {
    fromEmail: string;
    fromName?: string | null;
    to: string;
    /** Bilgi (CC) alıcıları; başlıkta görünür ve her biri RCPT alır. */
    cc?: string[] | null;
    subject: string;
    text?: string | null;
    html?: string | null;
    replyTo?: string | null;
    attachments?: Array<{
        filename: string;
        contentType: string;
        contentBase64: string;
    }>;
    /**
     * Gövdedeki `cid:` referanslarıyla gösterilen inline görseller (ör. imza
     * görseli). Normal eklerden farklı olarak multipart/related içinde,
     * Content-ID başlığıyla gönderilirler.
     */
    inlineImages?: Array<{
        cid: string;
        contentType: string;
        contentBase64: string;
    }>;
    /**
     * RFC-Message-ID (`<…@domain>`) — wird als Header geschrieben. Ist keine
     * gesetzt, vergibt `buildMimeMessage` eine. Die Outlook-Anbindung setzt sie
     * VORHER, um die ERP-Sendung später in "Gesendet" wiederzuerkennen.
     */
    messageId?: string | null;
    /**
     * KALENDER-EINLADUNG. Wird als `text/calendar`-Teil ZULETZT in die
     * multipart/alternative gehängt: der letzte Teil hat dort den Vorrang, und
     * genau daran erkennt Outlook eine Terminanfrage (Annehmen/Ablehnen im
     * Kopf der Nachricht) statt einer Mail mit Anhang. Zusätzlich geht dieselbe
     * Datei als `invite.ics` mit — für Programme, die den Alternativteil
     * ignorieren.
     */
    calendar?: {
        method: string;
        content: string;
    } | null;
}

/** Erzeugt eine Message-ID in der Domain der Absenderadresse. */
export const newMessageId = (fromEmail: string): string => {
    const domain = String(fromEmail || "").split("@")[1]?.trim() || "offitec-erp.local";
    const random = Buffer.from(`${Date.now()}${Math.random()}${process.pid}`).toString("base64url").slice(0, 24);
    return `<offitec-${random}@${domain}>`;
};

const encodeHeader = (value: string) => {
    if (/^[\x00-\x7F]*$/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
};

const address = (email: string, name?: string | null) => {
    const cleanEmail = email.trim();
    return name ? `"${encodeHeader(name).replace(/"/g, '\\"')}" <${cleanEmail}>` : cleanEmail;
};

/**
 * Gönderilecek RFC 5322 mesajını kurar. Soket işinden AYRIDIR: aynı bayt
 * dizisi hem SMTP DATA'sına yazılır hem de IMAP ile Gönderilenler klasörüne
 * kopyalanır — kopyanın birebir aynı mail olması için tek kaynak şarttır.
 */
export const buildMimeMessage = (mail: SendMailInput, ccList: string[]): string => {
    const text = mail.text || mail.html?.replace(/<[^>]+>/g, " ") || "";
    const html = mail.html || `<pre>${text}</pre>`;
    const stamp = Date.now();
    const altBoundary = `offitec-alt-${stamp}`;
    const relatedBoundary = `offitec-rel-${stamp}`;
    const mixedBoundary = `offitec-mixed-${stamp}`;
    // Der Kalenderteil steht ABSICHTLICH nach text/html: in einer
    // multipart/alternative gewinnt der letzte Teil, und nur so wird aus der
    // Mail eine Terminanfrage statt einer Nachricht mit Anhang.
    const calendarPart = mail.calendar
        ? [
            `--${altBoundary}`,
            `Content-Type: text/calendar; charset="UTF-8"; method=${mail.calendar.method}`,
            `Content-Transfer-Encoding: 8bit`,
            ``,
            mail.calendar.content.replace(/\r?\n/g, "\r\n"),
        ]
        : [];
    const alternativePart = [
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        ``,
        `--${altBoundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        `Content-Transfer-Encoding: 8bit`,
        ``,
        text,
        `--${altBoundary}`,
        `Content-Type: text/html; charset="UTF-8"`,
        `Content-Transfer-Encoding: 8bit`,
        ``,
        html,
        ...calendarPart,
        `--${altBoundary}--`,
    ].join("\r\n");

    // Inline görseller varsa gövde multipart/related olur: HTML + Content-ID'li
    // görsel parçaları bir arada; mail istemcisi `cid:` referansını bunlarla çözer.
    const inlineImages = mail.inlineImages || [];
    const bodyPart = inlineImages.length === 0
        ? alternativePart
        : [
            `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
            ``,
            `--${relatedBoundary}`,
            alternativePart,
            ...inlineImages.map((image) => {
                const wrapped = image.contentBase64.replace(/\s+/g, "").replace(/(.{76})/g, "$1\r\n");
                return [
                    `--${relatedBoundary}`,
                    `Content-Type: ${image.contentType}`,
                    `Content-Transfer-Encoding: base64`,
                    `Content-ID: <${image.cid}>`,
                    `Content-Disposition: inline`,
                    ``,
                    wrapped,
                ].join("\r\n");
            }),
            `--${relatedBoundary}--`,
        ].join("\r\n");

    const attachmentParts = (mail.attachments || []).map((attachment) => {
        const safeName = attachment.filename.replace(/"/g, "");
        const encodedName = encodeHeader(safeName);
        const wrappedContent = attachment.contentBase64.replace(/\s+/g, "").replace(/(.{76})/g, "$1\r\n");
        return [
            `--${mixedBoundary}`,
            `Content-Type: ${attachment.contentType}; name="${encodedName}"`,
            `Content-Transfer-Encoding: base64`,
            `Content-Disposition: attachment; filename="${encodedName}"`,
            ``,
            wrappedContent,
        ].join("\r\n");
    });

    return [
        `From: ${address(mail.fromEmail, mail.fromName)}`,
        `To: ${mail.to}`,
        ccList.length ? `Cc: ${ccList.join(", ")}` : null,
        `Subject: ${encodeHeader(mail.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${mail.messageId || newMessageId(mail.fromEmail)}`,
        `MIME-Version: 1.0`,
        mail.replyTo ? `Reply-To: ${mail.replyTo}` : null,
        `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
        ``,
        `--${mixedBoundary}`,
        bodyPart,
        ...attachmentParts,
        `--${mixedBoundary}--`,
        ``,
        // ⚠ YALNIZCA `null` ELENİR, BOŞ SATIRLAR DEĞİL. Burada bir zamanlar
        // `.filter(Boolean)` vardı: amacı yazılmayan `Cc`/`Reply-To` satırlarını
        // atmaktı ama BOŞ DİZGİ de "falsy" olduğu için başlık bloğunu gövdeden
        // ayıran BOŞ SATIRI da siliyordu. Boş satır olmadan `--sinir` satırı
        // başlığın devamı sanılır: mail istemcileri gövdeyi (mesaj metnini)
        // GÖSTEREMEZ, yalnızca eki listeler — Gönderilenler klasöründeki kopya
        // da "sadece PDF, açıklama yok" hâlinde görünürdü. Sondaki boş satır da
        // gereklidir: kapanış sınırı satır sonuyla bitmelidir.
    ].filter((line): line is string => line !== null).join("\r\n");
};

/**
 * Gönderilenler kopyası için EMNİYET SUBABI. IMAP adımı gönderimin PARÇASI
 * DEĞİLDİR (mail çoktan teslim edilmiştir); yavaş ya da yanıt vermeyen bir IMAP
 * sunucusu yüzünden kullanıcı ekranda dönen bir "gönderiliyor" görmemelidir.
 *
 * `appendToSent` kendi bütçesini zaten uygular; buradaki yarış yalnızca o
 * bütçenin de tutmadığı durumlar içindir — bu yüzden ondan biraz UZUNDUR,
 * yoksa hâlâ çalışan bir kopya erkenden "başarısız" damgası yerdi.
 */
const sentCopyDeadlineMs = (body: string) => sentCopyBudgetMs(body) + 5_000;

export class SmtpMailService {
    private readonly imap = new ImapMailService();

    /**
     * Gönderilenler kopyasını yazar; ASLA throw etmez ve süresi sınırlıdır.
     * Süre dolarsa kopya "failed" sayılır — gönderimin kendisi etkilenmez.
     */
    private async saveSentCopy(settings: MailSettings, body: string): Promise<SentCopyResult> {
        let deadline: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                this.imap.appendToSent(settings, body),
                new Promise<SentCopyResult>((resolve) => {
                    deadline = setTimeout(
                        () => resolve({ status: "failed", error: "IMAP sunucusu zamaninda yanit vermedi." }),
                        sentCopyDeadlineMs(body),
                    );
                }),
            ]);
        } catch (error: any) {
            return { status: "failed", error: error?.message || "IMAP kopyasi yazilamadi." };
        } finally {
            if (deadline) clearTimeout(deadline);
        }
    }

    /**
     * @param options.waitForSentCopy Gönderilenler kopyasının SONUCU beklenir mi?
     *   Yalnızca Mail Ayarları'ndaki test gönderimi bekler (kopyanın durumunu
     *   ekranda bildirir). Normal gönderimlerde kopya arka planda alınır: mail
     *   teslim edildikten sonra IMAP'ı beklemek, kullanıcıyı bitmeyen bir
     *   yükleniyor ekranında tutmaktan başka bir şey yapmaz.
     */
    async send(
        settings: MailSettings,
        mail: SendMailInput,
        options: { waitForSentCopy?: boolean } = {},
    ): Promise<{ accepted: string[]; preview: boolean; sentCopy?: SentCopyResult }> {
        const host = settings.smtpHost?.trim();
        const port = Number(settings.smtpPort || 0);
        const ccList = (mail.cc || []).map((value) => String(value || "").trim()).filter(Boolean);
        if (!host || !port) {
            return { accepted: [mail.to, ...ccList], preview: true };
        }

        // Mesaj GÖNDERİMDEN ÖNCE kurulur: aynı bayt dizisi hem SMTP'ye verilir
        // hem de teslim sonrası Gönderilenler klasörüne kopyalanır.
        const body = buildMimeMessage(mail, ccList);
        const startedAt = Date.now();

        // ── TOPLAM SÜRE BÜTÇESİ ──────────────────────────────────────────────
        // Gönderimin tamamı için tek bir duvar saati bütçesi; nodemailer'a
        // bağlantı/karşılama/soket zaman aşımı olarak verilir, böylece yanıt
        // vermeyen bir sunucu isteği sonsuza kadar açık tutamaz.
        const budgetMs = budgetForMessage(
            SEND_BUDGET_MS,
            Buffer.byteLength(body, "utf8"),
            SEND_BUDGET_MAX_EXTRA_MS,
        );

        // TESLİM: SMTP konuşmasını nodemailer yürütür (bağlantı havuzu, TLS,
        // kimlik doğrulama); mesajın KENDİSİ yukarıda kurulan MIME'dir.
        await sendRawMessage(
            settings,
            body,
            { from: mail.fromEmail.trim(), to: [mail.to.trim(), ...ccList] },
            budgetMs,
        );

        // Teslim tamamlandı; mail yola çıktı. Süre buraya kadar ÖLÇÜLÜR: bir
        // gönderim "takıldı" diye bildirildiğinde, zamanın SMTP'de mi yoksa
        // sonraki adımda mı geçtiği tek satırdan okunabilsin.
        const deliveredMs = Date.now() - startedAt;
        const report = (sentCopy: SentCopyResult) => {
            const copyNote = sentCopy.status === "saved"
                ? `kopya: ${sentCopy.folder}`
                : sentCopy.status === "skipped"
                    ? `kopya yok (${sentCopy.reason})`
                    : `KOPYA HATASI: ${sentCopy.error}`;
            console.log(`[MAIL] ${mail.to} -> teslim ${deliveredMs}ms, toplam ${Date.now() - startedAt}ms, ${copyNote}`);
        };

        // GÖNDERİLENLER KOPYASI gönderimin parçası değildir: mail teslim
        // edilmiştir ve kopyanın alınamaması gönderimi başarısız SAYMAZ. Bu
        // yüzden istek onu BEKLEMEZ — arka planda alınır, sonucu loglanır.
        // Yalnızca ayarlar sayfasındaki test gönderimi sonucu bekler.
        if (options.waitForSentCopy) {
            const sentCopy = await this.saveSentCopy(settings, body);
            report(sentCopy);
            return { accepted: [mail.to, ...ccList], preview: false, sentCopy };
        }
        void this.saveSentCopy(settings, body).then(report);
        return { accepted: [mail.to, ...ccList], preview: false };
    }
}
