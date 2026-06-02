"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerNote = void 0;
class CustomerNote {
    id;
    customerId;
    createdByEmployeeId;
    noteText;
    noteType;
    isHighlight;
    firstName;
    lastName;
    phone;
    email;
    createdAt;
    constructor(id, customerId, createdByEmployeeId, noteText, noteType, isHighlight, firstName, lastName, phone, email, createdAt) {
        this.id = id;
        this.customerId = customerId;
        this.createdByEmployeeId = createdByEmployeeId;
        this.noteText = noteText;
        this.noteType = noteType;
        this.isHighlight = isHighlight;
        this.firstName = firstName;
        this.lastName = lastName;
        this.phone = phone;
        this.email = email;
        this.createdAt = createdAt;
    }
}
exports.CustomerNote = CustomerNote;
//# sourceMappingURL=CustomerNote.js.map