"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatCustomerAddress = void 0;
const formatCustomerAddress = (parts) => {
    if (!parts)
        return null;
    const clean = (value) => String(value ?? '').trim();
    const cityLine = [parts.postalCode, parts.city].map(clean).filter(Boolean).join(' ');
    const formatted = [clean(parts.address), cityLine, clean(parts.country)]
        .filter(Boolean)
        .join('\n');
    return formatted || null;
};
exports.formatCustomerAddress = formatCustomerAddress;
//# sourceMappingURL=customerAddress.js.map