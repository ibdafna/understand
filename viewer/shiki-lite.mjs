// Slim replacement for the "shiki" main entry: only Go/TS/TSX/JS/Python grammars, JS regex engine, no WASM.
export * from '@shikijs/core';
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
export { createJavaScriptRegexEngine };
export function createOnigurumaEngine() { throw new Error('WASM engine not bundled'); }
export function loadWasm() { throw new Error('WASM engine not bundled'); }
const go = () => import('@shikijs/langs/go');
const ts = () => import('@shikijs/langs/typescript');
const tsx = () => import('@shikijs/langs/tsx');
const js = () => import('@shikijs/langs/javascript');
const jsx = () => import('@shikijs/langs/jsx');
const py = () => import('@shikijs/langs/python');
export const bundledLanguages = { go, typescript: ts, ts, tsx, javascript: js, js, jsx, python: py, py };
export const bundledLanguagesBase = bundledLanguages, bundledLanguagesAlias = {}, bundledLanguagesInfo = [];
export const bundledThemes = {}, bundledThemesInfo = [];
export const createHighlighter = createBundledHighlighter({ langs: bundledLanguages, themes: bundledThemes, engine: () => createJavaScriptRegexEngine() });
export const { codeToHtml, codeToHast, codeToTokens, codeToTokensBase, codeToTokensWithThemes, getSingletonHighlighter, getLastGrammarState } = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
