import { hash, type FailureKind } from './state.js';
import { CapabilityUnavailable } from './environment.js';
export function classifyFailure(error: unknown, phase: string): {
    kind: FailureKind;
    signature: string;
    nextAction: string;
} {
    const text = error instanceof Error ? error.message : String(error);
    let kind: FailureKind = 'code', nextAction = 'Repair the failing project invariant and rerun checks and independent review';
    // Only the user can correct configuration: wait and re-read it instead of spending instances on repair.
    if (/Trusted review context is too large/i.test(text)) {
        kind = 'capability';
        nextAction = 'Raise verification.maxContextCharacters in .iteris.json or trim the configured policy/context files; the next attempt re-reads the configuration';
    }
    else if (error instanceof CapabilityUnavailable || /missing executable|executable unavailable|spawn.*ENOENT|runtime.*incompatible|environment probe|setup failed/i.test(text)) {
        kind = 'environment';
        nextAction = 'Repair configured project-local prerequisites, then retry the probe';
    }
    else if (/Invalid review report|Schema recovery|wrong commit|Verifier .*|Invalid finding line/i.test(text)) {
        kind = 'review-protocol';
        nextAction = 'Correct the review protocol response without weakening evidence requirements';
    }
    else if (/ECONN|ENOTFOUND|fetch failed|temporar|rate.limit|provider offline|API.*(?:403|429|50\d)|transport|network/i.test(text)) {
        kind = 'transport';
        nextAction = 'Retry after provider or transport access recovers';
    }
    else if (/credential|hardware|device.*unavailable|permission.*unavailable|unavailable capability/i.test(text)) {
        kind = 'capability';
        nextAction = 'Supply the missing capability or a configured probe';
    }
    else if (/pending|observation|await.*evidence/i.test(text)) {
        kind = 'external';
        nextAction = 'Probe or submit the outstanding acceptance evidence';
    }
    else if (/failed check|test.*fail|CI.*fail|exit [1-9]/i.test(text)) {
        kind = 'test';
        nextAction = 'Repair the failed check and independently verify the new commit';
    }
    return { kind, signature: hash([kind, phase]), nextAction };
}
