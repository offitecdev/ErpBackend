"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SmtpMailService = void 0;
const net_1 = __importDefault(require("net"));
const tls_1 = __importDefault(require("tls"));
/** Sunucu yanıt vermezse istek sonsuza kadar asılı kalmasın: her adımın
    kendi zaman aşımı vardır ve hata olarak yüzeye çıkar. */
const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DATA_TIMEOUT_MS = 120_000;
const encodeHeader = (value) => {
    if (/^[\x00-\x7F]*$/.test(value))
        return value;
    return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
};
const address = (email, name) => {
    const cleanEmail = email.trim();
    return name ? `"${encodeHeader(name).replace(/"/g, '\\"')}" <${cleanEmail}>` : cleanEmail;
};
const escapeDotLines = (body) => body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
const base64 = (value) => Buffer.from(value, "utf8").toString("base64");
/** EHLO cevabındaki `250-AUTH PLAIN LOGIN` satırından mekanizmalar. */
const authMechanisms = (ehlo) => {
    const mechanisms = new Set();
    for (const line of ehlo.split(/\r?\n/)) {
        const match = /^\d{3}[ -]AUTH[ =](.+)$/i.exec(line.trim());
        if (!match)
            continue;
        for (const mechanism of match[1].trim().split(/\s+/))
            mechanisms.add(mechanism.toUpperCase());
    }
    return mechanisms;
};
/** SNI, IP literalleri için gönderilmez (RFC 6066). */
const sniFor = (host) => (net_1.default.isIP(host) ? undefined : host);
const openSocket = (host, port, secure) => new Promise((resolve, reject) => {
    const socket = secure
        ? tls_1.default.connect({ host, port, servername: sniFor(host) })
        : net_1.default.connect({ host, port });
    const readyEvent = secure ? "secureConnect" : "connect";
    const cleanup = () => {
        socket.setTimeout(0);
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
        socket.off(readyEvent, onReady);
    };
    const fail = (message) => {
        cleanup();
        socket.destroy();
        reject(new Error(message));
    };
    function onError(error) {
        fail(`SMTP sunucusuna baglanilamadi (${host}:${port}): ${error.message}`);
    }
    function onTimeout() {
        fail(`SMTP sunucusuna baglanilamadi (${host}:${port}): baglanti zaman asimina ugradi.`);
    }
    function onReady() {
        cleanup();
        resolve(socket);
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once(readyEvent, onReady);
});
/** STARTTLS sonrası aynı bağlantıyı TLS'e yükseltir. */
const upgradeToTls = (socket, host) => new Promise((resolve, reject) => {
    const secure = tls_1.default.connect({ socket, servername: sniFor(host) });
    const cleanup = () => {
        secure.off("error", onError);
        secure.off("secureConnect", onReady);
    };
    function onError(error) {
        cleanup();
        secure.destroy();
        reject(new Error(`SMTP TLS el sikismasi basarisiz (${host}): ${error.message}`));
    }
    function onReady() {
        cleanup();
        resolve(secure);
    }
    secure.once("error", onError);
    secure.once("secureConnect", onReady);
});
/** Tek bir SMTP yanıtı okur. Çok satırlı yanıtlarda (`250-...`) yalnızca
    son satır `NNN ` biçimindedir; okuma orada tamamlanır. */
const readReply = (socket, timeoutMs = COMMAND_TIMEOUT_MS) => new Promise((resolve, reject) => {
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
    function onData(chunk) {
        buffer += chunk.toString("utf8");
        const lines = buffer.replace(/\r?\n$/, "").split(/\r?\n/);
        const last = lines[lines.length - 1] || "";
        if (!/^\d{3}( |$)/.test(last))
            return; // `250-` = devam satiri
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: buffer.trim() });
    }
    function onError(error) {
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
class SmtpMailService {
    async send(settings, mail) {
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
        let socket = await openSocket(host, port, implicitTls);
        try {
            const command = async (line, expected, label) => {
                socket.write(`${line}\r\n`);
                const reply = await readReply(socket);
                if (!expected.includes(reply.code)) {
                    throw new Error(`SMTP hatasi (${label}): ${reply.text}`);
                }
                return reply;
            };
            const greeting = await readReply(socket);
            if (greeting.code !== 220) {
                throw new Error(`SMTP sunucusu baglantiyi kabul etmedi: ${greeting.text}`);
            }
            let ehlo = await command(`EHLO ${clientName}`, [250], "EHLO");
            // STARTTLS, porta göre değil sunucunun bildirdiği yeteneğe göre
            // yapılır (587 dışındaki gönderim portları da şifrelenir).
            if (!implicitTls && /^\d{3}[ -]STARTTLS\b/im.test(ehlo.text)) {
                await command("STARTTLS", [220], "STARTTLS");
                socket = await upgradeToTls(socket, host);
                ehlo = await command(`EHLO ${clientName}`, [250], "EHLO (TLS)");
            }
            const smtpUser = settings.smtpUser?.trim();
            const smtpPassword = settings.smtpPassword ?? "";
            if (smtpUser && smtpPassword) {
                // Şifre asla hata metnine yazılmaz: komut yerine etiket raporlanır.
                const mechanisms = authMechanisms(ehlo.text);
                if (mechanisms.has("PLAIN")) {
                    await command(`AUTH PLAIN ${base64(`\0${smtpUser}\0${smtpPassword}`)}`, [235], "AUTH PLAIN");
                }
                else if (mechanisms.has("LOGIN") || mechanisms.size === 0) {
                    await command("AUTH LOGIN", [334], "AUTH LOGIN");
                    await command(base64(smtpUser), [334], "AUTH LOGIN (kullanici adi)");
                    await command(base64(smtpPassword), [235], "AUTH LOGIN (sifre)");
                }
                else {
                    throw new Error(`SMTP sunucusu desteklenen bir kimlik dogrulama yontemi sunmuyor (${[...mechanisms].join(", ")}).`);
                }
            }
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
            const body = [
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
            ].filter(Boolean).join("\r\n");
            await command(`MAIL FROM:<${mail.fromEmail.trim()}>`, [250], "MAIL FROM");
            await command(`RCPT TO:<${mail.to.trim()}>`, [250, 251], "RCPT TO");
            for (const ccAddress of ccList) {
                await command(`RCPT TO:<${ccAddress}>`, [250, 251], "RCPT TO (CC)");
            }
            await command("DATA", [354], "DATA");
            socket.write(`${escapeDotLines(body)}\r\n.\r\n`);
            const delivery = await readReply(socket, DATA_TIMEOUT_MS);
            if (delivery.code !== 250) {
                throw new Error(`SMTP gonderim hatasi: ${delivery.text}`);
            }
            // QUIT'in cevabı gelmese de mail kabul edilmiştir: kapanışta hata yutulur.
            await command("QUIT", [221], "QUIT").catch(() => undefined);
            return { accepted: [mail.to, ...ccList], preview: false };
        }
        finally {
            socket.destroy();
        }
    }
}
exports.SmtpMailService = SmtpMailService;
//# sourceMappingURL=SmtpMailService.js.map