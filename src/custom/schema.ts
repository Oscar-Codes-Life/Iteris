import {z} from 'zod';

export const httpUrl = z.string().url().refine(value => {
	const url = new URL(value);
	return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Expected an HTTP(S) URL without embedded credentials');
export const customConfigSchema = z.object({
	endpoint: httpUrl,
	apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('CUSTOM_API_KEY'),
	itemsPath: z.string().default(''),
	idPath: z.string().optional(),
}).passthrough();
export type CustomConfig = z.infer<typeof customConfigSchema>;
export const taskSchema = z.object({
	title: z.string().trim().min(1),
	description: z.string(),
	labels: z.array(z.string()).default([]),
	sourceUrl: httpUrl.optional(),
	analysis: z.string().default(''),
});
export const draftSchema = taskSchema.extend({
	attachments: z.array(z.object({path: z.array(z.union([z.string(), z.number().int().nonnegative()])), name: z.string().optional()})).default([]),
});
export const attachmentSchema = z.object({
	url: httpUrl.optional(), name: z.string(), file: z.string().optional(),
	kind: z.enum(['text', 'image']).optional(), warning: z.string().optional(),
});
export const importedTaskSchema = taskSchema.extend({
	identity: z.string(), fingerprint: z.string(), number: z.number().int().positive(),
	file: z.string(), attachments: z.array(attachmentSchema),
});
export const manifestSchema = z.object({version: z.literal(1), tasks: z.array(importedTaskSchema)});
export type Attachment = z.infer<typeof attachmentSchema>;
