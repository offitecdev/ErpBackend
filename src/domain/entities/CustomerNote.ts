export class CustomerNote{
    constructor(
     public id : string ,
     public customerId : string ,
     public createdByEmployeeId : string ,
     public noteText : string ,
     public noteType : string ,
     public isHighlight : boolean ,
     public firstName : string ,
     public lastName : string ,
     public phone? : string | null ,
     public email? : string | null ,
     public createdAt? : Date ,
    ) { }
}