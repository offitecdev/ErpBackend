import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

import prisma from '../database/prisma.client';

/**
 * ── LIEFERANTEN-PDF AUF DEM SERVER (30.09.2026, Vorgabe Samet) ─────────────
 *
 * «Fiyat talepleri artık otomatik gönderiliyor … sipariş gönder dediğimizde
 *  bunları hazırlayıp çıkartıyor ve maillerine atıyor.» Die Produktion
 * verschickt Preisanfragen, Bestellungen und ihre Revisionen selbst — mit
 * GENAU dem PDF der Seite «PDF». Dafür lädt der Server den Code des Browsers
 * als Bündel (Frontend `scripts/build-supplier-pdf-node.mjs`, von `npm run
 * build` erzeugt): kein zweites Layout, das auseinanderlaufen könnte.
 *
 * Gesucht wird das Bündel hier (das erste, das es gibt):
 *   1. OFFITEC_SUPPLIER_PDF_BUNDLE
 *   2. <cwd>/pdf-node/supplierPdf.cjs          (Docker: /app/backend/pdf-node)
 *   3. <cwd>/../ErpFront/offitec-frontend/dist-node/supplierPdf.cjs (Entwicklung)
 * Ein neu gebautes Bündel wird beim nächsten PDF gelesen (Änderungszeit).
 * Fehlt es, meldet `supplierPdfAvailable()` false — die Belege bleiben dann
 * für die Sendung von Hand (Seite «PDF» / «E-posta»).
 */

export type SupplierPdfLang = 'de' | 'tr' | 'en';

interface Bundle {
    buildOrderPdfBytes: (order: unknown, settings: unknown, lang: SupplierPdfLang) => Promise<Uint8Array>;
    buildPriceRequestPdfBytes: (order: unknown, settings: unknown, lang: SupplierPdfLang) => Promise<Uint8Array>;
    setSvgRasterizer: (rasterize: (svg: string, pxW: number, pxH: number) => Promise<string | null>) => void;
    SUPPLIER_PDF_BUNDLE?: string;
}

const candidates = (): string[] => [
    process.env.OFFITEC_SUPPLIER_PDF_BUNDLE,
    path.resolve(process.cwd(), 'pdf-node/supplierPdf.cjs'),
    path.resolve(process.cwd(), '../ErpFront/offitec-frontend/dist-node/supplierPdf.cjs'),
].filter((file): file is string => Boolean(file && file.trim()));

let loaded: { file: string; mtime: number; bundle: Bundle } | null = null;

const rasterize = async (svg: string, pxW: number, pxH: number): Promise<string | null> => {
    const png = await sharp(Buffer.from(svg)).resize(pxW, pxH, { fit: 'fill' }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
};

const bundleFile = (): string | null => candidates().find((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
}) ?? null;

const loadBundle = (): Bundle => {
    const file = bundleFile();
    if (!file) throw new Error('Das PDF-Bündel der Lieferantenbelege fehlt (Frontend: npm run build).');
    const mtime = fs.statSync(file).mtimeMs;
    if (loaded && loaded.file === file && loaded.mtime === mtime) return loaded.bundle;
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundle = require(resolved) as Bundle;
    if (typeof bundle?.buildOrderPdfBytes !== 'function' || typeof bundle?.buildPriceRequestPdfBytes !== 'function') {
        throw new Error(`Das PDF-Bündel ${file} ist unvollständig.`);
    }
    bundle.setSvgRasterizer?.(rasterize);
    loaded = { file, mtime, bundle };
    console.log(`[supplier-pdf] Bündel geladen: ${file} (${bundle.SUPPLIER_PDF_BUNDLE ?? '?'})`);
    return bundle;
};

export const supplierPdfAvailable = (): boolean => Boolean(bundleFile());

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

export const pdfCompanySettings = async (tenantId: string): Promise<Record<string, unknown>> => {
    const tenant = await prisma.tenant.findUnique({
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

/**
 * Das PDF eines Belegs — `document` in der Form von GET
 * /inventory/purchase-orders/:id (Positionen, Spalten, Projekt, BOM-Herkunft).
 */
export const renderSupplierPdf = async (
    kind: 'ORDER' | 'REQUEST',
    document: unknown,
    settings: Record<string, unknown>,
    lang: SupplierPdfLang,
): Promise<Buffer> => {
    const bundle = loadBundle();
    const bytes = kind === 'REQUEST'
        ? await bundle.buildPriceRequestPdfBytes(document, settings, lang)
        : await bundle.buildOrderPdfBytes(document, settings, lang);
    return Buffer.from(bytes);
};
