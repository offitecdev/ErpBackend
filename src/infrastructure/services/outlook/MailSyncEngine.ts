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
import { nanoid } from "nanoid";
import { Prisma } from "@prisma/client";
import prisma from "../../database/prisma.client";
import { GraphRequestError, graphFetch } from "./msGraphClient";
import { MsAuthError } from "./msGraphAuth";
import { getAddressBook, matchAddresses, normalizeAddress } from "./mailCustomerMatcher";
import { clampBody, htmlToText, previewOf } from "./mailText";

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
const MAX_PAGES_PER_FOLDER = 40;   // 2000 Nachrichten je Ordner und Lauf; Rest im nächsten Lauf
const SELECT = [
    "id", "subject", "from", "toRecipients", "ccRecipients", "receivedDateTime", "sentDateTime",
    "bodyPreview", "body", "hasAttachments", "internetMessageId", "conversationId", "webLink", "isRead", "isDraft",
].join(",");

type Party = { name: string | null; address: string };
type Folder = { key: "inbox" | "sentitems"; direction: "IN" | "OUT"; linkField: "inboxDeltaLink" | "sentDeltaLink" };
const FOLDERS: Folder[] = [
    { key: "inbox", direction: "IN", linkField: "inboxDeltaLink" },
    { key: "sentitems", direction: "OUT", linkField: "sentDeltaLink" },
];

export interface SyncSummary {
    accountId: string;
    inserted: number;
    merged: number;
    updated: number;
    matched: number;
    skipped: number;
    pages: number;
    error?: string;
    durationMs: number;
}

const running = new Set<string>();

const partyOf = (raw: any): Party | null => {
    const address = normalizeAddress(raw?.emailAddress?.address);
    if (!address) return null;
    return { name: String(raw?.emailAddress?.name || "").trim() || null, address };
};
const partiesOf = (raw: any): Party[] => (Array.isArray(raw) ? raw.map(partyOf).filter((p): p is Party => Boolean(p)) : []);

const messageDate = (m: any, direction: "IN" | "OUT"): Date => {
    const value = direction === "OUT" ? (m.sentDateTime || m.receivedDateTime) : (m.receivedDateTime || m.sentDateTime);
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? new Date() : date;
};

const bodyTextOf = (m: any): string | null => {
    const content = String(m?.body?.content || "");
    if (!content) return null;
    const type = String(m?.body?.contentType || "").toLowerCase();
    return clampBody(type === "html" ? htmlToText(content) : content.replace(/\r\n/g, "\n").trim());
};

const initialDeltaUrl = (folder: Folder, syncFrom: Date | null): string => {
    const params = new URLSearchParams({ $select: SELECT });
    if (syncFrom) params.set("$filter", `receivedDateTime ge ${syncFrom.toISOString()}`);
    return `/me/mailFolders/${folder.key}/messages/delta?${params.toString()}`;
};

interface FolderRun { inserted: number; merged: number; updated: number; matched: number; skipped: number; pages: number; }

type AccountRow = {
    id: string;
    tenantId: string;
    employeeId: string;
    mailboxAddress: string;
    syncFromDate: Date | null;
    inboxDeltaLink: string | null;
    sentDeltaLink: string | null;
};

