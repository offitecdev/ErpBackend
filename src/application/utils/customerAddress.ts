// Compose a customer's structured primary address (street / postal + city /
// country) into the multi-line string used across quotes and reports. Mirrors
// the frontend `formatLocationAddress` so a tender defaulted from the customer's
// main address matches the format of addresses picked from saved locations.
// The address name is a label and is intentionally excluded, like location names.
export interface CustomerAddressParts {
    address?: string | null;
    postalCode?: string | null;
    city?: string | null;
    country?: string | null;
}

export const formatCustomerAddress = (parts: CustomerAddressParts | null | undefined): string | null => {
    if (!parts) return null;
    const clean = (value?: string | null) => String(value ?? '').trim();
    const cityLine = [parts.postalCode, parts.city].map(clean).filter(Boolean).join(' ');
    const formatted = [clean(parts.address), cityLine, clean(parts.country)]
        .filter(Boolean)
        .join('\n');
    return formatted || null;
};
