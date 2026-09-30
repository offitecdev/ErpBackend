import {
    cardButton,
    cardEnd,
    cardGreeting,
    cardHeader,
    cardHero,
    cardNote,
    cardPage,
    cardTable,
    cardTicket,
    cardWave,
    mailEscape,
    mailNl2br,
} from "../mailCardKit";

/**
 * ── DIE MAILKARTE DES GÖREVLER-MODULS (16.09.2026, Vorgabe Samet) ───────────
 *
 *   «maile giden kartların tasarımı daha sade … temiz apple modern mail
 *    mesajları gibi … swift ui mac os apple tarzı kart tasarımı»
 *   2. Runde: «daha güzel ve estetik … border radius … daha profesyonel»
 *
 * EINE Karte für «Yeni görev» UND «Soru/Sorun». Seit 30.09.2026 dieselbe
 * Karte wie die Terminmail (mailCardKit.ts, Vorgabe Samet mit dem Bild der
 * Augustkarte: «tablolar renkli, sütunları ayrı renk, dalga aynı kalsın,
 * premium»): Kopf, Welle, der Haken in der Akzentfarbe, Stichwort und Titel,
 * die Fälligkeit als Ticket, die Beschreibung als Kasten, die Angaben als
 * farbige Tabelle, ein Knopf. Blau teilt zu bzw. fragt, Rot meldet ein
 * Problem.
 */

export const TASK_MAIL_BLUE = "#0a7aff";
export const TASK_MAIL_RED = "#ff3b30";

export interface TaskMailRow {
    label: string;
    value: string;
}

export interface TaskMailCardInput {
    /** Der Absendername im Kopf der Karte. */
    brand: string;
    /** Kurzes Stichwort über dem Titel («Yeni görev», «Soru»). */
    kicker: string;
    accent: string;
    /** Rote Kapsel unter dem Titel, z. B. «Önemli». */
    badge?: string | null;
    heading: string;
    /** Das Ticket mit dem Kalenderblatt, z. B. die Fälligkeit. */
    date?: { at: Date; label: string; text: string } | null;
    greeting: string;
    lead: string;
    /** Der ruhige Kasten: Beschreibung bzw. die Frage selbst. */
    quote?: string | null;
    rows: readonly TaskMailRow[];
    button?: { label: string; href: string } | null;
    footer: string;
}

const TZ = "Europe/Zurich";

/** Ein Teil des Datums auf Türkisch (die Sprache des Moduls), in der Zeitzone des Hauses. */
const part = (date: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, ...options }).format(date);

export const buildTaskMailHtml = (card: TaskMailCardInput): string => {
    const rows = card.rows
        .filter((row) => row.value.trim())
        .map((row) => ({ label: row.label, value: row.value }));
    const blocks: string[] = [
        cardHeader(card.brand, "Görevler"),
        cardWave(),
        cardHero({
            icon: "TASK",
            accent: card.accent,
            kicker: card.kicker,
            title: card.heading,
            badge: card.badge ? { text: `! ${card.badge}`, tone: "red" } : null,
        }),
    ];
    if (card.date) {
        blocks.push(cardTicket({
            accent: card.accent,
            month: part(card.date.at, { month: "short" }).replace(/\.$/, "").toLocaleUpperCase("tr-TR"),
            day: part(card.date.at, { day: "numeric" }),
            label: card.date.label,
            date: card.date.text,
        }));
    }
    blocks.push(cardGreeting(card.greeting, mailEscape(card.lead)));
    if (card.quote?.trim()) blocks.push(cardNote(mailNl2br(card.quote.trim()), "navy", 18));
    blocks.push(cardTable(rows, { title: "Bilgiler" }));
    if (card.button) blocks.push(cardButton(card.button.label, card.button.href, card.accent));
    blocks.push(cardEnd());
    return cardPage({
        lang: "tr",
        title: card.heading,
        preheader: `${card.kicker} · ${card.heading}`,
        rows: blocks,
        below: [card.footer],
    });
};

export const buildTaskMailText = (card: TaskMailCardInput): string => {
    const lines = [
        `${card.badge ? `! ${card.badge} · ` : ""}${card.kicker}`,
        card.heading,
        "",
        card.greeting,
        card.lead,
        ...(card.quote?.trim() ? ["", card.quote.trim()] : []),
        "",
        ...(card.date ? [`${card.date.label}: ${card.date.text}`] : []),
        ...card.rows.filter((row) => row.value.trim()).map((row) => `${row.label}: ${row.value}`),
        ...(card.button ? ["", `${card.button.label}: ${card.button.href}`] : []),
        "",
        "—",
        card.brand,
        card.footer,
    ];
    return lines.join("\n");
};