const syncFolder = async (account: AccountRow, folder: Folder): Promise<FolderRun> => {
    const run: FolderRun = { inserted: 0, merged: 0, updated: 0, matched: 0, skipped: 0, pages: 0 };
    const own = normalizeAddress(account.mailboxAddress);
    let url: string = account[folder.linkField] || initialDeltaUrl(folder, account.syncFromDate);
    let usedFilter = !account[folder.linkField] && Boolean(account.syncFromDate);
    const book = await getAddressBook(account.tenantId);

    while (url && run.pages < MAX_PAGES_PER_FOLDER) {
        let page: any;
        try {
            page = await graphFetch(account.id, url, {
                headers: { Prefer: `outlook.body-content-type="text", odata.maxpagesize=${PAGE_SIZE}` },
                timeoutMs: 45_000,
            });
        } catch (error: any) {
            // Manche Mandanten lehnen $filter auf Delta ab → ohne Filter neu
            // beginnen und das Fenster clientseitig anwenden.
            if (usedFilter && error instanceof GraphRequestError && error.status === 400) {
                usedFilter = false;
                url = initialDeltaUrl(folder, null);
                continue;
            }
            throw error;
        }
        run.pages += 1;
        const rows: any[] = Array.isArray(page?.value) ? page.value : [];
        const candidates: any[] = [];
        for (const m of rows) {
            if (!m || m["@removed"] || !m.id) { run.skipped += 1; continue; }
            if (m.isDraft) { run.skipped += 1; continue; }
            const at = messageDate(m, folder.direction);
            if (account.syncFromDate && at.getTime() < account.syncFromDate.getTime()) { run.skipped += 1; continue; }
            candidates.push(m);
        }

        if (candidates.length) {
            const providerIds = candidates.map((m) => String(m.id));
            const internetIds = candidates.map((m) => String(m.internetMessageId || "")).filter(Boolean);
            const [existingByProvider, existingByInternet] = await Promise.all([
                prisma.mailMessage.findMany({
                    where: { accountId: account.id, providerMessageId: { in: providerIds } },
                    select: { id: true, providerMessageId: true, isRead: true, subject: true },
                }),
                internetIds.length
                    ? prisma.mailMessage.findMany({
                        where: { tenantId: account.tenantId, internetMessageId: { in: internetIds }, providerMessageId: null },
                        select: { id: true, internetMessageId: true, direction: true },
                    })
                    : Promise.resolve([] as Array<{ id: string; internetMessageId: string | null; direction: string }>),
            ]);
            const byProvider = new Map(existingByProvider.map((row) => [row.providerMessageId!, row]));
            const byInternet = new Map(existingByInternet.map((row) => [row.internetMessageId!, row]));

            const inserts: Prisma.MailMessageCreateManyInput[] = [];
            const updates: Array<Promise<unknown>> = [];
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
                        updates.push(prisma.mailMessage.update({
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
                    updates.push(prisma.mailMessage.update({
                        where: { id: erpRow.id },
                        data: {
                            accountId: account.id,
                            providerMessageId: providerId,
                            conversationId: String(m.conversationId || "").slice(0, 255) || null,
                            ...(m.webLink ? { webLink: String(m.webLink) } : {}),
                        },
                    }).catch(() => undefined));
                    byInternet.delete(internetId!);
                    run.merged += 1;
                    continue;
                }

                // Gegenstellen für die Kundenzuordnung: IN → Absender (und, falls
                // der Absender das eigene Postfach ist, die Empfänger); OUT →
                // Empfänger + CC ohne das eigene Postfach.
                const counterparts = folder.direction === "IN"
                    ? (from && from.address !== own ? [from.address] : to.map((p) => p.address))
                    : [...to, ...cc].map((p) => p.address).filter((address) => address !== own);
                const hit = matchAddresses(book, counterparts);
                if (hit) run.matched += 1;

                const bodyText = bodyTextOf(m);
                inserts.push({
                    id: nanoid(12),
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
                    toRecipients: to as unknown as Prisma.InputJsonValue,
                    ccRecipients: cc.length ? (cc as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
                    bodyPreview: previewOf(String(m.bodyPreview || "") || bodyText, 500),
                    bodyText,
                    sentAt: messageDate(m, folder.direction),
                    hasAttachments: Boolean(m.hasAttachments),
                    webLink: m.webLink ? String(m.webLink) : null,
                    isRead,
                    customerId: hit?.customerId || null,
                    contactId: hit?.contactId || null,
                    matchSource: hit?.source || null,
                });
                // Dieselbe providerId ein zweites Mal auf der Seite (bei Delta praktisch
                // ausgeschlossen) nicht doppelt einfügen.
                byProvider.set(providerId, { id: "", providerMessageId: providerId, isRead, subject: null });
            }
            if (inserts.length) {
                await prisma.mailMessage.createMany({ data: inserts, skipDuplicates: true });
                run.inserted += inserts.length;
            }
            if (updates.length) await Promise.all(updates);
        }

        const next = page?.["@odata.nextLink"];
        const delta = page?.["@odata.deltaLink"];
        if (delta) {
            await prisma.mailAccount.update({ where: { id: account.id }, data: { [folder.linkField]: String(delta) } });
            url = "";
        } else if (next) {
            url = String(next);
            // Zwischenstand sichern: bricht der Lauf ab, geht es hier weiter.
            await prisma.mailAccount.update({ where: { id: account.id }, data: { [folder.linkField]: url } });
        } else {
            url = "";
        }
    }
    return run;
};

export const isSyncRunning = (accountId: string) => running.has(accountId);

/**
 * Synchronisiert EIN Postfach; niemals parallel für dasselbe Konto. Fehler
 * landen im Konto (`lastError`) und im Rückgabewert — sie werfen nicht.
 */
export const syncAccount = async (accountId: string): Promise<SyncSummary> => {
    const startedAt = Date.now();
    const summary: SyncSummary = { accountId, inserted: 0, merged: 0, updated: 0, matched: 0, skipped: 0, pages: 0, durationMs: 0 };
    if (running.has(accountId)) {
        summary.error = "Synchronisation läuft bereits.";
        return summary;
    }
    running.add(accountId);
    try {
        const account = await prisma.mailAccount.findUnique({ where: { id: accountId } });
        if (!account) { summary.error = "Konto nicht gefunden."; return summary; }
        if (account.status !== "ACTIVE") { summary.error = `Konto ist ${account.status}.`; return summary; }
        await prisma.mailAccount.update({ where: { id: accountId }, data: { lastSyncStartedAt: new Date() } });
        for (const folder of FOLDERS) {
            const fresh = await prisma.mailAccount.findUnique({
                where: { id: accountId },
                select: { id: true, tenantId: true, employeeId: true, mailboxAddress: true, syncFromDate: true, inboxDeltaLink: true, sentDeltaLink: true },
            });
            if (!fresh) break;
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
        await prisma.mailAccount.update({
            where: { id: accountId },
            data: { lastSyncAt: new Date(), lastSyncSummary: text.slice(0, 255), lastError: null },
        });
        console.log(`[MAIL-SYNC] ${account.mailboxAddress}: ${text}`);
    } catch (error: any) {
        summary.durationMs = Date.now() - startedAt;
        summary.error = error?.message || String(error);
        const needsReauth = (error instanceof MsAuthError && error.needsReauth)
            || (error instanceof GraphRequestError && (error.status === 401 || error.status === 403));
        console.error(`[MAIL-SYNC] ${accountId} fehlgeschlagen:`, summary.error);
        await prisma.mailAccount.update({
            where: { id: accountId },
            data: {
                lastError: String(summary.error).slice(0, 1000),
                ...(needsReauth ? { status: "NEEDS_REAUTH" } : {}),
            },
        }).catch(() => undefined);
    } finally {
        running.delete(accountId);
    }
    return summary;
};

/** Hintergrundlauf: fällige Konten der Reihe nach (nicht parallel — Graph-Drossel). */
const runPass = async (): Promise<void> => {
    const due = await prisma.mailAccount.findMany({
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
        if (running.has(id)) continue;
        await syncAccount(id);
    }
};

let started = false;
export const startMailSyncEngine = (): void => {
    if (started || process.env.OFFITEC_DISABLE_MAIL_SYNC === "true") return;
    started = true;
    const tick = () => {
        void runPass().catch((error) => console.error("[MAIL-SYNC] pass failed:", error?.message || error));
    };
    // Erster Lauf leicht verzögert: der Prozess soll erst den DB-Pool aufwärmen.
    setTimeout(tick, 20_000);
    setInterval(tick, TICK_MS);
};
