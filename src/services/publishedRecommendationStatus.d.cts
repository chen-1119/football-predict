import type { Decision, SelectionQuality } from './recommendationCenterView';
export function selectionPriceStatus(quality:SelectionQuality|null|undefined):'unsupported'|'model-supported'|'unknown';
export function selectionReferenceLabel(quality:SelectionQuality|null|undefined,language:'zh'|'en'):string;
export function publicationLifecycle(decision:Pick<Decision,'cutoffTime'|'kickoffTime'|'quoteObservedAt'>,now:number):'open'|'quote-stale'|'review-only';
export function publicationLifecycleLabel(status:ReturnType<typeof publicationLifecycle>,language:'zh'|'en'):string;
