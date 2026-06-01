import  {Document} from "../entities/Document";

export interface IDocumentRepository{
    create(document : Partial<Document>) : Promise<Document>;
    findByEntity(entityType:string , entityId : string) : Promise<Document[]>;
    delete(id:string,employeeId : string) : Promise<void>;
}