import net from "net";
import tls from "tls";

export interface MailSettings {
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
    subject: string;
    text?: string | null;
    html?: string | null;
    replyTo?: string | null;
    attachments?: Array<{
        filename: string;
        contentType: string;
        contentBase64: string;
    }>;
}

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

export class SmtpMailService {
    async send(settings: MailSettings, mail: SendMailInput): Promise<{ accepted: string[]; preview: boolean }> {
        if (!settings.smtpHost || !settings.smtpPort) {
            return { accepted: [mail.to], preview: true };
        }

        let socket: net.Socket | tls.TLSSocket = settings.smtpSecure
            ? tls.connect(settings.smtpPort, settings.smtpHost, { servername: settings.smtpHost })
            : net.connect(settings.smtpPort, settings.smtpHost);

        const read = () => new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            const onData = (chunk: Buffer) => {
                chunks.push(chunk);
                const text = Buffer.concat(chunks).toString("utf8");
                const lines = text.trimEnd().split(/\r?\n/);
                const last = lines[lines.length - 1] || "";
                if (/^\d{3} /.test(last)) {
                    socket.off("data", onData);
                    resolve(text);
                }
            };
            socket.on("data", onData);
            socket.once("error", reject);
        });

        const write = async (command: string, expected: number[]) => {
            socket.write(`${command}\r\n`);
            const response = await read();
            const code = Number(response.slice(0, 3));
            if (!expected.includes(code)) {
                throw new Error(`SMTP hata (${command}): ${response.trim()}`);
            }
            return response;
        };

        await read();
        await write(`EHLO offitec-erp.local`, [250]);

        if (!settings.smtpSecure && settings.smtpPort === 587) {
            await write("STARTTLS", [220]);
            socket = tls.connect({ socket, servername: settings.smtpHost });
            await write(`EHLO offitec-erp.local`, [250]);
        }

        if (settings.smtpUser && settings.smtpPassword) {
            await write("AUTH LOGIN", [334]);
            await write(Buffer.from(settings.smtpUser).toString("base64"), [334]);
            await write(Buffer.from(settings.smtpPassword).toString("base64"), [235]);
        }

        const text = mail.text || mail.html?.replace(/<[^>]+>/g, " ") || "";
        const html = mail.html || `<pre>${text}</pre>`;
        const altBoundary = `offitec-alt-${Date.now()}`;
        const mixedBoundary = `offitec-mixed-${Date.now()}`;
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
            `Subject: ${encodeHeader(mail.subject)}`,
            `Date: ${new Date().toUTCString()}`,
            `MIME-Version: 1.0`,
            mail.replyTo ? `Reply-To: ${mail.replyTo}` : null,
            `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
            ``,
            `--${mixedBoundary}`,
            alternativePart,
            ...attachmentParts,
            `--${mixedBoundary}--`,
            ``,
        ].filter(Boolean).join("\r\n");

        await write(`MAIL FROM:<${mail.fromEmail}>`, [250]);
        await write(`RCPT TO:<${mail.to}>`, [250, 251]);
        await write("DATA", [354]);
        socket.write(`${escapeDotLines(body)}\r\n.\r\n`);
        const response = await read();
        const code = Number(response.slice(0, 3));
        if (code !== 250) throw new Error(`SMTP gonderim hatasi: ${response.trim()}`);
        await write("QUIT", [221]);
        socket.end();

        return { accepted: [mail.to], preview: false };
    }
}
