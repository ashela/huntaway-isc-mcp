// Workflow diagnostics that are easy to get wrong by hand: step count against
// the licence cap, per-http-step OAuth bind state, and reachability from the
// trigger. Pure functions over the workflow object.

import { asList, asRecord } from "./util.js";

export interface HttpStep {
  step: string;
  bound: boolean;
}

export interface WorkflowDiagnostics {
  id: string | undefined;
  name: unknown;
  enabled: boolean;
  modified: unknown;
  step_count: number;
  step_cap: number;
  over_cap: boolean;
  safe_to_disable: boolean;
  http_steps: HttpStep[];
  unbound_http_steps: string[];
  unreachable_steps: string[];
  trigger: unknown;
  WARNING?: string;
}

export function stepsOf(workflow: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const definition = asRecord(workflow.definition);
  const steps = asRecord(definition.steps);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, step] of Object.entries(steps)) out[name] = asRecord(step);
  return out;
}

export function httpSteps(steps: Record<string, Record<string, unknown>>): HttpStep[] {
  const out: HttpStep[] = [];
  for (const [name, step] of Object.entries(steps)) {
    if (step.actionId !== "sp:http") continue;
    const ref = asRecord(asRecord(step.attributes).param_oauth).refID;
    out.push({ step: name, bound: Boolean(ref) });
  }
  return out;
}

export function formSteps(steps: Record<string, Record<string, unknown>>): { step: string; formDefinitionId: unknown }[] {
  const out: { step: string; formDefinitionId: unknown }[] = [];
  for (const [name, step] of Object.entries(steps)) {
    if (step.actionId !== "sp:interactive-form") continue;
    out.push({ step: name, formDefinitionId: asRecord(step.attributes).formDefinitionId });
  }
  return out;
}

/** Steps reachable from the trigger by following nextStep, defaultStep and
 *  every choice; anything else is dead code the builder will still save. */
export function reachableSteps(workflow: Record<string, unknown>): Set<string> {
  const steps = stepsOf(workflow);
  const seen = new Set<string>();
  const stack: unknown[] = [asRecord(workflow.definition).start];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node !== "string" || !node || seen.has(node) || !(node in steps)) continue;
    seen.add(node);
    const step = steps[node];
    stack.push(step.nextStep, step.defaultStep);
    for (const choice of asList(step.choiceList)) stack.push(choice.nextStep);
  }
  return seen;
}

export function analyseWorkflow(workflow: Record<string, unknown>, stepCap: number): WorkflowDiagnostics {
  const steps = stepsOf(workflow);
  const http = httpSteps(steps);
  const reachable = reachableSteps(workflow);
  const enabled = Boolean(workflow.enabled);
  const count = Object.keys(steps).length;
  const result: WorkflowDiagnostics = {
    id: typeof workflow.id === "string" ? workflow.id : undefined,
    name: workflow.name,
    enabled,
    modified: workflow.modified,
    step_count: count,
    step_cap: stepCap,
    over_cap: count > stepCap,
    safe_to_disable: count <= stepCap,
    http_steps: http,
    unbound_http_steps: http.filter((h) => !h.bound).map((h) => h.step),
    unreachable_steps: Object.keys(steps).filter((s) => !reachable.has(s)).sort(),
    trigger: asRecord(workflow.trigger).type,
  };
  const warnings: string[] = [];
  if (enabled && count > stepCap) {
    warnings.push(
      `${count} steps exceeds the ${stepCap}-step cap. It is enabled only because it was grandfathered in. ` +
        "Disabling it is a ONE-WAY DOOR: it cannot be re-enabled. Do not patch it.",
    );
  }
  if (result.unbound_http_steps.length) {
    warnings.push(
      `Unbound http step(s): ${JSON.stringify(result.unbound_http_steps)}. These fail at runtime; OAuth must be bound by hand in the builder.`,
    );
  }
  if (warnings.length) result.WARNING = warnings.join(" ");
  return result;
}
