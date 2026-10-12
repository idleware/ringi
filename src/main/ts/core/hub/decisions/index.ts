// decide: the extension for decisions and budgets (capability `decisions/1`, docs/spec/decisions-1.md). A proposal circulates
// to named reviewers, who stamp it; only the named decider, holding authority from the hub's contract, decides. An
// approval that carries a budget is a grant; work spends against it, and the runner that starts model runs writes
// the usage receipts. Everything here is a pure fold over messages; nothing trusts a model's own report.

export const CAPABILITY = 'decisions/1'
export * from './budget.ts'
export * from './check.ts'
export * from './proposal.ts'
export * from './usage.ts'
