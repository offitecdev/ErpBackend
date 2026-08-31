"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMailSyncEngine = exports.syncAccount = exports.isSyncRunning = void 0;
/*
 * ⚠ NICHT IN BENUTZUNG (Stand 18.08.2026).
 *
 * Diese Datei gehoert zur Microsoft-365-/Graph-Anbindung. Sie ist bewusst
 * abgeklemmt: Mail geht ueber den EIGENEN Mailserver des Betriebs (SMTP per
 * nodemailer hinaus, IMAP per ImapCaptureService herein), weil das Postfach in
 * Outlook Online damit nicht abgeglichen ist. Der Code bleibt liegen, falls ein
 * Mandant spaeter doch auf Microsoft 365 laeuft — dann werden die Routen wieder
 * eingehaengt. Nichts importiert ihn zurzeit.
 */
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../database/prisma.client"));
const msGraphClient_1 = require("./msGraphClient");
const msGraphAuth_1 = require("./msGraphAuth");
const mailCustomerMatcher_1 = require("./mailCustomerMatcher");
const mailAutoCategory_1 = require("./mailAutoCategory");
const mailText_1 = require("./mailText");
/**
 * SYNC OUTLOOK → ERP (Grunddaten).
 *
 * Je verbundenem Postfach werden zwei Ordner per Graph-DELTA-Abfrage verfolgt:
 * Posteingang (IN) und Gesendete Elemente (OUT). Der Delta-Link merkt sich den
 * Stand; die Erstsynchronisation ist auf `syncFromDate` (Vorgabe 30 Tage
 * rückwärts) begrenzt. Von jeder Nachricht landen nur die Grunddaten in
 * `MailMessage` (Absender/Empfänger/Betreff/Zeit/Text) — Anhänge nie, nur
 * das Kennzeichen `hasAttachments` (Metadaten holt die Detailansicht live).
 *
 * "@removed"-Einträge (gelöscht ODER in einen Unterordner verschoben) werden
 * absichtlich IGNORIERT: die Kundenhistorie soll nicht verschwinden, weil
 * jemand sein Postfach aufräumt.
 *
 * Aus dem ERP verschickte Mails werden beim Sync von "Gesendet" über die
 * Message-ID wiedererkannt und mit der bestehenden Zeile ZUSAMMENGEFÜHRT
 * (kein Doppel).
 */
