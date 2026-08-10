import { LANE_RANK } from "./lanes.ts";
import { RouterError, type ApprovalType, type Lane, type RouteInput, type RoutingRule, type RuleCondition, type RuleExpression, type RuleFacts, type RuleLayer, type Sensitivity } from "./types.ts";

const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
const IMPACT_RANK = { low: 0, medium: 1, high: 2 } as const;
const LAYER_RANK: Record<RuleLayer, number> = { explicit: 0, project: 1, workspace: 2, personal: 3, defaults: 4, "additional-workspace": 5 };
const SCALAR_FIELDS = new Set(["task_family", "deliverable_kind", "execution_mode", "urgency", "estimated_sessions", "downstream_impact", "reversibility", "effective_sensitivity"]);
const LIST_FIELDS = new Set(["declared_side_effects", "requested_capabilities", "scope_systems", "egress_destinations", "data_categories"]);
const NUMBER_FIELDS = new Set(["independent_system_count"]);

function orderedUnique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }

export function effectiveSensitivity(input: RouteInput): Sensitivity {
  return input.data_inputs.reduce<Sensitivity>((maximum, entry) => SENSITIVITY_RANK[entry.sensitivity] > SENSITIVITY_RANK[maximum] ? entry.sensitivity : maximum, "public");
}

export function deriveRuleFacts(input: RouteInput): RuleFacts {
  const maxImpact = input.uncertainties.reduce<"low" | "medium" | "high">((maximum, entry) => IMPACT_RANK[entry.impact] > IMPACT_RANK[maximum] ? entry.impact : maximum, "low");
  return {
    ...input,
    effective_sensitivity: effectiveSensitivity(input),
    data_categories: orderedUnique(input.data_inputs.map((entry) => entry.category)),
    uncertainty_max_impact: maxImpact,
    independent_system_count: new Set(input.scope_systems).size,
  };
}

function conditionValue(condition: RuleCondition, facts: RuleFacts): unknown {
  if (!(condition.field in facts)) throw new RouterError("INVALID_RULE", `Unknown routing field: ${condition.field}`);
  return facts[condition.field as keyof RuleFacts];
}

function evaluateCondition(condition: RuleCondition, facts: RuleFacts): boolean {
  const current = conditionValue(condition, facts);
  if (condition.op === "is_null") return current === null;
  if (condition.op === "eq") return current === condition.value;
  if (condition.op === "in") return Array.isArray(condition.value) && condition.value.includes(current);
  if (condition.op === "contains") return Array.isArray(current) && current.includes(condition.value);
  if (condition.op === "intersects") return Array.isArray(current) && Array.isArray(condition.value) && condition.value.some((value) => current.includes(value));
  if (condition.op === "contains_all") return Array.isArray(current) && Array.isArray(condition.value) && condition.value.every((value) => current.includes(value));
  if (condition.field === "uncertainty_max_impact" && typeof current === "string" && typeof condition.value === "string") {
    const left = IMPACT_RANK[current as keyof typeof IMPACT_RANK];
    const right = IMPACT_RANK[condition.value as keyof typeof IMPACT_RANK];
    if (left === undefined || right === undefined) throw new RouterError("INVALID_RULE", "Invalid uncertainty impact");
    return condition.op === "gte" ? left >= right : condition.op === "lte" ? left <= right : false;
  }
  if (NUMBER_FIELDS.has(condition.field) && typeof current === "number" && typeof condition.value === "number") {
    return condition.op === "gte" ? current >= condition.value : condition.op === "lte" ? current <= condition.value : false;
  }
  throw new RouterError("INVALID_RULE", `Operator ${condition.op} is not valid for ${condition.field}`);
}

function isExpression(value: RuleExpression | RuleCondition): value is RuleExpression {
  return "all" in value || "any" in value || "not" in value;
}

function validateCondition(condition: RuleCondition): void {
  const operator = condition.op;
  if (SCALAR_FIELDS.has(condition.field)) {
    if (!["eq", "in"].includes(operator) || (operator === "in" && !Array.isArray(condition.value))) throw new RouterError("INVALID_RULE", "Invalid scalar predicate");
    return;
  }
  if (LIST_FIELDS.has(condition.field)) {
    if (!["contains", "intersects", "contains_all"].includes(operator) || (operator !== "contains" && !Array.isArray(condition.value))) throw new RouterError("INVALID_RULE", "Invalid list predicate");
    return;
  }
  if (condition.field === "workspace" || condition.field === "project") {
    if (!["eq", "is_null"].includes(operator) || (operator === "eq" && typeof condition.value !== "string") || (operator === "is_null" && condition.value !== undefined)) throw new RouterError("INVALID_RULE", "Invalid context predicate");
    return;
  }
  if (condition.field === "uncertainty_max_impact") {
    if (!["eq", "gte", "lte"].includes(operator) || typeof condition.value !== "string" || !(condition.value in IMPACT_RANK)) throw new RouterError("INVALID_RULE", "Invalid impact predicate");
    return;
  }
  if (NUMBER_FIELDS.has(condition.field)) {
    if (!["eq", "gte", "lte"].includes(operator) || typeof condition.value !== "number") throw new RouterError("INVALID_RULE", "Invalid numeric predicate");
    return;
  }
  throw new RouterError("INVALID_RULE", `Unknown routing field: ${condition.field}`);
}

