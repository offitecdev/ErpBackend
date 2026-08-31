import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
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
import { getCompanyTreeTenantIds, getMailTenantId } from "./serviceTenantScope";
import { captureInbox, normalizeWindowMonths } from "../../infrastructure/services/ImapCaptureService";
import { mailboxIdentity } from "../../infrastructure/services/mailboxIdentity";

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
    /* DIE LESESTÄNDE MÜSSEN HIER RAUS — und zwar ALLE. Es sind BigInt-Spalten,
       und `JSON.stringify` kennt BigInt nicht ("Do not know how to serialize a
       BigInt"). Der Fehler fällt nicht dort auf, wo er entsteht: er fliegt beim
       Senden der Antwort, wird vom catch des Endpunkts geschluckt und kommt als
       400 zurück — als wäre die EINGABE falsch. Wer hier eine Spalte ergänzt,
       ergänzt sie also auch in dieser Liste. Die Oberfläche braucht keine davon. */
    imapUidValidity: undefined,
    imapLastUid: undefined,
    imapSentUidValidity: undefined,
    imapSentLastUid: undefined,
    caldavPassword: undefined,
    caldavLastSyncAt: settings.caldavLastSyncAt ?? null,
    hasPassword: Boolean(settings.smtpPassword),
    hasImapPassword: Boolean(settings.imapPassword),
    /* Leer heisst hier NICHT "kein Zugang": ohne eigenes CalDAV-Passwort
       nimmt der Abruf das des IMAP-Kontos — es ist dasselbe Postfach. Die
       Oberflaeche sagt das auch so, sonst sieht ein leeres Feld nach einer
       fehlenden Einrichtung aus. */
    hasCaldavPassword: Boolean(settings.caldavPassword),
});

