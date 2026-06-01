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

}