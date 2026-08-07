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
 * GÖNDERİLENLER KOPYASI (IMAP APPEND).
 *
 * SMTP yalnızca TESLİM protokolüdür: mail alıcıya gider ama gönderenin
 * kutusunda iz bırakmaz. Outlook/Thunderbird'de mailin "Gönderilmiş Öğeler"
 * klasöründe görünmesinin sebebi, istemcinin gönderimden SONRA ayrı bir IMAP
 * APPEND yapmasıdır. Bu servis o ikinci adımı üstlenir: SMTP teslimi
 * başarıyla bittikten sonra AYNI MIME mesajı tenant'ın IMAP kutusundaki
 * Gönderilenler klasörüne yazılır.
 *
 * Kural: buradaki hiçbir hata gönderimi başarısız saymaz. Mail çoktan
 * yola çıkmıştır; kopya alınamadıysa yalnızca rapor edilir.
 */

export interface ImapSettings {
    imapHost?: string | null;
    imapPort?: number | null;
    imapSecure?: boolean | null;
    imapUser?: string | null;
    imapPassword?: string | null;
    /** Boşsa klasör sunucudan otomatik bulunur (RFC 6154 `\Sent`). */
    sentFolder?: string | null;
    /** Exchange gibi kopyayı kendi dosyalayan sunucularda kapatılır. */
    saveToSent?: boolean | null;
    /** IMAP kimlik bilgisi girilmediyse SMTP'ninkiler kullanılır. */
    smtpUser?: string | null;
    smtpPassword?: string | null;
}

export type SentCopyResult =
    | { status: "saved"; folder: string }
    | { status: "skipped"; reason: string }
    | { status: "failed"; error: string };

type ImapReply = { ok: boolean; text: string };

/**
 * Kopyanın TOPLAM süre bütçesi. Adım başına zaman aşımları tek bir adımı
 * kurtarır, toplamı değil: yanıt vermeyen bir IMAP sunucusuyla bağlan +
 * karşılama + LOGIN + LIST + APPEND zinciri dakikalarca soket açık tutabilir.
 * Bütçe dolduğunda kopya "başarısız" sayılır ve soket kapatılır.
 */
const SENT_COPY_BUDGET_MS = 60_000;
const SENT_COPY_MAX_EXTRA_MS = 60_000;

/** Aynı bütçe çağıran tarafta da bilinsin diye dışa verilir. */
export const sentCopyBudgetMs = (rawMessage: string): number =>
    budgetForMessage(SENT_COPY_BUDGET_MS, Buffer.byteLength(rawMessage, "utf8"), SENT_COPY_MAX_EXTRA_MS);

/** IMAP alıntılı dizgesi: yalnızca `\` ve `"` kaçırılır (RFC 3501). */
const quoted = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

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
const parseListLines = (text: string): Array<{ name: string; flags: string[] }> => {
    const boxes: Array<{ name: string; flags: string[] }> = [];
    for (const line of text.split(/\r?\n/)) {
        const match = /^\*\s+(?:LIST|LSUB)\s+\(([^)]*)\)\s+(?:"(?:[^"\\]|\\.)*"|NIL)\s+(.+)$/i.exec(line.trim());
        if (!match) continue;
        const flags = (match[1] || "").split(/\s+/).filter(Boolean);
        let name = (match[2] || "").trim();
        // Ad alıntılı ya da düz atom olabilir; alıntılıysa kaçışlar çözülür.
        if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
            name = name.slice(1, -1).replace(/\\(.)/g, "$1");
        }
        if (name) boxes.push({ name, flags });
    }
    return boxes;
};

