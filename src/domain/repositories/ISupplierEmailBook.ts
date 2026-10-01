/**
 * ── DIE E-MAIL EINES LIEFERANTEN (30.09.2026, Vorgabe Samet) ───────────────
 *
 * «Eğer ürün listesinde ya da BOM'da burada şurada tedarikçi e-postası
 *  eklenirse direkt tedarikçi e-postası olarak kaydetmeli.» Wo auch immer
 * jemand die E-Mail eines Lieferanten einträgt — Depo-Karte, Schnellkarte der
 * BOM, Import, Preisanfrage —, sie wird die E-Mail des Lieferanten in der
 * Lieferantenliste (Supplier). Die nächste Anfrage an ihn kennt sie.
 */
export interface SupplierEmailEntry {
    supplierId: string | null;
    name: string | null;
    email: string | null | undefined;
}

export interface ISupplierEmailBook {
    /**
     * Schreibt die Adressen an die Lieferanten der Liste — per Kennung, sonst
     * per Name. Einen Lieferanten, den es in der Liste nicht gibt, legt sie
     * nicht an. Gibt zurück, wie viele sich geändert haben.
     */
    remember(tenantId: string, entries: SupplierEmailEntry[]): Promise<number>;
    /** Die Adresse eines Lieferanten in der Liste (null = keine). */
    emailOf(tenantId: string, supplier: { supplierId: string | null; name: string | null }): Promise<string | null>;
}
