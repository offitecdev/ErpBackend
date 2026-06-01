import { Project, ProjectPhase, ProjectExpense } from "../entities/Project";

export interface IProjectFilter {
    tenantId: string;
    status?: string;
    managerId?: string;
    search?: string;
}

export interface IProjectRepository {
    createProject(project: Partial<Project>): Promise<Project>;
    updateProject(id: string, data: Partial<Project>): Promise<Project>;
    findById(id: string): Promise<Project | null>;
    findByToken(bookingToken: string): Promise<Project | null>; 
    findAll(filter: IProjectFilter): Promise<Project[]>;
    updateActualCost(id: string, additionalCost: number): Promise<void>; 
    createPhase(phase: Partial<ProjectPhase>): Promise<ProjectPhase>;
    updatePhaseProgress(id: string, percentage: number): Promise<ProjectPhase>;
    getPhasesByProjectId(projectId: string): Promise<ProjectPhase[]>;
    addExpense(expense: Partial<ProjectExpense>): Promise<ProjectExpense>;
    getExpensesByProjectId(projectId: string): Promise<ProjectExpense[]>;
}