// Storage is handled by Supabase directly from the frontend.
// The Express backend only serves as a proxy for matching engine operations.

export interface IStorage {}

export class DatabaseStorage implements IStorage {}

export const storage = new DatabaseStorage();
