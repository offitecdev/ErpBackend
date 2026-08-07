import { ImapMailService, ImapSettings, SentCopyResult, sentCopyBudgetMs } from "./ImapMailService";
import {
    budgetForMessage,
    COMMAND_TIMEOUT_MS,
    CONNECT_TIMEOUT_MS,
    DATA_TIMEOUT_MS,
    MailDeadline,
    MailSocket,
    openSocket,
    TLS_HANDSHAKE_TIMEOUT_MS,
    upgradeToTls,
} from "./mailSocket";

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
}

type SmtpSocket = MailSocket;
type SmtpReply = { code: number; text: string };

const encodeHeader = (value: string) => {
    if (/^[\x00-\x7F]*$/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
};

const address = (email: string, name?: string | null) => {
    const cleanEmail = email.trim();
    return name ? `"${encodeHeader(name).replace(/"/g, '\\"')}" <${cleanEmail}>` : cleanEmail;
};

const escapeDotLines = (body: string) =>
    body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

/** EHLO cevabındaki `250-AUTH PLAIN LOGIN` satırından mekanizmalar. */
const authMechanisms = (ehlo: string): Set<string> => {
    const mechanisms = new Set<string>();
    for (const line of ehlo.split(/\r?\n/)) {
        const match = /^\d{3}[ -]AUTH[ =](.+)$/i.exec(line.trim());
        if (!match) continue;
        for (const mechanism of match[1]!.trim().split(/\s+/)) mechanisms.add(mechanism.toUpperCase());
    }
    return mechanisms;
};

/** Tek bir SMTP yanıtı okur. Çok satırlı yanıtlarda (`250-...`) yalnızca
    son satır `NNN ` biçimindedir; okuma orada tamamlanır. */
const readReply = (socket: SmtpSocket, timeoutMs = COMMAND_TIMEOUT_MS): Promise<SmtpReply> =>
    new Promise((resolve, reject) => {
        let buffer = "";
        const cleanup = () => {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("SMTP sunucusu yanit vermedi (zaman asimi)."));
        }, timeoutMs);
        function onData(chunk: Buffer) {
            buffer += chunk.toString("utf8");
            // TAMAMLANMAMIŞ SATIR BEKLENİR. TCP parçalanması yanıtı satır
            // ortasından bölebilir: `250-AUTH PLAIN LOGIN\r\n250` gibi bir
            // parça geldiğinde son "satır" yalnızca `250` olur ve aşağıdaki
            // desene UYAR — okuma erken biter, yanıtın geri kalanı (` 8BITMIME`)
            // sokette kalır ve BİR SONRAKİ komutun yanıtı sanılırdı. O noktadan
            // sonra konuşma kayar: sunucu beklenen cevabı hiç vermez ve gönderim
            // zaman aşımına kadar asılı kalır. Bu yüzden yalnızca satır sonuyla
            // biten bir tampon değerlendirilir.
            if (!/\r?\n$/.test(buffer)) return;
            const lines = buffer.replace(/\r?\n$/, "").split(/\r?\n/);
            const last = lines[lines.length - 1] || "";
            if (!/^\d{3}( |$)/.test(last)) return; // `250-` = devam satiri
            cleanup();
            resolve({ code: Number(last.slice(0, 3)), text: buffer.trim() });
        }
        function onError(error: Error) {
            cleanup();
            reject(new Error(`SMTP baglanti hatasi: ${error.message}`));
        }
        function onClose() {
            cleanup();
            reject(new Error("SMTP baglantisi beklenmedik sekilde kapandi."));
        }
        socket.on("data", onData);
        socket.once("error", onError);
        socket.once("close", onClose);
    });

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

        // 465 gelenekesel olarak örtük TLS'tir; kutucuğu işaretlemeyi unutmak
        // en sık yapılan ayar hatası olduğu için port da dikkate alınır.
        const implicitTls = Boolean(settings.smtpSecure) || port === 465;
        // Bazı sunucular `.local` gibi FQDN olmayan EHLO adlarını reddeder:
        // varsa gönderen adresinin alan adı kullanılır.
        const clientName = mail.fromEmail.split("@")[1]?.trim() || "offitec-erp.local";

        // Mesaj soketten ÖNCE kurulur: aynı bayt dizisi hem DATA'ya yazılır
        // hem de teslim sonrası Gönderilenler klasörüne kopyalanır.
        const body = buildMimeMessage(mail, ccList);
        const startedAt = Date.now();

        // ── TOPLAM SÜRE BÜTÇESİ ──────────────────────────────────────────────
        // Adım başına zaman aşımları TEK BAŞINA yetmez: her adım ayrı ayrı zaman
        // aşımına uğrayabildiği için (bağlan → karşılama → EHLO → STARTTLS →
        // EHLO → AUTH → MAIL → RCPT → DATA) toplam bekleme dakikalara çıkabilir
        // ve gönder düğmesi bitmeyen bir "gönderiliyor" gösterirdi. Bütçe
        // konuşmanın TAMAMINI kapsar; her adım yalnızca KALAN süreyi kullanır.
        const deadline = new MailDeadline(
            budgetForMessage(SEND_BUDGET_MS, Buffer.byteLength(body, "utf8"), SEND_BUDGET_MAX_EXTRA_MS),
            "SMTP",
        );

        let socket = await openSocket(host, port, implicitTls, "SMTP", deadline.slice(CONNECT_TIMEOUT_MS));
        try {
            const command = async (line: string, expected: number[], label: string) => {
                socket.write(`${line}\r\n`);
                const reply = await readReply(socket, deadline.slice(COMMAND_TIMEOUT_MS));
                if (!expected.includes(reply.code)) {
                    throw new Error(`SMTP hatasi (${label}): ${reply.text}`);
                }
                return reply;
            };

            const greeting = await readReply(socket, deadline.slice(COMMAND_TIMEOUT_MS));
            if (greeting.code !== 220) {
                throw new Error(`SMTP sunucusu baglantiyi kabul etmedi: ${greeting.text}`);
            }

            let ehlo = await command(`EHLO ${clientName}`, [250], "EHLO");

            // STARTTLS, porta göre değil sunucunun bildirdiği yeteneğe göre
            // yapılır (587 dışındaki gönderim portları da şifrelenir).
            if (!implicitTls && /^\d{3}[ -]STARTTLS\b/im.test(ehlo.text)) {
                await command("STARTTLS", [220], "STARTTLS");
                socket = await upgradeToTls(socket, host, "SMTP", deadline.slice(TLS_HANDSHAKE_TIMEOUT_MS));
                ehlo = await command(`EHLO ${clientName}`, [250], "EHLO (TLS)");
            }

            const smtpUser = settings.smtpUser?.trim();
            const smtpPassword = settings.smtpPassword ?? "";
            if (smtpUser && smtpPassword) {
                // Şifre asla hata metnine yazılmaz: komut yerine etiket raporlanır.
                const mechanisms = authMechanisms(ehlo.text);
                if (mechanisms.has("PLAIN")) {
                    await command(`AUTH PLAIN ${base64(`\0${smtpUser}\0${smtpPassword}`)}`, [235], "AUTH PLAIN");
                } else if (mechanisms.has("LOGIN") || mechanisms.size === 0) {
                    await command("AUTH LOGIN", [334], "AUTH LOGIN");
                    await command(base64(smtpUser), [334], "AUTH LOGIN (kullanici adi)");
                    await command(base64(smtpPassword), [235], "AUTH LOGIN (sifre)");
                } else {
                    throw new Error(
                        `SMTP sunucusu desteklenen bir kimlik dogrulama yontemi sunmuyor (${[...mechanisms].join(", ")}).`,
                    );
                }
            }

            await command(`MAIL FROM:<${mail.fromEmail.trim()}>`, [250], "MAIL FROM");
            await command(`RCPT TO:<${mail.to.trim()}>`, [250, 251], "RCPT TO");
            for (const ccAddress of ccList) {
                await command(`RCPT TO:<${ccAddress}>`, [250, 251], "RCPT TO (CC)");
            }
            await command("DATA", [354], "DATA");

            // Mesaj CRLF ile bitiyorsa sonuna bir CRLF daha eklemek teslim
            // edilen maile boş bir satır (epilog) bırakır: sonlandırıcı
            // CRLF "." CRLF dizisi zaten tamamdır.
            const data = escapeDotLines(body);
            socket.write(data.endsWith("\r\n") ? `${data}.\r\n` : `${data}\r\n.\r\n`);
            const delivery = await readReply(socket, deadline.slice(DATA_TIMEOUT_MS));
            if (delivery.code !== 250) {
                throw new Error(`SMTP gonderim hatasi: ${delivery.text}`);
            }

            // QUIT'in cevabı gelmese de mail kabul edilmiştir: kapanışta hata yutulur.
            await command("QUIT", [221], "QUIT").catch(() => undefined);
        } finally {
            socket.destroy();
        }

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
