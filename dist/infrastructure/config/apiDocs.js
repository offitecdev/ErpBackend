"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiDocsAccess = void 0;
const apiDocsAccess = (env, rawMode) => {
    const mode = (rawMode || '').trim().toLowerCase();
    if (env === 'production') {
        return { enabled: mode === 'on', requireLogin: true };
    }
    return { enabled: mode !== 'off', requireLogin: false };
};
exports.apiDocsAccess = apiDocsAccess;
//# sourceMappingURL=apiDocs.js.map