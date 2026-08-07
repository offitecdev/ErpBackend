"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImapMailService = exports.sentCopyBudgetMs = void 0;
const mailSocket_1 = require("./mailSocket");
/**
 * Kopyanın TOPLAM süre bütçesi. Adım başına zaman aşımları tek bir adımı
 * kurtarır, toplamı değil: yanıt vermeyen bir IMAP sunucusuyla bağlan +
 * karşılama + LOGIN + LIST + APPEND zinciri dakikalarca soket açık tutabilir.
 * Bütçe dolduğunda kopya "başarısız" sayılır ve soket kapatılır.
 */
const SENT_COPY_BUDGET_MS = 60_000;
const SENT_COPY_MAX_EXTRA_MS = 60_000;
/** Aynı bütçe çağıran tarafta da bilinsin diye dışa verilir. */
const sentCopyBudgetMs = (rawMessage) => (0, mailSocket_1.budgetForMessage)(SENT_COPY_BUDGET_MS, Buffer.byteLength(rawMessage, "utf8"), SENT_COPY_MAX_EXTRA_MS);
exports.sentCopyBudgetMs = sentCopyBudgetMs;
/** IMAP alıntılı dizgesi: yalnızca `\` ve `"` kaçırılır (RFC 3501). */
const quoted = (value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** Sunucu `\Sent` özel-kullanım bayrağını bildirmezse bakılacak klasör
    adları. Sunucu dili müşteriden müşteriye değiştiği için liste geniştir. */
const SENT_FOLDER_CANDIDATES = [
    "Sent",
    "Sent Items",
    "Sent Messages",
    "Sent Mail",
    "INBOX.Sent",
    "INBOX.Sent Items",
    "Gesendet",
    "Gesendete Elemente",
    "Gesendete Objekte",
    "Envoyés",
    "Éléments envoyés",
    "Posta inviata",
    "Elementi inviati",
    "Gönderilmiş Öğeler",
    "Gönderilenler",
];
/** LIST satırlarını ayrıştırır: `* LIST (\HasNoChildren \Sent) "/" "Sent Items"` */
const parseListLines = (text) => {
    const boxes = [];
    for (const line of text.split(/\r?\n/)) {
        const match = /^\*\s+(?:LIST|LSUB)\s+\(([^)]*)\)\s+(?:"(?:[^"\\]|\\.)*"|NIL)\s+(.+)$/i.exec(line.trim());
        if (!match)
            continue;
        const flags = (match[1] || "").split(/\s+/).filter(Boolean);
        let name = (match[2] || "").trim();
        // Ad alıntılı ya da düz atom olabilir; alıntılıysa kaçışlar çözülür.
        if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
            name = name.slice(1, -1).replace(/\\(.)/g, "$1");
        }
        if (name)
            boxes.push({ name, flags });
    }
    return boxes;
};
class ImapMailService {
    /**
     * Gönderilen MIME mesajını Gönderilenler klasörüne yazar.
     * Asla throw etmez: sonuç durum nesnesi olarak döner.
     */
    async appendToSent(settings, rawMessage) {
        if (settings.saveToSent === false) {
            return { status: "skipped", reason: "Gonderilenler kopyasi kapali." };
        }
        const host = settings.imapHost?.trim();
        if (!host) {
            return { status: "skipped", reason: "IMAP sunucusu tanimli degil." };
        }
        // IMAP kullanıcı/şifresi boşsa SMTP'ninkiler denenir: çoğu sunucuda
        // aynı hesaptır ve kullanıcıyı ikinci kez yazdırmaya gerek yoktur.
        const user = settings.imapUser?.trim() || settings.smtpUser?.trim() || "";
        const password = settings.imapPassword || settings.smtpPassword || "";
        if (!user || !password) {
            return { status: "skipped", reason: "IMAP kimlik bilgisi eksik." };
        }
        const port = Number(settings.imapPort || 0) || 993;
        // 993 gelenekesel olarak örtük TLS'tir (SMTP 465 ile aynı mantık).
        const implicitTls = settings.imapSecure === null || settings.imapSecure === undefined
            ? port === 993
            : Boolean(settings.imapSecure) || port === 993;
        const deadline = new mailSocket_1.MailDeadline((0, exports.sentCopyBudgetMs)(rawMessage), "IMAP");
        let socket;
        try {
            socket = await (0, mailSocket_1.openSocket)(host, port, implicitTls, "IMAP", deadline.slice(mailSocket_1.CONNECT_TIMEOUT_MS));
        }
        catch (error) {
            return { status: "failed", error: error?.message || "IMAP baglantisi kurulamadi." };
        }
        let tagCounter = 0;
        try {
            const command = async (line, label, timeoutMs = mailSocket_1.COMMAND_TIMEOUT_MS) => {
                const tag = `a${++tagCounter}`;
                socket.write(`${tag} ${line}\r\n`);
                const reply = await readTagged(socket, tag, deadline.slice(timeoutMs));
                if (!reply.ok)
                    throw new Error(`IMAP hatasi (${label}): ${lastLine(reply.text)}`);
                return reply;
            };
            const greeting = await readUntagged(socket, deadline.slice(mailSocket_1.COMMAND_TIMEOUT_MS));
            if (!/^\*\s+(OK|PREAUTH)\b/i.test(greeting.trim())) {
                throw new Error(`IMAP sunucusu baglantiyi kabul etmedi: ${lastLine(greeting)}`);
            }
            if (!implicitTls) {
                // STARTTLS porta göre değil sunucunun bildirdiği yeteneğe göre
                // yapılır; şifresiz oturum açmamak için 143'te zorunludur.
                const capability = await command("CAPABILITY", "CAPABILITY");
                if (!/\bSTARTTLS\b/i.test(capability.text)) {
                    throw new Error("IMAP sunucusu STARTTLS sunmuyor: sifre sifresiz baglantida gonderilmez.");
                }
                await command("STARTTLS", "STARTTLS");
                socket = await (0, mailSocket_1.upgradeToTls)(socket, host, "IMAP", deadline.slice(mailSocket_1.TLS_HANDSHAKE_TIMEOUT_MS));
            }
            // Şifre asla hata metnine yazılmaz: komut yerine etiket raporlanır.
            await command(`LOGIN ${quoted(user)} ${quoted(password)}`, "LOGIN");
            try {
                const folder = await this.resolveSentFolder(settings, command);
                await this.append(socket, command, folder, rawMessage, deadline);
                return { status: "saved", folder };
            }
            finally {
                await command("LOGOUT", "LOGOUT").catch(() => undefined);
            }
        }
        catch (error) {
            return { status: "failed", error: error?.message || "IMAP kopyasi yazilamadi." };
        }
        finally {
            socket.destroy();
        }
    }
    /** Klasör sırası: elle girilen ad → `\Sent` özel-kullanım → bilinen adlar → "Sent". */
    async resolveSentFolder(settings, command) {
        const configured = settings.sentFolder?.trim();
        if (configured)
            return configured;
        const list = await command(`LIST "" "*"`, "LIST").catch(() => null);
        if (!list)
            return "Sent";
        const boxes = parseListLines(list.text);
        const special = boxes.find((box) => box.flags.some((flag) => flag.toLowerCase() === "\\sent"));
        if (special)
            return special.name;
        for (const candidate of SENT_FOLDER_CANDIDATES) {
            const match = boxes.find((box) => box.name.toLowerCase() === candidate.toLowerCase());
            if (match)
                return match.name;
        }
        return "Sent";
    }
    /** APPEND: senkronize literal (`{n}` → `+` → gövde). Klasör yoksa
        sunucu `[TRYCREATE]` der; bir kez oluşturup tekrar denenir. */
    async append(socket, command, folder, rawMessage, deadline) {
        // Literal uzunluğu BAYT cinsindendir ve mesaj CRLF satır sonlu olmalıdır.
        const body = rawMessage.replace(/\r?\n/g, "\r\n");
        const size = Buffer.byteLength(body, "utf8");
        const write = async () => {
            const tag = `i${Date.now().toString(36)}`;
            // Kopya okunmuş işaretlenir: Gönderilenler klasörü "okunmadı"
            // rozetiyle şişmesin.
            socket.write(`${tag} APPEND ${quoted(folder)} (\\Seen) {${size}}\r\n`);
            const continuation = await readContinuation(socket, deadline.slice(mailSocket_1.COMMAND_TIMEOUT_MS));
            if (!continuation.ok) {
                return { ok: false, text: continuation.text };
            }
            socket.write(`${body}\r\n`);
            return await readTagged(socket, tag, deadline.slice(mailSocket_1.DATA_TIMEOUT_MS));
        };
        let reply = await write();
        if (!reply.ok && /TRYCREATE/i.test(reply.text)) {
            await command(`CREATE ${quoted(folder)}`, "CREATE");
            reply = await write();
        }
        if (!reply.ok) {
            throw new Error(`IMAP hatasi (APPEND ${folder}): ${lastLine(reply.text)}`);
        }
    }
}
exports.ImapMailService = ImapMailService;
const lastLine = (text) => {
    const lines = text.trim().split(/\r?\n/);
    return (lines[lines.length - 1] || text).trim();
};
/** Karşılama satırı gibi etiketsiz tek yanıtı okur. */
const readUntagged = (socket, timeoutMs = mailSocket_1.COMMAND_TIMEOUT_MS) => new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
    };
    const timer = setTimeout(() => {
        cleanup();
        reject(new Error("IMAP sunucusu yanit vermedi (zaman asimi)."));
    }, timeoutMs);
    function onData(chunk) {
        buffer += chunk.toString("utf8");
        if (!/\r?\n$/.test(buffer))
            return;
        cleanup();
        resolve(buffer);
    }
    function onError(error) {
        cleanup();
        reject(new Error(`IMAP baglanti hatasi: ${error.message}`));
    }
    function onClose() {
        cleanup();
        reject(new Error("IMAP baglantisi beklenmedik sekilde kapandi."));
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
});
/** Etiketli yanıtı okur: veri satırları (`* ...`) biriktirilir, okuma
    `<tag> OK|NO|BAD` satırında tamamlanır. */
