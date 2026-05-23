/**
 * Routing-ask comment detection (PRE-896/PRE-898).
 *
 * Identifies comment bodies that explicitly request reassignment, routing, or
 * escalation. Used by the in_review parent child-audit digest to flag blocked
 * children whose latest comment is a routing-ask so the woken triage agent
 * (typically CEO) can act without an extra fetch.
 *
 * Patterns cover EN / UK / RU phrasings observed in the CEO / CTO / engineer
 * comment corpus through W21. Extending the regex is a one-file change here —
 * no service-code touch required.
 */

export const ROUTING_ASK_REGEX =
  /(routing[\-_\s]?ask|route\s+to\s+(?:ceo|cto|board|mike)|patch\s+assigneeagentid|please\s+reassign|re[\-\s]?assign\s+to|не\s+ма[єе]\s+tasks:assign|cannot\s+assign\s+task|нет\s+прав\s+на\s+assign|escalat(?:e|ing)\s+to\s+(?:ceo|cto|board|mike)|hand[\-\s]?off\s+to\s+(?:ceo|cto))/i;

export function detectRoutingAsk(body: string | null | undefined): boolean {
  if (typeof body !== "string") return false;
  const trimmed = body.trim();
  if (!trimmed) return false;
  return ROUTING_ASK_REGEX.test(trimmed);
}
