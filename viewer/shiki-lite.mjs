// Slim replacement for the "shiki" main entry: the JavaScript regex engine (no WASM), and only the
// grammars this page carries. render.ts inlines one script per language in the diff; each sets
// UNDERSTAND_LANGS[id] before the viewer runs.
export * from '@shikijs/core';
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
export { createJavaScriptRegexEngine };
export function createOnigurumaEngine() { throw new Error('WASM engine not bundled'); }
export function loadWasm() { throw new Error('WASM engine not bundled'); }
export const bundledLanguages = Object.fromEntries(Object.entries(globalThis.UNDERSTAND_LANGS ?? {}).map(([id, grammar]) => [id, () => Promise.resolve({ default: grammar })]));
export const bundledLanguagesBase = bundledLanguages, bundledLanguagesAlias = {}, bundledLanguagesInfo = [];
export const bundledThemes = {}, bundledThemesInfo = [];
export const createHighlighter = createBundledHighlighter({ langs: bundledLanguages, themes: bundledThemes, engine: () => createJavaScriptRegexEngine() });
export const { codeToHtml, codeToHast, codeToTokens, codeToTokensBase, codeToTokensWithThemes, getSingletonHighlighter, getLastGrammarState } = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
