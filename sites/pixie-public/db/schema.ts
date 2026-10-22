import {sqliteTable,text} from 'drizzle-orm/sqlite-core';
export const earlyAccess=sqliteTable('early_access',{email:text('email').primaryKey(),createdAt:text('created_at').notNull(),source:text('source').notNull()});