const readTagged = (socket, tag, timeoutMs = mailSocket_1.COMMAND_TIMEOUT_MS) => new Promise((resolve, reject) => {
    let buffer = "";
    const done = new RegExp(`^${tag} (OK|NO|BAD)\\b(.*)$`, "im");
    const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
    };
    const timer = setTimeout(() => {
        cleanup();
        reject(new Error("IMAP sunucusu yanit vermedi (zaman asimi)."));
    }, timeoutMs);
    function onData(chunk) {
        buffer += chunk.toString("utf8");
        const match = done.exec(buffer);
        if (!match)
            return;
        cleanup();
        resolve({ ok: match[1].toUpperCase() === "OK", text: buffer.trim() });
    }
    function onError(error) {
        cleanup();
        reject(new Error(`IMAP baglanti hatasi: ${error.message}`));
    }
    function onClose() {
        cleanup();
        reject(new Error("IMAP baglantisi beklenmedik sekilde kapandi."));
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
});
/** APPEND literalinden önceki `+ ...` devam istemini bekler. Sunucu
    kabul etmezse (kota, izin, TRYCREATE) etiketli hata satırı gelir. */
const readContinuation = (socket, timeoutMs = mailSocket_1.COMMAND_TIMEOUT_MS) => new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
    };
    const timer = setTimeout(() => {
        cleanup();
        reject(new Error("IMAP sunucusu yanit vermedi (zaman asimi)."));
    }, timeoutMs);
    function onData(chunk) {
        buffer += chunk.toString("utf8");
        if (/^\+/m.test(buffer)) {
            cleanup();
            resolve({ ok: true, text: buffer.trim() });
            return;
        }
        // Etiketli yanıt = hata. `*`/`+` ile başlayan satırlar etiketli
        // DEĞİLDİR (`* OK [ALERT]` gibi bildirimler devam istemini bozmaz).
        if (/^[^*+\s]\S* (OK|NO|BAD)\b/im.test(buffer)) {
            cleanup();
            resolve({ ok: false, text: buffer.trim() });
        }
    }
    function onError(error) {
        cleanup();
        reject(new Error(`IMAP baglanti hatasi: ${error.message}`));
    }
    function onClose() {
        cleanup();
        reject(new Error("IMAP baglantisi beklenmedik sekilde kapandi."));
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
});
//# sourceMappingURL=ImapMailService.js.map