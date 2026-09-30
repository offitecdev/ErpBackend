"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readOfferFacts = exports.offerLanguageOf = void 0;
const gptExtract_1 = require("./gptExtract");
const documentText_1 = require("./documentText");
const bomTableAi_1 = require("./bomTableAi");
const MAX_CHARS = 18_000;
const SYSTEM_PROMPT = [
    'You read the header of a supplier document (a quotation / offer, or an order confirmation) for a purchasing department.',
    'Copy values exactly as printed; never invent anything; use "" when a value is not printed.',
    'offerNumber: the number of THIS document (Angebot-Nr., Offerte Nr., Quotation No., Teklif No., AB-Nr., Auftragsbestätigung Nr.) - never our request/order number.',
    'offerDate: the date of the document as yyyy-mm-dd.',
    'currency: 3-letter ISO code of the prices (CHF, EUR, USD, TRY ...).',
    'contactName: the person at the SUPPLIER who handles this offer (Sachbearbeiter, Ihr Ansprechpartner, Contact, İlgili kişi) - a person name, not a company.',
    'contactEmail: that person\'s e-mail address if printed, else the supplier\'s general sales e-mail if printed.',
    'language: the language the document is written in, as a 2-letter code (de, tr, en, fr, it ...).',
    'ourReference: OUR reference the document quotes (request or order number like PA-2026-00012, FT-2026-00012, PR-..., BE-..., SP-..., PO-...), else "".',
    'isQuotation: true for a quotation/offer, false for an order confirmation or invoice.',
].join(' ');
const TEXT = { type: 'string' };
const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        offerNumber: TEXT,
        offerDate: TEXT,
        currency: TEXT,
        contactName: TEXT,
        contactEmail: TEXT,
        language: TEXT,
        ourReference: TEXT,
        isQuotation: { type: 'boolean' },
    },
    required: ['offerNumber', 'offerDate', 'currency', 'contactName', 'contactEmail', 'language', 'ourReference', 'isQuotation'],
};
const line = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** «de», «Deutsch», «fr» … → die Sprache unserer Belege (de/tr/en); Französisch/Italienisch → de (Schweiz). */
const offerLanguageOf = (raw) => {
    const value = line(raw, 20).toLowerCase();
    if (!value)
        return null;
    if (value.startsWith('tr') || value.startsWith('türk') || value.startsWith('turk'))
        return 'tr';
    if (value.startsWith('en') || value.startsWith('eng'))
        return 'en';
    if (value.startsWith('de') || value.startsWith('ger') || value.startsWith('deu') || value.startsWith('fr') || value.startsWith('it'))
        return 'de';
    return null;
};
exports.offerLanguageOf = offerLanguageOf;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
const readOfferFacts = async (pdf, fileName) => {
    if (!(0, gptExtract_1.gptConfigured)() || !pdf.length)
        return null;
    const model = (0, bomTableAi_1.bomTableModel)();
    let content;
    try {
        const read = await (0, documentText_1.readDocumentText)({ data: pdf.toString('base64'), fileName, mimeType: 'application/pdf' });
        content = [{ type: 'text', text: read.text.slice(0, MAX_CHARS) }];
    }
    catch (error) {
        if (!(error instanceof documentText_1.DocumentReadError) || error.code !== 'PDF_NO_TEXT_LAYER')
            return null;
        // Ein Scan ohne Textlage: das Modell liest die Datei selbst.
        content = [
            { type: 'text', text: '(scanned PDF without a text layer - the file follows)' },
            { type: 'file', file: { filename: fileName || 'offer.pdf', file_data: `data:application/pdf;base64,${pdf.toString('base64')}` } },
        ];
    }
    const thinking = (0, gptExtract_1.isReasoningModel)(model);
    const response = await (0, gptExtract_1.callChatCompletion)({
        model,
        temperature: 0,
        max_tokens: thinking ? 6_000 : 600,
        ...(thinking ? { reasoning_effort: 'low' } : {}),
        response_format: { type: 'json_schema', json_schema: { name: 'offer_header', strict: true, schema: SCHEMA } },
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content },
        ],
    }, 'procurement-offer');
    const parsed = (response.parsed ?? {});
    const email = line(parsed.contactEmail, 191).replace(/^mailto:/i, '');
    const date = line(parsed.offerDate, 10);
    return {
        offerNumber: line(parsed.offerNumber, 120),
        offerDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
        currency: /^[A-Z]{3}$/.test(line(parsed.currency, 3).toUpperCase()) ? line(parsed.currency, 3).toUpperCase() : '',
        contactName: line(parsed.contactName, 120),
        contactEmail: EMAIL.test(email) ? email : '',
        language: (0, exports.offerLanguageOf)(parsed.language),
        ourReference: line(parsed.ourReference, 40),
        isQuotation: parsed.isQuotation !== false,
        model,
    };
};
exports.readOfferFacts = readOfferFacts;
//# sourceMappingURL=offerReadAi.js.map