export class ImapMailService {
    /**
     * Gönderilen MIME mesajını Gönderilenler klasörüne yazar.
     * Asla throw etmez: sonuç durum nesnesi olarak döner.
     */
    async appendToSent(settings: ImapSettings, rawMessage: string): Promise<SentCopyResult> {
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

        const deadline = new MailDeadline(sentCopyBudgetMs(rawMessage), "IMAP");

        let socket: MailSocket;
        try {
            socket = await openSocket(host, port, implicitTls, "IMAP", deadline.slice(CONNECT_TIMEOUT_MS));
        } catch (error: any) {
            return { status: "failed", error: error?.message || "IMAP baglantisi kurulamadi." };
        }

        let tagCounter = 0;
        try {
            const command = async (line: string, label: string, timeoutMs = COMMAND_TIMEOUT_MS) => {
                const tag = `a${++tagCounter}`;
                socket.write(`${tag} ${line}\r\n`);
                const reply = await readTagged(socket, tag, deadline.slice(timeoutMs));
                if (!reply.ok) throw new Error(`IMAP hatasi (${label}): ${lastLine(reply.text)}`);
                return reply;
            };

            const greeting = await readUntagged(socket, deadline.slice(COMMAND_TIMEOUT_MS));
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
                socket = await upgradeToTls(socket, host, "IMAP", deadline.slice(TLS_HANDSHAKE_TIMEOUT_MS));
            }

            // Şifre asla hata metnine yazılmaz: komut yerine etiket raporlanır.
            await command(`LOGIN ${quoted(user)} ${quoted(password)}`, "LOGIN");

            try {
                const folder = await this.resolveSentFolder(settings, command);
                await this.append(socket, command, folder, rawMessage, deadline);
                return { status: "saved", folder };
            } finally {
                await command("LOGOUT", "LOGOUT").catch(() => undefined);
            }
        } catch (error: any) {
            return { status: "failed", error: error?.message || "IMAP kopyasi yazilamadi." };
        } finally {
            socket.destroy();
        }
    }

    /** Klasör sırası: elle girilen ad → `\Sent` özel-kullanım → bilinen adlar → "Sent". */
    private async resolveSentFolder(
        settings: ImapSettings,
        command: (line: string, label: string) => Promise<ImapReply>,
    ): Promise<string> {
        const configured = settings.sentFolder?.trim();
        if (configured) return configured;

        const list = await command(`LIST "" "*"`, "LIST").catch(() => null);
        if (!list) return "Sent";
        const boxes = parseListLines(list.text);

        const special = boxes.find((box) => box.flags.some((flag) => flag.toLowerCase() === "\\sent"));
        if (special) return special.name;

        for (const candidate of SENT_FOLDER_CANDIDATES) {
            const match = boxes.find((box) => box.name.toLowerCase() === candidate.toLowerCase());
            if (match) return match.name;
        }
        return "Sent";
    }

    /** APPEND: senkronize literal (`{n}` → `+` → gövde). Klasör yoksa
        sunucu `[TRYCREATE]` der; bir kez oluşturup tekrar denenir. */
    private async append(
        socket: MailSocket,
        command: (line: string, label: string, timeoutMs?: number) => Promise<ImapReply>,
        folder: string,
        rawMessage: string,
        deadline: MailDeadline,
    ): Promise<void> {
        // Literal uzunluğu BAYT cinsindendir ve mesaj CRLF satır sonlu olmalıdır.
        const body = rawMessage.replace(/\r?\n/g, "\r\n");
        const size = Buffer.byteLength(body, "utf8");

        const write = async () => {
            const tag = `i${Date.now().toString(36)}`;
            // Kopya okunmuş işaretlenir: Gönderilenler klasörü "okunmadı"
            // rozetiyle şişmesin.
            socket.write(`${tag} APPEND ${quoted(folder)} (\\Seen) {${size}}\r\n`);
            const continuation = await readContinuation(socket, deadline.slice(COMMAND_TIMEOUT_MS));
            if (!continuation.ok) {
                return { ok: false, text: continuation.text };
            }
            socket.write(`${body}\r\n`);
            return await readTagged(socket, tag, deadline.slice(DATA_TIMEOUT_MS));
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

const lastLine = (text: string) => {
    const lines = text.trim().split(/\r?\n/);
    return (lines[lines.length - 1] || text).trim();
};

/** Karşılama satırı gibi etiketsiz tek yanıtı okur. */
const readUntagged = (socket: MailSocket, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> =>
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
            reject(new Error("IMAP sunucusu yanit vermedi (zaman asimi)."));
        }, timeoutMs);
        function onData(chunk: Buffer) {
            buffer += chunk.toString("utf8");
            if (!/\r?\n$/.test(buffer)) return;
            cleanup();
            resolve(buffer);
        }
        function onError(error: Error) {
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
const readTagged = (socket: MailSocket, tag: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<ImapReply> =>
    new Promise((resolve, reject) => {
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
        function onData(chunk: Buffer) {
            buffer += chunk.toString("utf8");
            const match = done.exec(buffer);
            if (!match) return;
            cleanup();
            resolve({ ok: match[1]!.toUpperCase() === "OK", text: buffer.trim() });
        }
        function onError(error: Error) {
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
const readContinuation = (socket: MailSocket, timeoutMs = COMMAND_TIMEOUT_MS): Promise<ImapReply> =>
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
            reject(new Error("IMAP sunucusu yanit vermedi (zaman asimi)."));
        }, timeoutMs);
        function onData(chunk: Buffer) {
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
        function onError(error: Error) {
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
