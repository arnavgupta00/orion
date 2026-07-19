import DOMPurify from 'dompurify';
import { marked, Renderer } from 'marked';

const ALLOWED_TAGS = [
  'p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre',
  'a', 'blockquote', 'br', 'hr',
];

export function renderScreenMarkdown(target: HTMLElement, markdown: string): void {
  const renderer = new Renderer();
  renderer.html = () => '';
  const rendered = marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
    renderer,
  });
  const sanitized = DOMPurify.sanitize(String(rendered), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title'],
    FORBID_TAGS: ['img', 'svg', 'math', 'style', 'iframe', 'object', 'embed'],
  });
  target.innerHTML = String(sanitized);

  target.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    const raw = link.getAttribute('href')?.trim() ?? '';
    if (!/^https?:\/\//i.test(raw)) {
      link.replaceWith(document.createTextNode(link.textContent ?? ''));
      return;
    }
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
}
