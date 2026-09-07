import {hasActiveRun} from './state/active.js';
import {loadConfig, updateConfig} from './config.js';
import type {Harness, IterisConfig} from './types.js';
import {listModels, validateSelection} from './harness/models.js';
import {ensureHarness, findExecutable, ReadinessError} from './harness/readiness.js';
import {setHarness, setModel, setEffort, selectionLabel} from './harness/settings.js';
import {choose, type ChoiceOption} from './ui/Choice.js';
export type Picker = (title: string, options: ChoiceOption[], initial?: string) => Promise<string>;
const harnessOptions = [{value: 'claude', label: 'Claude Code'}, {value: 'codex', label: 'Codex'}];
export async function prepareHarness(config: IterisConfig, picker: Picker = choose, cwd = process.cwd(), selection = true): Promise<IterisConfig> {
	let skipUpdate = false;
	for (;;) {
		try {
			await ensureHarness(config.harness, {skipUpdate});
			if (!selection) return config;
			const models = await listModels(config.harness);
			if (!config.harnesses[config.harness].model || !models.some(model => model.id === config.harnesses[config.harness].model)) {
				const id = await picker('Which model?', models.map(model => ({value: model.id, label: model.label})), models.find(model => model.isDefault)?.id);
				config = await setModel(id, cwd);
			}
			await validateSelection(config);
			return config;
		} catch (error) {
			const choice = await picker(error instanceof Error ? error.message : String(error), [
				{value: 'retry', label: 'Retry (reload saved configuration)'},
				{value: 'switch', label: 'Choose another harness'},
				...(error instanceof ReadinessError && error.canContinue ? [{value: 'continue', label: 'Continue with compatible installed version'}] : []),
			]);
			if (choice === 'switch') {
				const harness = await picker('Which harness?', harnessOptions, config.harness) as Harness;
				config = await updateConfig(current => {current.harness = harness;}, cwd);
				skipUpdate = false;
			} else {skipUpdate = choice === 'continue'; config = await loadConfig(cwd);}
		}
	}
}
export async function configure(command: string, argument?: string, options: {picker?: Picker; cwd?: string; active?: boolean} = {}): Promise<IterisConfig> {
	const picker = options.picker ?? choose;
	const cwd = options.cwd ?? process.cwd();
	const active = options.active || await hasActiveRun(cwd);
	let config = await loadConfig(cwd);
	if (command === 'harness') {
		const harness = argument ?? await picker('Which harness?', harnessOptions, config.harness);
		if (harness !== 'claude' && harness !== 'codex') throw new Error('Harness must be claude or codex.');
		if (active && !await findExecutable(harness)) {
			return updateConfig(current => {current.harness = harness;}, cwd);
		}
		// During execution only discovery is allowed. Installation, login and
		// update checks are deferred to prepareHarness at the ticket boundary.
		if (!active) {
			config = await updateConfig(current => {current.harness = harness;}, cwd);
			config = await prepareHarness(config, picker, cwd, false);
		}
		const target = active ? harness : config.harness;
		try {return await setHarness(target, cwd);} catch (error) {
			if (active) {
				// Authentication/discovery may need an interactive terminal. Defer
				// that work until the current ticket is completely finished.
				return updateConfig(current => {current.harness = target;}, cwd);
			}
			const action = await picker(String(error), [{value: 'model', label: 'Choose a model'}, {value: 'switch', label: 'Choose another harness'}]);
			return configure(action === 'model' ? 'model' : 'harness', undefined, options);
		}
	}
	if (command !== 'model' && command !== 'effort') throw new Error(`Unknown command: ${command}`);
	if (!active) config = await prepareHarness(config, picker, cwd, false);
	let models;
	try {models = await listModels(config.harness);} catch (error) {
		const action = await picker(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`, [{value: 'retry', label: 'Retry'}, {value: 'switch', label: 'Choose another harness'}]);
		if (action === 'switch') await configure('harness', undefined, options);
		return configure(command, argument, options);
	}
	if (command === 'model') {
		const id = argument ?? await picker('Which model?', models.map(model => ({value: model.id, label: model.label})), config.harnesses[config.harness].model);
		return setModel(id, cwd);
	}
	const model = models.find(entry => entry.id === config.harnesses[config.harness].model);
	if (!model) throw new Error('Select a model first.');
	if (!model.efforts.length) {
		if (argument) throw new Error('This model does not support configurable effort.');
		await picker('Effort: Not supported', [{value: 'ok', label: 'Continue'}]);
		return config;
	}
	const effort = argument ?? await picker('Which effort level?', model.efforts.map(level => ({value: level, label: level})), config.harnesses[config.harness].effort);
	return setEffort(effort, cwd);
}
export async function setupHarness(cwd = process.cwd(), picker: Picker = choose): Promise<IterisConfig> {
	let config = await loadConfig(cwd);
	const harness = await picker('Which harness?', harnessOptions, config.harness) as Harness;
	config = await updateConfig(current => {current.harness = harness; current.setupComplete = false;}, cwd);
	config = await prepareHarness(config, picker, cwd, false);
	config = await configure('model', undefined, {cwd, picker});
	config = await configure('effort', undefined, {cwd, picker});
	console.log(selectionLabel(config));
	return config;
}