const TICK_MS = 3 * 60_000;
const MIN_GAP_MS = 2 * 60_000;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_FOLDER = 40; // 2000 Nachrichten je Ordner und Lauf; Rest im nächsten Lauf
const SELECT = [
    "id", "subject", "from", "toRecipients", "ccRecipients", "receivedDateTime", "sentDateTime",
    "bodyPreview", "body", "hasAttachments", "internetMessageId", "conversationId", "webLink", "isRead", "isDraft",
].join(",");
const FOLDERS = [
    { key: "inbox", direction: "IN", linkField: "inboxDeltaLink" },
    { key: "sentitems", direction: "OUT", linkField: "sentDeltaLink" },
];
const running = new Set();
const partyOf = (raw) => {
    const address = (0, mailCustomerMatcher_1.normalizeAddress)(raw?.emailAddress?.address);
    if (!address)
        return null;
    return { name: String(raw?.emailAddress?.name || "").trim() || null, address };
};
const partiesOf = (raw) => (Array.isArray(raw) ? raw.map(partyOf).filter((p) => Boolean(p)) : []);
const messageDate = (m, direction) => {
    const value = direction === "OUT" ? (m.sentDateTime || m.receivedDateTime) : (m.receivedDateTime || m.sentDateTime);
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? new Date() : date;
};
const bodyTextOf = (m) => {
    const content = String(m?.body?.content || "");
    if (!content)
        return null;
    const type = String(m?.body?.contentType || "").toLowerCase();
    return (0, mailText_1.clampBody)(type === "html" ? (0, mailText_1.htmlToText)(content) : content.replace(/\r\n/g, "\n").trim());
};
const initialDeltaUrl = (folder, syncFrom) => {
    const params = new URLSearchParams({ $select: SELECT });
    if (syncFrom)
        params.set("$filter", `receivedDateTime ge ${syncFrom.toISOString()}`);
    return `/me/mailFolders/${folder.key}/messages/delta?${params.toString()}`;
};
const syncFolder = async (account, folder) => {
    const run = { inserted: 0, merged: 0, updated: 0, matched: 0, skipped: 0, pages: 0 };
    const own = (0, mailCustomerMatcher_1.normalizeAddress)(account.mailboxAddress);
    let url = account[folder.linkField] || initialDeltaUrl(folder, account.syncFromDate);
    let usedFilter = !account[folder.linkField] && Boolean(account.syncFromDate);
    const book = await (0, mailCustomerMatcher_1.getAddressBook)(account.tenantId);
    // Wie beim IMAP-Abruf: steht die Gegenstelle in der Kategorienleiste,
    // trägt die Nachricht das Etikett gleich mit.
    const categories = await (0, mailAutoCategory_1.getCategoryIndex)(account.tenantId);
    while (url && run.pages < MAX_PAGES_PER_FOLDER) {
        let page;
        try {
            page = await (0, msGraphClient_1.graphFetch)(account.id, url, {
                headers: { Prefer: `outlook.body-content-type="text", odata.maxpagesize=${PAGE_SIZE}` },
                timeoutMs: 45_000,
            });
        }
        catch (error) {
            // Manche Mandanten lehnen $filter auf Delta ab → ohne Filter neu
            // beginnen und das Fenster clientseitig anwenden.
            if (usedFilter && error instanceof msGraphClient_1.GraphRequestError && error.status === 400) {
                usedFilter = false;
                url = initialDeltaUrl(folder, null);
                continue;
            }
            throw error;
        }
        run.pages += 1;
        const rows = Array.isArray(page?.value) ? page.value : [];
        const candidates = [];
        for (const m of rows) {
            if (!m || m["@removed"] || !m.id) {
                run.skipped += 1;
                continue;
            }
            if (m.isDraft) {
                run.skipped += 1;
                continue;
            }
            const at = messageDate(m, folder.direction);
            if (account.syncFromDate && at.getTime() < account.syncFromDate.getTime()) {
                run.skipped += 1;
                continue;
            }
            candidates.push(m);
        }
        if (candidates.length) {
            const providerIds = candidates.map((m) => String(m.id));
            const internetIds = candidates.map((m) => String(m.internetMessageId || "")).filter(Boolean);
            const [existingByProvider, existingByInternet] = await Promise.all([
                prisma_client_1.default.mailMessage.findMany({
                    where: { accountId: account.id, providerMessageId: { in: providerIds } },
                    select: { id: true, providerMessageId: true, isRead: true, subject: true },
                }),
                internetIds.length
                    ? prisma_client_1.default.mailMessage.findMany({
                        where: { tenantId: account.tenantId, internetMessageId: { in: internetIds }, providerMessageId: null },
                        select: { id: true, internetMessageId: true, direction: true },
                    })
                    : Promise.resolve([]),
            ]);
            const byProvider = new Map(existingByProvider.map((row) => [row.providerMessageId, row]));
            const byInternet = new Map(existingByInternet.map((row) => [row.internetMessageId, row]));
            const inserts = [];
            const updates = [];
            for (const m of candidates) {
                const providerId = String(m.id);
                const from = partyOf(m.from);
                const to = partiesOf(m.toRecipients);
                const cc = partiesOf(m.ccRecipients);
                const isRead = m.isRead !== false;
                const existing = byProvider.get(providerId);
                if (existing) {
                    // Nur Lesestatus/Betreff nachziehen — Kundenzuordnung bleibt.
                    if (existing.id && (existing.isRead !== isRead || (m.subject && existing.subject !== m.subject))) {
                        updates.push(prisma_client_1.default.mailMessage.update({
                            where: { id: existing.id },
                            data: { isRead, subject: String(m.subject || "").slice(0, 500) || existing.subject },
                        }));
                        run.updated += 1;
                    }
                    continue;
                }
                const internetId = String(m.internetMessageId || "").trim() || null;
                const erpRow = internetId ? byInternet.get(internetId) : undefined;
                if (erpRow) {
                    // ERP-Sendung wiedergefunden ("Gesendet"-Kopie): zusammenführen.
                    updates.push(prisma_client_1.default.mailMessage.update({
                        where: { id: erpRow.id },
                        data: {
                            accountId: account.id,
                            providerMessageId: providerId,
                            conversationId: String(m.conversationId || "").slice(0, 255) || null,
                            ...(m.webLink ? { webLink: String(m.webLink) } : {}),
                        },
                    }).catch(() => undefined));
                    byInternet.delete(internetId);
                    run.merged += 1;
                    continue;
                }
                // Gegenstellen für die Kundenzuordnung: IN → Absender (und, falls
                // der Absender das eigene Postfach ist, die Empfänger); OUT →
                // Empfänger + CC ohne das eigene Postfach.
                const counterparts = folder.direction === "IN"
                    ? (from && from.address !== own ? [from.address] : to.map((p) => p.address))
                    : [...to, ...cc].map((p) => p.address).filter((address) => address !== own);
                const hit = (0, mailCustomerMatcher_1.matchAddresses)(book, counterparts);
                if (hit)
                    run.matched += 1;
                const bodyText = bodyTextOf(m);
                inserts.push({
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId: account.tenantId,
                    accountId: account.id,
                    employeeId: account.employeeId,
                    direction: folder.direction,
                    origin: "OUTLOOK",
                    providerMessageId: providerId,
                    internetMessageId: internetId,
                    conversationId: String(m.conversationId || "").slice(0, 255) || null,
                    subject: String(m.subject || "").slice(0, 500) || null,
                    fromName: from?.name?.slice(0, 255) || null,
                    fromAddress: from?.address?.slice(0, 255) || null,
                    toRecipients: to,
                    ccRecipients: cc.length ? cc : client_1.Prisma.JsonNull,
                    bodyPreview: (0, mailText_1.previewOf)(String(m.bodyPreview || "") || bodyText, 500),
                    bodyText,
                    sentAt: messageDate(m, folder.direction),
                    hasAttachments: Boolean(m.hasAttachments),
                    webLink: m.webLink ? String(m.webLink) : null,
                    isRead,
                    customerId: hit?.customerId || null,
                    contactId: hit?.contactId || null,
                    matchSource: hit?.source || null,
                    categoryId: (0, mailAutoCategory_1.autoCategoryId)(categories, { customerId: hit?.customerId, employeeId: hit?.employeeId }),
                });
                // Dieselbe providerId ein zweites Mal auf der Seite (bei Delta praktisch
                // ausgeschlossen) nicht doppelt einfügen.
                byProvider.set(providerId, { id: "", providerMessageId: providerId, isRead, subject: null });
            }
            if (inserts.length) {
                await prisma_client_1.default.mailMessage.createMany({ data: inserts, skipDuplicates: true });
                run.inserted += inserts.length;
            }
            if (updates.length)
                await Promise.all(updates);
        }
        const next = page?.["@odata.nextLink"];
        const delta = page?.["@odata.deltaLink"];
        if (delta) {
            await prisma_client_1.default.mailAccount.update({ where: { id: account.id }, data: { [folder.linkField]: String(delta) } });
            url = "";
        }
        else if (next) {
            url = String(next);
            // Zwischenstand sichern: bricht der Lauf ab, geht es hier weiter.
            await prisma_client_1.default.mailAccount.update({ where: { id: account.id }, data: { [folder.linkField]: url } });
        }
        else {
            url = "";
        }
    }
    return run;
};
const isSyncRunning = (accountId) => running.has(accountId);
exports.isSyncRunning = isSyncRunning;
/**
 * Synchronisiert EIN Postfach; niemals parallel für dasselbe Konto. Fehler
 * landen im Konto (`lastError`) und im Rückgabewert — sie werfen nicht.
 */
