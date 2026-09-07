import {updateConfig} from '../config.js';
import type {Harness, IterisConfig} from '../types.js';
import {listModels, type ModelInfo} from './models.js';

function applyModel(config: IterisConfig, model: ModelInfo): void {
	const settings = config.harnesses[config.harness];
	settings.model = model.id;
	if (!settings.effort || !model.efforts.includes(settings.effort)) {
		if (model.defaultEffort && model.efforts.includes(model.defaultEffort)) settings.effort = model.defaultEffort;
		else if (model.efforts.length) throw new Error(`No supported default effort for ${model.id}`);
		else delete settings.effort;
	}
}
export async function setHarness(harness: Harness, cwd = process.cwd()): Promise<IterisConfig> {
	if (harness !== 'claude' && harness !== 'codex') throw new Error('Harness must be claude or codex.');
	const models = await listModels(harness);
	return updateConfig(config => {
		config.harness = harness;
		const saved = config.harnesses[harness].model;
		const model = saved ? models.find(entry => entry.id === saved) : models.find(entry => entry.isDefault) ?? models[0];
		if (!model) throw new Error(`Saved model ${saved ?? ''} is unavailable. Select a model for ${harness} in iteris setup.`);
		applyModel(config, model);
	}, cwd);
}
export async function setModel(id: string, cwd = process.cwd()): Promise<IterisConfig> {
	// Resolve the catalog, then verify that selection has not changed before
	// committing the serialized configuration transaction.
	const {loadConfig} = await import('../config.js');
	const current = await loadConfig(cwd);
	const models = await listModels(current.harness);
	const model = models.find(entry => entry.id === id);
	if (!model) throw new Error(`Model ${id} is unavailable for ${current.harness}.`);
	return updateConfig(config => {
		if (config.harness !== current.harness) throw new Error('Harness changed while selecting a model. Retry.');
		applyModel(config, model);
	}, cwd);
}
export async function setEffort(effort: string, cwd = process.cwd()): Promise<IterisConfig> {
	const {loadConfig} = await import('../config.js');
	const current = await loadConfig(cwd);
	const settings = current.harnesses[current.harness];
	const model = (await listModels(current.harness)).find(entry => entry.id === settings.model);
	if (!model || !model.efforts.includes(effort)) throw new Error(`Unsupported effort ${effort}. Supported: ${model?.efforts.join(', ') || 'none'}.`);
	return updateConfig(config => {
		if (config.harness !== current.harness || config.harnesses[config.harness].model !== settings.model) throw new Error('Model changed while selecting effort. Retry.');
		config.harnesses[config.harness].effort = effort;
	}, cwd);
}
export function selectionLabel(config: IterisConfig): string {
	const settings = config.harnesses[config.harness];
	return `${config.harness} · ${settings.model ?? 'model not selected'} · effort: ${settings.effort ?? 'Not supported'}`;
}
