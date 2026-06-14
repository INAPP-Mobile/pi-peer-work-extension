/**
 * Peer Workflow Extension entry wrapper.
 *
 * The workflow source lives under ./lib so TypeScript can emit
 * lib/index.js with imports that resolve to ./commands, ./tools, etc.
 */
export { default } from "./lib/index.ts";
