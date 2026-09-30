"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTaskMailText = exports.buildTaskMailHtml = exports.TASK_MAIL_RED = exports.TASK_MAIL_BLUE = void 0;
const mailCardKit_1 = require("../mailCardKit");
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
exports.TASK_MAIL_BLUE = "#0a7aff";
exports.TASK_MAIL_RED = "#ff3b30";
const TZ = "Europe/Zurich";
/** Ein Teil des Datums auf Türkisch (die Sprache des Moduls), in der Zeitzone des Hauses. */
const part = (date, options) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, ...options }).format(date);
const buildTaskMailHtml = (card) => {
    const rows = card.rows
        .filter((row) => row.value.trim())
        .map((row) => ({ label: row.label, value: row.value }));
    const blocks = [
        (0, mailCardKit_1.cardHeader)(card.brand, "Görevler"),
        (0, mailCardKit_1.cardWave)(),
        (0, mailCardKit_1.cardHero)({
            icon: "TASK",
            accent: card.accent,
            kicker: card.kicker,
            title: card.heading,
            badge: card.badge ? { text: `! ${card.badge}`, tone: "red" } : null,
        }),
    ];
    if (card.date) {
        blocks.push((0, mailCardKit_1.cardTicket)({
            accent: card.accent,
            month: part(card.date.at, { month: "short" }).replace(/\.$/, "").toLocaleUpperCase("tr-TR"),
            day: part(card.date.at, { day: "numeric" }),
            label: card.date.label,
            date: card.date.text,
        }));
    }
    blocks.push((0, mailCardKit_1.cardGreeting)(card.greeting, (0, mailCardKit_1.mailEscape)(card.lead)));
    if (card.quote?.trim())
        blocks.push((0, mailCardKit_1.cardNote)((0, mailCardKit_1.mailNl2br)(card.quote.trim()), "navy", 18));
    blocks.push((0, mailCardKit_1.cardTable)(rows, { title: "Bilgiler" }));
    if (card.button)
        blocks.push((0, mailCardKit_1.cardButton)(card.button.label, card.button.href, card.accent));
    blocks.push((0, mailCardKit_1.cardEnd)());
    return (0, mailCardKit_1.cardPage)({
        lang: "tr",
        title: card.heading,
        preheader: `${card.kicker} · ${card.heading}`,
        rows: blocks,
        below: [card.footer],
    });
};
exports.buildTaskMailHtml = buildTaskMailHtml;
const buildTaskMailText = (card) => {
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
exports.buildTaskMailText = buildTaskMailText;
//# sourceMappingURL=taskMailCard.js.map