function evaluateNode(node: RuleExpression | RuleCondition, facts: RuleFacts, depth: number): boolean {
  if (!isExpression(node)) { validateCondition(node); return evaluateCondition(node, facts); }
  if (depth > 3) throw new RouterError("INVALID_RULE", "Routing expression exceeds depth 3");
  const keys = ["all", "any", "not"].filter((key) => key in node);
  if (keys.length !== 1) throw new RouterError("INVALID_RULE", "Routing expression must contain exactly one operator");
  if ("not" in node) return !evaluateNode(node.not, facts, depth + 1);
  const entries = "all" in node ? node.all : node.any;
  if (entries.length < 1 || entries.length > 20) throw new RouterError("INVALID_RULE", "Routing expression must contain 1-20 entries");
  return "all" in node ? entries.every((entry) => evaluateNode(entry, facts, depth + 1)) : entries.some((entry) => evaluateNode(entry, facts, depth + 1));
}

export function evaluateExpression(expression: RuleExpression, facts: RuleFacts): boolean {
  return evaluateNode(expression, facts, 1);
}

export interface AppliedRules {
  requiredCapabilities: string[];
  prefer: string[];
  avoid: string[];
  minimumLane: Lane;
  requiredApprovals: Array<Exclude<ApprovalType, "host-action">>;
  matchedRuleIds: string[];
  preferencesByLayer: { explicit: string[]; project: string[]; workspace: string[]; personal: string[] };
}

export function applyRoutingRules(input: RouteInput, rules: RoutingRule[], initialLane: Lane): AppliedRules {
  const facts = deriveRuleFacts(input);
  const matched = rules.filter((rule) => evaluateExpression(rule.when, facts)).sort((left, right) => LAYER_RANK[left.layer] - LAYER_RANK[right.layer] || right.priority - left.priority || left.id.localeCompare(right.id));
  const groups = new Map<string, RoutingRule[]>();
  for (const rule of matched) {
    const key = `${rule.layer}:${rule.priority}`;
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  for (const group of groups.values()) {
    const approvals = orderedUnique(group.map((rule) => rule.action.require_approval).filter((value): value is NonNullable<typeof value> => value !== undefined && value !== null));
    if (approvals.length > 1) throw new RouterError("AMBIGUOUS_ROUTE", "Matching rules require incompatible approvals", { rules: group.map((rule) => rule.id) });
  }
  const requiredCapabilities = [...input.requested_capabilities];
  const prefer: string[] = [];
  const avoid: string[] = [];
  const requiredApprovals: Array<Exclude<ApprovalType, "host-action">> = [];
  const preferencesByLayer = { explicit: [] as string[], project: [] as string[], workspace: [] as string[], personal: [] as string[] };
  let minimumLane = initialLane;
  for (const rule of matched) {
    if (rule.layer !== "additional-workspace") {
      requiredCapabilities.push(...(rule.action.require_capabilities ?? []));
      avoid.push(...(rule.action.avoid ?? []));
      if (rule.action.minimum_lane && LANE_RANK[rule.action.minimum_lane] > LANE_RANK[minimumLane]) minimumLane = rule.action.minimum_lane;
      if (rule.action.require_approval) requiredApprovals.push(rule.action.require_approval);
    }
    prefer.push(...(rule.action.prefer ?? []));
    if (rule.layer === "explicit" || rule.layer === "project" || rule.layer === "workspace" || rule.layer === "personal") preferencesByLayer[rule.layer].push(...(rule.action.prefer ?? []));
  }
  for (const layer of Object.keys(preferencesByLayer) as Array<keyof typeof preferencesByLayer>) preferencesByLayer[layer] = orderedUnique(preferencesByLayer[layer]);
  return { requiredCapabilities: orderedUnique(requiredCapabilities), prefer: orderedUnique(prefer), avoid: orderedUnique(avoid), minimumLane, requiredApprovals: orderedUnique(requiredApprovals), matchedRuleIds: matched.map((rule) => rule.id), preferencesByLayer };
}
