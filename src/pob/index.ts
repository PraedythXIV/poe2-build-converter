// src/pob — barrel: the lossless PoB2 model + its parser, the single source of truth for the parsed
// build. Consumers may import from here directly; `convert/` currently reaches it via re-export shims
// in convert/types.ts and convert/parsePob.ts (so no import-path churn). See _workbench/Docs/pob-model-design.md.
export * from './model'
export { parsePob, ParseError } from './parse'