export class MailController {
    async getSettings(req: Request, res: Response) {
        try {
            /* EIN POSTFACH JE FIRMA: die Zugangsdaten stehen am Stamm des
               Firmenbaums. Wer sie in einer Untergesellschaft öffnet, sieht und
               bearbeitet dieselbe Einrichtung — legte jede Firma ihre eigene an,
               holten zwei Abrufe dasselbe Serverpostfach in zwei Bestände. */
            const tenantId = await getMailTenantId(req.user!.tenantId);
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
            // Gespeichert wird am Stamm — siehe getSettings.
            const tenantId = await getMailTenantId(req.user!.tenantId);
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

            /* CalDAV-Passwort: dieselbe Regel wie oben — leer = unangetastet,
               ausdrückliches null = löschen. Bleibt es leer, benutzt der Abruf
               das IMAP-Passwort; es ist dasselbe Konto. */
            const caldavPassword =
                body.caldavPassword === null
                    ? null
                    : body.caldavPassword === undefined || String(body.caldavPassword).trim() === ""
                        ? existing?.caldavPassword ?? null
                        : String(body.caldavPassword).trim();

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
                // Wie weit das Postfach zurückreicht: 1 oder 2 Monate.
                imapWindowMonths: body.imapWindowMonths === undefined
                    ? normalizeWindowMonths(existing?.imapWindowMonths)
                    : normalizeWindowMonths(body.imapWindowMonths),
            };

            /* DER KALENDER DESSELBEN KONTOS (CalDAV, 31.08.2026). Nicht
               gesendete Felder bleiben stehen — eine Teilspeicherung darf den
               Kalenderabruf nicht heimlich abschalten. Benutzer und Passwort
               dürfen leer bleiben: dann gelten die des IMAP-Kontos. Die Adresse
               ebenfalls — sie wird über /.well-known/caldav gesucht. */
            const caldavFields = {
                caldavEnabled: body.caldavEnabled === undefined
                    ? existing?.caldavEnabled ?? false
                    : Boolean(body.caldavEnabled),
                caldavUrl: body.caldavUrl === undefined
                    ? existing?.caldavUrl ?? null
                    : String(body.caldavUrl || "").trim() || null,
                caldavUser: body.caldavUser === undefined
                    ? existing?.caldavUser ?? null
                    : String(body.caldavUser || "").trim() || null,
                caldavPassword,
            };

            /* Wird das Postfach GEWECHSELT, verschwinden die Nachrichten des
               alten mit ihm — sie gehören zu einem Konto, das dieses Haus nicht
               mehr liest. Verglichen werden die Werte, die GESPEICHERT werden
               (Teilspeicherungen erben die übrigen aus `existing`), nicht die
               rohen Felder des Formulars.

               Der Lesestand fällt dabei mit: die UIDs des neuen Servers haben
               mit den alten nichts zu tun, und ohne Zurücksetzen bliebe der
               erste Durchgang stumm. Danach liest der Abruf den letzten Monat
               des neuen Postfachs von vorn. */
            const previousIdentity = mailboxIdentity(existing?.imapHost, existing?.imapUser, existing?.smtpUser, existing?.fromEmail);
            const nextIdentity = mailboxIdentity(
                imapFields.imapHost,
                imapFields.imapUser,
                String(body.smtpUser || "").trim() || null,
                body.fromEmail || null,
            );
            const mailboxChanged = Boolean(previousIdentity) && previousIdentity !== nextIdentity;
            let purgedMessages = 0;
            let purgedMeetings = 0;
            const calendarTenantIds = await getCompanyTreeTenantIds(tenantId).catch(() => [tenantId]);
            const treeTenantIds = calendarTenantIds.length ? calendarTenantIds : [tenantId];

            if (mailboxChanged) {
                const removed = await prisma.mailMessage.deleteMany({ where: { tenantId } });
                purgedMessages = removed.count;
                console.log(`[MAIL] Postfachwechsel ${previousIdentity} → ${nextIdentity}: ${purgedMessages} Nachricht(en) entfernt.`);
            }

            /* DER KALENDER HÄNGT AM POSTFACH (Vorgabe 31.08.2026: «wechselt die
               Adresse, muss sich ändern, was aus Outlook in den Kalender kommt»
               — und nachgeschärft am selben Tag: «ich bekomme Termine aus einem
               anderen Konto, obwohl ich es gewechselt habe»).

               DAS AUFRÄUMEN HÄNGT NICHT MEHR AM WECHSEL, SONDERN AN DER
               KENNUNG. Vorher lief es nur, wenn die Zeile AM STAMM ihre Kennung
               änderte — und genau das trat beim einzigen echten Wechsel nicht
               ein: die Stammzeile wurde neu ANGELEGT (`previousIdentity` leer,
               `mailboxChanged` falsch), während die 56 übernommenen Termine des
               alten Kontos in der Untergesellschaft weiterlagen. Wer den
               Kalender öffnete, sah fremde Besprechungen und konnte nichts
               dagegen tun.

               Jetzt ist der Massstab die Kennung selbst: was NICHT aus dem
               Postfach stammt, das gerade gespeichert wird, gehört nicht in
               diesen Kalender — egal, ob dieses Speichern etwas geändert hat.
               Damit heilt schon das blosse Speichern der Einstellungen einen
               Altbestand, und der Fall «neu angelegte Stammzeile» kann sich
               nicht wiederholen.

               ZWEI EINSCHRÄNKUNGEN halten das Löschen eng:

                 `externalOrigin` gesetzt — NUR was von aussen kam. Ein Termin,
                 den jemand im ERP angelegt hat, gehört dem Haus und wird hier
                 nie angefasst (dieselbe Besitzfrage, an der schon der Import
                 entscheidet, ob er überschreiben darf).

                 Der GANZE FIRMENBAUM — übernommene Termine liegen seit dem
                 31.08.2026 am Stamm, aber Zeilen aus der Zeit davor können noch
                 in einer Untergesellschaft stehen. Nur am Stamm zu löschen
                 liesse genau die stehen, die jemand tatsächlich sieht. */
            if (nextIdentity) {
                const removedMeetings = await (prisma as any).meetingActivity.deleteMany({
                    where: {
                        tenantId: { in: treeTenantIds },
                        NOT: { externalOrigin: null },
                        OR: [
                            { externalMailbox: null },
                            { externalMailbox: { not: nextIdentity } },
                        ],
                    },
                });
                purgedMeetings = removedMeetings.count;
                if (purgedMeetings) {
                    console.log(`[MAIL] Kalender auf ${nextIdentity} gestellt: `
                        + `${purgedMeetings} Termin(e) aus einem anderen Konto entfernt.`);
                }
            }

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
                    ...caldavFields,
                    /* BEIDE LESESTÄNDE fallen mit — Posteingang UND Gesendet.
                       Der Gesendet-Ordner führt einen eigenen (seine UIDs haben
                       mit denen des Posteingangs nichts zu tun), und blieb er
                       stehen, läse der Abruf im neuen Postfach erst hinter einer
                       UID weiter, die dort einer ganz anderen Nachricht gehört:
                       die ausgehenden Einladungen — in Outlook angesetzte
                       Teams-Besprechungen — kämen nie im Kalender an. */
                    ...(mailboxChanged
                        ? {
                            imapUidValidity: null, imapLastUid: 0n,
                            imapSentUidValidity: null, imapSentLastUid: 0n,
                            imapLastSyncAt: null, imapLastSummary: null, imapLastError: null,
                            /* Die gefundenen Kalender gehören dem alten Konto.
                               Stehen bleiben dürften sie nicht: der nächste
                               Abruf spräche sonst Adressen an, für die das neue
                               Konto keine Berechtigung hat, und meldete
                               Fehlschläge statt neu zu suchen. */
                            caldavCalendars: Prisma.DbNull,
                            caldavLastSyncAt: null, caldavLastSummary: null, caldavLastError: null,
                        }
                        : {}),
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
                    ...caldavFields,
                    signatureHtml,
                    signatureImage
                }
            });

            // Geänderte Zugangsdaten dürfen nicht in einem Verbindungspool
            // weiterleben: der nächste Versand baut die Verbindung neu auf.
            resetTransporters();

            /* NACH DEM WECHSEL SOFORT NEU EINLESEN. Der Zeitplan käme erst in
               drei Minuten vorbei — und bis dahin stünde der Kalender LEER da:
               die Termine des alten Kontos sind eben gelöscht worden, die des
               neuen noch nicht geholt. Genau in diesem Loch ruft jemand an und
               sagt, das Speichern habe den Kalender zerschossen.

               Im Hintergrund, ohne `await`: das Speichern der Einstellungen
               darf nicht auf einen Mailserver warten. Der Abruf schreibt seinen
               eigenen Fortschritt und meldet sich in der Statuszeile. */
            if (mailboxChanged) {
                void captureInbox(tenantId).catch((error: any) => {
                    console.error("[MAIL] Erstabruf des neuen Postfachs fehlgeschlagen:", error?.message || error);
                });
            }

            // `purgedMessages`/`purgedMeetings` sagen der Oberfläche, was der
            // Wechsel gekostet hat — eine stille Löschung wäre eine böse
            // Überraschung.
            res.status(200).json({ ...settingsDto(settings), purgedMessages, purgedMeetings });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async send(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            // Der Versandweg gehört dem Postfach (Stamm), der Kundenbezug
            // weiter unten der eigenen Firma.
            const settings = await prisma.mailSetting.findUnique({ where: { tenantId: await getMailTenantId(tenantId) } });
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
