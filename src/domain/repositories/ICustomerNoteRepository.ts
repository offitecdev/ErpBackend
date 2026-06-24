import {CustomerNote} from "../entities/CustomerNote";

export interface ICustomerNoteRepository{
    create(note: Partial<CustomerNote>): Promise<CustomerNote>;
    findById(id: string): Promise<CustomerNote | null>;
    findByCustomerId(customerId: string): Promise<CustomerNote[]>;
    getHighlightedNotes(customerId: string): Promise<CustomerNote[]>;
    update(id: string, note: Partial<CustomerNote>): Promise<CustomerNote>;
    delete(id: string): Promise<void>;

}