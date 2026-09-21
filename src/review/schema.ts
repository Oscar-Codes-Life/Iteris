import {z} from 'zod';

export const reviewConfigSchema = z.object({
	mode: z.enum(['standard', 'deep']).default('standard'),
	maxRepairCycles: z.number().int().min(0).max(2).default(2),
	timeout: z.number().positive().optional(),
	allowNoChecks: z.boolean().default(false),
}).strict();
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
export const reviewSettings = (value?: Partial<ReviewConfig>) => reviewConfigSchema.parse(value ?? {});
const text = z.string().trim().min(1).max(12_000);
const requirement = z.object({requirement: text, status: z.enum(['covered', 'missing', 'unverified']), evidence: text}).strict();
export const candidateSchema = z.object({
	category: z.enum(['correctness', 'security', 'acceptance', 'maintainability', 'performance', 'policy']),
	priority: z.enum(['critical', 'high', 'medium', 'low']),
	file: text, line: z.number().int().positive(), side: z.enum(['new', 'old']),
	title: text, trigger: text, expected: text, actual: text, impact: text,
	evidence: text, remedy: text,
	materialRegression: z.boolean(), policyRule: z.string().max(12_000),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export type Finding = Candidate & {id: string; head: string; status: 'candidate' | 'confirmed' | 'rejected' | 'fixed'; verification?: string; fixedAt?: string; duplicateOf?: string};
export const passSchema = z.object({
	head: text, complete: z.boolean(), inspectedFiles: z.array(text), gaps: z.array(text),
	requirements: z.array(requirement), findings: z.array(candidateSchema).max(100),
}).strict();
export type ReviewPass = z.infer<typeof passSchema>;
export const verificationSchema = z.object({
	head: text, complete: z.boolean(), gaps: z.array(text), requirements: z.array(requirement).min(1),
	decisions: z.array(z.object({id: text, status: z.enum(['confirmed', 'rejected']), evidence: text, duplicateOf: z.string().optional()}).strict()),
	resolved: z.array(z.object({id: text, evidence: text}).strict()),
}).strict();
export type Verification = z.infer<typeof verificationSchema>;
export type CheckResult = {command: string; head: string; exitCode: number | null; output: string; durationMs: number; error?: string; truncated: boolean};
export type ReviewStamp = {head: string; base: string; mergeBase: string; branch: string; scope: string; key: string};
export type ReviewReport = {
	version: 1; outcome: 'passed' | 'blocked' | 'incomplete'; reason: string;
	stamp?: ReviewStamp; startedAt: string; finishedAt: string; rounds: number; repairs: number;
	findings: Finding[]; requirements: Verification['requirements']; checks: CheckResult[]; gaps: string[];
	mode: 'standard' | 'deep'; selection: {harness: string; model?: string; effort?: string};
	usage: 'unavailable';
};
export type ReviewResult = {report: ReviewReport; text: string; success: boolean; done: boolean; timedOut: boolean; error?: string};

export function blocks(finding: Finding): boolean {
	return finding.status === 'confirmed' && !finding.duplicateOf && (
		['critical', 'high'].includes(finding.priority) || finding.category === 'acceptance' ||
		(finding.category === 'maintainability' && finding.materialRegression) ||
		(finding.category === 'policy' && Boolean(finding.policyRule))
	);
}

export function parseReport<T>(raw: string, schema: z.ZodType<T>): T {
	const json = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
	try {return schema.parse(JSON.parse(json));} catch (error) {
		throw new Error(`Invalid review report: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export const recoverySchema = z.object({
	checks: z.array(z.string().trim().min(1).max(4000)).max(20),
	blockedReason: z.string().max(12_000),
}).strict();
