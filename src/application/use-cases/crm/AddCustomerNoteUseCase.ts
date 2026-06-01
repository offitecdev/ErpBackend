import { ICustomerNoteRepository } from "../../../domain/repositories/ICustomerNoteRepository";
import { CustomerNote } from "../../../domain/entities/CustomerNote";
import {ICustomerRepository} from "../../../domain/repositories/ICustomerRepository";

interface AddNoteDTO{
    customerId : string ;
    createdByEmployeeId : string ;
    noteText : string ;
    noteType : string ;
    isHighlight? : boolean ;
}


export class AddCustomerNoteUseCase {
constructor(
    private noteRepository : ICustomerNoteRepository,
    private customerRepository : ICustomerRepository
){}

async execute(data : AddNoteDTO) : Promise<CustomerNote> {
    const customer = await this.customerRepository.findById(data.customerId);
    if(!customer) throw new Error("Customer not found");

    const validTypes =  ["internal", "technical"];

    if (!validTypes.includes(data.noteType)) {
        data.noteType = "internal";
    }

    return await this.noteRepository.create({
    customerId : data.customerId,
    createdByEmployeeId : data.createdByEmployeeId,
    noteText : data.noteText,
    noteType : data.noteType,
    isHighlight : data.isHighlight ?? false
    
    });

    


}


}