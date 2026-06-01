import {CustomerNote} from "../entities/CustomerNote";

export interface ICustomerNoteRepository{
    create(note: Partial<CustomerNote>): Promise<CustomerNote>;
    findByCustomerId(customerId: string): Promise<CustomerNote[]>;
    getHighlightedNotes(customerId: string): Promise<CustomerNote[]>;

}