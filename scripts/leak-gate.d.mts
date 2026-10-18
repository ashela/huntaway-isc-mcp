export interface GateRule { name: string; rx: RegExp; allow?: (m: RegExpExecArray) => boolean }
export interface GateFinding { file: string; line: number; rule: string; match: string; context: string }
export const BUILTIN_RULES: GateRule[];
export function loadTerms(file?: string): GateRule[] | null;
export function scanText(text: string, rules: GateRule[], file?: string): GateFinding[];
export function scanPaths(paths: string[], rules: GateRule[]): GateFinding[];
