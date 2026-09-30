"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderSupplierPdf = exports.pdfCompanySettings = exports.supplierPdfAvailable = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const candidates = () => [
    process.env.OFFITEC_SUPPLIER_PDF_BUNDLE,
    path_1.default.resolve(process.cwd(), 'pdf-node/supplierPdf.cjs'),
    path_1.default.resolve(process.cwd(), '../ErpFront/offitec-frontend/dist-node/supplierPdf.cjs'),
].filter((file) => Boolean(file && file.trim()));
let loaded = null;
const rasterize = async (svg, pxW, pxH) => {
    const png = await (0, sharp_1.default)(Buffer.from(svg)).resize(pxW, pxH, { fit: 'fill' }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
};
const bundleFile = () => candidates().find((file) => {
    try {
        return fs_1.default.statSync(file).isFile();
    }
    catch {
        return false;
    }
}) ?? null;
const loadBundle = () => {
    const file = bundleFile();
    if (!file)
        throw new Error('Das PDF-Bündel der Lieferantenbelege fehlt (Frontend: npm run build).');
    const mtime = fs_1.default.statSync(file).mtimeMs;
    if (loaded && loaded.file === file && loaded.mtime === mtime)
        return loaded.bundle;
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundle = require(resolved);
    if (typeof bundle?.buildOrderPdfBytes !== 'function' || typeof bundle?.buildPriceRequestPdfBytes !== 'function') {
        throw new Error(`Das PDF-Bündel ${file} ist unvollständig.`);
    }
    bundle.setSvgRasterizer?.(rasterize);
    loaded = { file, mtime, bundle };
    console.log(`[supplier-pdf] Bündel geladen: ${file} (${bundle.SUPPLIER_PDF_BUNDLE ?? '?'})`);
    return bundle;
};
const supplierPdfAvailable = () => Boolean(bundleFile());
exports.supplierPdfAvailable = supplierPdfAvailable;
/* ── Die Firmenangaben des Briefkopfs ─────────────────────────────────────
   Im Browser liegen sie im Speicher der Seite (`pdfSettingsStore`: Vorgaben +
   Name und Adresse des gewählten Mandanten). Der Server nimmt dieselben
   Vorgaben und den Mandanten aus der Tabelle `Tenant` — die Lieferanten-PDFs
   lesen davon nur Name, Adresse und Kontakt. */
const DEFAULT_SETTINGS = {
    companyName: 'Offitec GmbH',
    addressLine1: 'Ceres Tower - Hohenrainstrasse',
    addressLine2: '24',
    postalCode: '4133',
    city: 'Pratteln',
    country: 'CH',
    iban: 'CH57 8080 8003 3475 3125 5',
    bic: 'RAIFCH22XXX',
    bankName: '',
    phone: '+41 55 000 00 00',
    email: 'info@offitec.ch',
    website: 'www.offitec.ch',
    taxId: '',
    vatRate: 8.1,
    currency: 'CHF',
    paymentTerms: 'Zahlbar innert 30 Tagen netto.',
    footerNote: '',
    letterheadBackground: null,
    letterheadBackgroundPdf: null,
    useBundledLetterhead: true,
    logoBase64: null,
};
const pdfCompanySettings = async (tenantId) => {
    const tenant = await prisma_client_1.default.tenant.findUnique({
        where: { id: tenantId },
        select: { tenantName: true, addressLine1: true, addressLine2: true, postalCode: true, city: true, country: true },
    }).catch(() => null);
    const name = String(tenant?.tenantName ?? '').trim();
    const hasAddress = Boolean(tenant?.addressLine1 || tenant?.city);
    return {
        ...DEFAULT_SETTINGS,
        ...(name ? { companyName: name } : {}),
        ...(hasAddress ? {
            addressLine1: tenant?.addressLine1 ?? '',
            addressLine2: tenant?.addressLine2 ?? '',
            postalCode: tenant?.postalCode ?? '',
            city: tenant?.city ?? '',
            country: tenant?.country || DEFAULT_SETTINGS.country,
        } : {}),
    };
};
exports.pdfCompanySettings = pdfCompanySettings;
/**
 * Das PDF eines Belegs — `document` in der Form von GET
 * /inventory/purchase-orders/:id (Positionen, Spalten, Projekt, BOM-Herkunft).
 */
const renderSupplierPdf = async (kind, document, settings, lang) => {
    const bundle = loadBundle();
    const bytes = kind === 'REQUEST'
        ? await bundle.buildPriceRequestPdfBytes(document, settings, lang)
        : await bundle.buildOrderPdfBytes(document, settings, lang);
    return Buffer.from(bytes);
};
exports.renderSupplierPdf = renderSupplierPdf;
//# sourceMappingURL=supplierPdfRenderer.js.map