import nodemailer, { type Transporter } from "nodemailer";
import type { MailSettings } from "./SmtpMailService";

/**
 * SMTP-VERSAND ÜBER NODEMAILER (Vorgabe 18.08.2026).
 *
 * Ausgehende Mail geht IMMER über den EIGENEN Mailserver des Betriebs
 * (z. B. mail.offitec.eu:465/587) — nicht über Microsoft/Outlook Online, weil
 * jenes Postfach nicht mit dem Server-Postfach abgeglichen ist. Nodemailer
 * führt das SMTP-Gespräch (Verbindung, TLS, Anmeldung, Zeitlimits).
 *
 * WICHTIG — die Nachricht selbst baut weiterhin `buildMimeMessage()`:
 * nodemailer bekommt die fertigen Bytes als `raw`. Grund: genau diese Bytes
 * werden nach der Zustellung auch per IMAP in "Gesendet" abgelegt, und der
 * Aufbau (multipart/mixed › related › alternative, Signatur mit `cid:`-Bildern,
 * die load-bearing Leerzeile zwischen Kopf und Rumpf) ist erprobt. Liesse man
 * nodemailer die Nachricht selbst zusammensetzen, wären die abgelegte Kopie und
 * die zugestellte Mail zwei verschiedene Dinge.
 */

export interface NodemailerSendResult {
    accepted: string[];
    rejected: string[];
    response: string;
}

/**
 * Ein Transporter je Server+Konto, damit Verbindungen wiederverwendet werden
 * (Pool). Der Schlüssel enthält das Passwort NICHT im Klartext — nur seine
 * Länge und den Benutzer, das genügt zur Unterscheidung und hält Geheimnisse
 * aus Log-/Fehlerpfaden heraus.
 */
const pool = new Map<string, Transporter>();

const transporterKey = (settings: MailSettings) => [
    settings.smtpHost?.trim() || "",
    Number(settings.smtpPort || 0),
    settings.smtpSecure ? "1" : "0",
    settings.smtpUser?.trim() || "",
    String((settings.smtpPassword || "").length),
].join("|");

export const getTransporter = (settings: MailSettings, timeoutMs: number): Transporter => {
    const key = transporterKey(settings);
    const cached = pool.get(key);
    if (cached) return cached;

    const host = settings.smtpHost!.trim();
    const port = Number(settings.smtpPort || 0);
    // 465 ist herkömmlich implizites TLS. Das Kästchen zu vergessen ist der
    // häufigste Konfigurationsfehler, darum entscheidet auch der Port mit;
    // auf 587 & Co. hebt nodemailer die Verbindung selbst per STARTTLS an,
    // sobald der Server es anbietet.
    const secure = Boolean(settings.smtpSecure) || port === 465;
    const user = settings.smtpUser?.trim();
    const pass = settings.smtpPassword ?? "";

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        ...(user && pass ? { auth: { user, pass } } : {}),
        // Manche Server weisen EHLO-Namen ohne Punkt ab: die Absenderdomain
        // ist ein gültiger Name und verrät nichts Zusätzliches.
        name: settings.fromEmail?.split("@")[1]?.trim() || undefined,
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
        // Selbstsignierte Zertifikate kommen auf eigenen Mailservern vor; die
        // Verbindung bleibt verschlüsselt, nur die Kettenprüfung ist milder.
        tls: { rejectUnauthorized: false },
    });
    pool.set(key, transporter);
    return transporter;
};

/** Verwirft zwischengespeicherte Verbindungen (Einstellungen geändert). */
export const resetTransporters = (): void => {
    for (const transporter of pool.values()) {
        try { transporter.close(); } catch { /* egal */ }
    }
    pool.clear();
};

/**
 * Verschickt die FERTIGE MIME-Nachricht. Empfänger stehen im Umschlag
 * (envelope), nicht in den Kopfzeilen — Bcc-artige Fälle und die CC-Liste
 * bleiben so unter unserer Kontrolle.
 */
export const sendRawMessage = async (
    settings: MailSettings,
    mime: string,
    envelope: { from: string; to: string[] },
    timeoutMs: number,
): Promise<NodemailerSendResult> => {
    const transporter = getTransporter(settings, timeoutMs);
    try {
        const info = await transporter.sendMail({
            envelope: { from: envelope.from, to: envelope.to },
            raw: mime,
        });
        return {
            accepted: (info.accepted || []).map(String),
            rejected: (info.rejected || []).map(String),
            response: String(info.response || ""),
        };
    } catch (error: any) {
        // Fehlertext beginnt mit "SMTP", weil die aufrufenden Endpunkte daran
        // die Meldung "bitte Mail-Einstellungen prüfen" festmachen. Das
        // Passwort taucht in nodemailer-Fehlern nicht auf.
        const code = error?.responseCode || error?.code;
        throw new Error(`SMTP hatasi${code ? ` (${code})` : ""}: ${error?.message || error}`);
    }
};
