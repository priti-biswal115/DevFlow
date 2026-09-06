import * as vscode from 'vscode';
import { AdoService } from './AdoService';
import { Ticket } from '../types/ticket';

export class TicketService {
    private static instance: TicketService;
    private tickets: Ticket[] = [];

    private constructor() {}

    public static getInstance(): TicketService {
        if (!TicketService.instance) {
            TicketService.instance = new TicketService();
        }
        return TicketService.instance;
    }

    public async fetchAssignedTickets(context: vscode.ExtensionContext): Promise<Ticket[]> {
        this.tickets = await AdoService.getAssignedTickets(context);
        return this.tickets;
    }

    public getTicketById(id: number): Ticket | undefined {
        return this.tickets.find(t => t.id === id);
    }
}
