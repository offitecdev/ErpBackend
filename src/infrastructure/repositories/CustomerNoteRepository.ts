import prisma from "../database/prisma.client";
import {ICustomerNoteRepository} from "../../domain/repositories/ICustomerNoteRepository";
import {CustomerNote} from "../../domain/entities/CustomerNote";
import { nanoid } from "nanoid";

export class CustomerNoteRepository implements ICustomerNoteRepository{
    private maptoEntity(data:any) : CustomerNote{
        return new CustomerNote(
            data.id,
            data.customerId,
            data.createdByEmployeeId,
            data.noteText,
            data.noteType,
            data.isHighlight,
            data.firstName || '',
            data.lastName || '',
            data.telephone,
            data.email,
            data.createdAt
        )
    }

 async create (note: Partial<CustomerNote>): Promise<CustomerNote> {
    const data = await prisma.customerNote.create({
        data : {
            id : note.id || nanoid(8),
            customerId : note.customerId!,
            createdByEmployeeId : note.createdByEmployeeId!,
            noteText : note.noteText!,
            noteType : note.noteType!,
            isHighlight : note.isHighlight ?? false,
            firstName: note.firstName || '',
            email: note.email || null,
            telephone: note.phone || null
        }
    })
    return this.maptoEntity(data);
 }

 async findByCustomerId(customerId:string) : Promise<CustomerNote[]>{
    const data = await prisma.customerNote.findMany({
        where : {customerId},
        orderBy : {createdAt : 'desc'}
    });
    return data.map(this.maptoEntity.bind(this))
 } 

 async getHighlightedNotes(customerId:string) : Promise<CustomerNote[]> {
          const data = await prisma.customerNote.findMany({
            where : {customerId,
                isHighlight : true
            } ,
            orderBy : {createdAt: 'desc'}
          })
        return data.map(this.maptoEntity.bind(this));
 }

 async findById(id: string): Promise<CustomerNote | null> {
    const data = await prisma.customerNote.findUnique({ where: { id } });
    return data ? this.maptoEntity(data) : null;
 }

 async update(id: string, note: Partial<CustomerNote>): Promise<CustomerNote> {
    const data: any = {};
    if (note.noteText !== undefined) data.noteText = note.noteText;
    if (note.noteType !== undefined) data.noteType = note.noteType;
    if (note.isHighlight !== undefined) data.isHighlight = note.isHighlight;
    const updated = await prisma.customerNote.update({ where: { id }, data });
    return this.maptoEntity(updated);
 }

 async delete(id: string): Promise<void> {
    await prisma.customerNote.delete({ where: { id } });
 }

}