const syncAccount = async (accountId) => {
    const startedAt = Date.now();
    const summary = { accountId, inserted: 0, merged: 0, updated: 0, matched: 0, skipped: 0, pages: 0, durationMs: 0 };
    if (running.has(accountId)) {
        summary.error = "Synchronisation läuft bereits.";
        return summary;
    }
    running.add(accountId);
    try {
        const account = await prisma_client_1.default.mailAccount.findUnique({ where: { id: accountId } });
        if (!account) {
            summary.error = "Konto nicht gefunden.";
            return summary;
        }
        if (account.status !== "ACTIVE") {
            summary.error = `Konto ist ${account.status}.`;
            return summary;
        }
        await prisma_client_1.default.mailAccount.update({ where: { id: accountId }, data: { lastSyncStartedAt: new Date() } });
        for (const folder of FOLDERS) {
            const fresh = await prisma_client_1.default.mailAccount.findUnique({
                where: { id: accountId },
                select: { id: true, tenantId: true, employeeId: true, mailboxAddress: true, syncFromDate: true, inboxDeltaLink: true, sentDeltaLink: true },
            });
            if (!fresh)
                break;
            const run = await syncFolder(fresh, folder);
            summary.inserted += run.inserted;
            summary.merged += run.merged;
            summary.updated += run.updated;
            summary.matched += run.matched;
            summary.skipped += run.skipped;
            summary.pages += run.pages;
        }
        summary.durationMs = Date.now() - startedAt;
        const text = `+${summary.inserted} neu, ${summary.matched} zugeordnet, ${summary.merged} zusammengeführt (${Math.round(summary.durationMs / 100) / 10}s)`;
        await prisma_client_1.default.mailAccount.update({
            where: { id: accountId },
            data: { lastSyncAt: new Date(), lastSyncSummary: text.slice(0, 255), lastError: null },
        });
        console.log(`[MAIL-SYNC] ${account.mailboxAddress}: ${text}`);
    }
    catch (error) {
        summary.durationMs = Date.now() - startedAt;
        summary.error = error?.message || String(error);
        const needsReauth = (error instanceof msGraphAuth_1.MsAuthError && error.needsReauth)
            || (error instanceof msGraphClient_1.GraphRequestError && (error.status === 401 || error.status === 403));
        console.error(`[MAIL-SYNC] ${accountId} fehlgeschlagen:`, summary.error);
        await prisma_client_1.default.mailAccount.update({
            where: { id: accountId },
            data: {
                lastError: String(summary.error).slice(0, 1000),
                ...(needsReauth ? { status: "NEEDS_REAUTH" } : {}),
            },
        }).catch(() => undefined);
    }
    finally {
        running.delete(accountId);
    }
    return summary;
};
exports.syncAccount = syncAccount;
/** Hintergrundlauf: fällige Konten der Reihe nach (nicht parallel — Graph-Drossel). */
const runPass = async () => {
    const due = await prisma_client_1.default.mailAccount.findMany({
        where: {
            status: "ACTIVE",
            syncEnabled: true,
            OR: [{ lastSyncStartedAt: null }, { lastSyncStartedAt: { lt: new Date(Date.now() - MIN_GAP_MS) } }],
        },
        select: { id: true },
        orderBy: { lastSyncAt: "asc" },
        take: 50,
    });
    for (const { id } of due) {
        if (running.has(id))
            continue;
        await (0, exports.syncAccount)(id);
    }
};
let started = false;
const startMailSyncEngine = () => {
    if (started || process.env.OFFITEC_DISABLE_MAIL_SYNC === "true")
        return;
    started = true;
    const tick = () => {
        void runPass().catch((error) => console.error("[MAIL-SYNC] pass failed:", error?.message || error));
    };
    // Erster Lauf leicht verzögert: der Prozess soll erst den DB-Pool aufwärmen.
    setTimeout(tick, 20_000);
    setInterval(tick, TICK_MS);
};
exports.startMailSyncEngine = startMailSyncEngine;
//# sourceMappingURL=MailSyncEngine.js.map