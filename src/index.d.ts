export interface OptimizationOptions {
  model?: string;
  removeFiller?: boolean;
  removeCeremony?: boolean;
  compressPhrases?: boolean;
  removeRedundant?: boolean;
}

export interface OptimizationChange {
  type: string;
  original: string;
  replacement: string;
  confidence: number;
  explanation: string;
}

export interface SavingsEstimation {
  saved: number;
  percentage: number;
  costSaved: number;
  model: string;
}

export interface OptimizationResult {
  original: string;
  optimized: string;
  changes: OptimizationChange[];
  tokensBefore: number;
  tokensAfter: number;
  savings: SavingsEstimation;
  confidence: number;
}

export interface Suggestion {
  id: string;
  type: string;
  original: string;
  replacement: string;
  confidence: number;
  explanation: string;
  tokensSaved: number;
  startIndex: number;
  endIndex: number;
  severity: "high" | "medium" | "low";
}

export function optimizePrompt(text: string, options?: OptimizationOptions): OptimizationResult;
export function countTokens(text: string): number;
export function estimateSavings(originalTokens: number, optimizedTokens: number, model?: string): SavingsEstimation;
export function availableModels(): string[];
export function getSuggestions(text: string): Suggestion[];
export function applySuggestions(text: string, suggestions: Suggestion[], acceptedIds?: string[]): string;

export const PHRASE_REPLACEMENTS: Map<string, string>;
export const FILLER_WORDS: Set<string>;
export const REDUNDANT_MODIFIERS: Map<string, string>;
