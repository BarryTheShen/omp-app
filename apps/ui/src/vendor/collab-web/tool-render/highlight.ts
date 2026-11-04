/**
 * Code's colours in a chat (#2801): highlight.js with the languages a chat shows most, for the tool cards (`parts.tsx`)
 * and the code blocks of replies (`components/transcript/Markdown.tsx`). Its spans' classes take the theme's code colours
 * (`--syn-*`, in `styles/index.css`).
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import julia from "highlight.js/lib/languages/julia";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
	bash,
	c,
	cpp,
	csharp,
	css,
	diff,
	dockerfile,
	go,
	ini,
	java,
	javascript,
	json,
	julia,
	kotlin,
	less,
	lua,
	makefile,
	markdown,
	php,
	plaintext,
	python,
	ruby,
	rust,
	scss,
	shell,
	sql,
	swift,
	typescript,
	xml,
	yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

/**
 * `code` as highlight.js's HTML (escaped, with a span around each token) in `language`, a name or an alias (`ts`, `sh`,
 * `html`), or null for a language it does not know.
 */
export function highlightCode(code: string, language: string): string | null {
	if (language === "" || hljs.getLanguage(language) === undefined) return null;
	try {
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		return null;
	}
}
