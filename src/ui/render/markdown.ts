import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

/**
 * Markdown → coloured terminal text (headings, bold, lists, tables, and
 * syntax-highlighted code blocks). Returns a function so the UI depends on
 * "something that renders Markdown", not on these libraries.
 */
export function createMarkdownRenderer(width: number): (markdown: string) => string {
  const marked = new Marked();
  marked.use(
    // The types for marked-terminal lag behind marked's; the runtime API matches.
    markedTerminal({ reflowText: false, width, showSectionPrefix: false, tab: 2 }) as never,
  );
  return (markdown) => {
    try {
      return String(marked.parse(markdown)).replace(/\n+$/, '');
    } catch {
      return markdown; // never lose the answer because of a rendering problem
    }
  };
}
