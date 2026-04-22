// Embedded viewer for workspace mode
// Receives file content via postMessage, then runs the full viewer pipeline

import { platform } from '../webview/index';
import { startViewer } from '../webview/viewer-main';
import { createPluginRenderer } from '../../../src/core/viewer/viewer-host';

function scrollToFragment(fragment: string): void {
  if (!fragment) return;

  const targetId = decodeURIComponent(fragment);
  let attemptsLeft = 60;

  const tryScroll = () => {
    const target = document.getElementById(targetId);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    attemptsLeft -= 1;
    if (attemptsLeft > 0) {
      requestAnimationFrame(tryScroll);
    }
  };

  requestAnimationFrame(tryScroll);
}

function findAnchorFromEventTarget(target: EventTarget | null): HTMLAnchorElement | null {
  if (!target) {
    return null;
  }

  if (target instanceof HTMLAnchorElement) {
    return target;
  }

  if (target instanceof HTMLElement) {
    return target.closest('a[href]') as HTMLAnchorElement | null;
  }

  if (target instanceof Node && target.parentElement) {
    return target.parentElement.closest('a[href]') as HTMLAnchorElement | null;
  }

  return null;
}

function findAnchorFromEvent(event: MouseEvent): HTMLAnchorElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const entry of path) {
    if (entry instanceof HTMLAnchorElement && entry.hasAttribute('href')) {
      return entry;
    }
    if (entry instanceof HTMLElement) {
      const anchor = entry.closest('a[href]') as HTMLAnchorElement | null;
      if (anchor) {
        return anchor;
      }
    }
  }

  return findAnchorFromEventTarget(event.target);
}

function normalizeWorkspaceHref(href: string): { path: string; fragment?: string } | null {
  if (!href) {
    return null;
  }

  if (href.startsWith('http://') || href.startsWith('https://')) {
    return null;
  }

  if (href.startsWith('#')) {
    return { path: '', fragment: href.slice(1) };
  }

  try {
    const parsed = new URL(href, window.location.href);
    if (parsed.protocol === 'chrome-extension:' && /\/ui\/workspace\/.+/.test(parsed.pathname)) {
      const workspacePrefix = '/ui/workspace/';
      const path = decodeURIComponent(parsed.pathname.slice(workspacePrefix.length));
      const fragment = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : undefined;
      return { path, fragment };
    }
  } catch {
    // Fall through to raw href handling below.
  }

  const hashIndex = href.indexOf('#');
  return {
    path: hashIndex >= 0 ? href.slice(0, hashIndex) : href,
    fragment: hashIndex >= 0 ? decodeURIComponent(href.slice(hashIndex + 1)) : undefined,
  };
}

function setupWorkspaceLinkHandling(): void {
  document.addEventListener('click', (event) => {
    const anchor = findAnchorFromEvent(event);
    if (!anchor) return;

    const rawHref = anchor.getAttribute('href') || '';
    const href = anchor.href || rawHref;
    if (!href) return;

    console.debug('[workspace-viewer] link click', {
      rawHref,
      href,
      text: anchor.textContent?.trim() || '',
      targetTag: event.target instanceof Node ? event.target.nodeName : typeof event.target,
    });

    event.preventDefault();
    event.stopPropagation();

    if (rawHref.startsWith('http://') || rawHref.startsWith('https://') || href.startsWith('http://') || href.startsWith('https://')) {
      console.debug('[workspace-viewer] opening external link', { href });
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }

    const normalized = normalizeWorkspaceHref(rawHref || href);
    if (!normalized) {
      console.debug('[workspace-viewer] unsupported link target', { rawHref, href });
      return;
    }

    if (!normalized.path && normalized.fragment) {
      console.debug('[workspace-viewer] scrolling to local fragment', { fragment: normalized.fragment });
      scrollToFragment(normalized.fragment);
      return;
    }

    console.debug('[workspace-viewer] posting relative navigation', normalized);
    window.parent.postMessage({ type: 'OPEN_RELATIVE_FILE', path: normalized.path, fragment: normalized.fragment }, '*');
  }, true);
}

setupWorkspaceLinkHandling();

// Wait for content from parent (workspace page)
function onMessage(event: MessageEvent) {
  if (!event.data || event.data.type !== 'RENDER_FILE') return;

  // Remove listener once we get our message
  window.removeEventListener('message', onMessage);

  const { content, filename, fileDir, codeView, fragment } = event.data;

  // Note: #markdown-viewer-preload style is now injected statically in
  // viewer-embed.html so the body stays hidden from first paint (before JS
  // even runs). viewer-main will remove it after the theme is applied.

  // Simulate how Chrome opens a plain text file:
  // body contains raw text inside a <pre> element
  document.body.textContent = content;

  // Override location-based URL detection by setting a data attribute
  // so the viewer can determine file type from filename
  document.documentElement.dataset.viewerFilename = filename;
  if (codeView) {
    document.documentElement.dataset.codeView = '1';
    // Add line numbers after code block is rendered with highlighting
    const observer = new MutationObserver(() => {
      const code = document.querySelector('#markdown-content pre code.hljs');
      if (!code) return;
      observer.disconnect();
      requestAnimationFrame(() => {
        // Count lines from the actual rendered text — always in sync
        const text = code.textContent || '';
        const lines = text.replace(/\n+$/, '').split('\n');
        const nums = lines.map((_, i) => i + 1).join('\n');
        (code as HTMLElement).dataset.lineNumbers = nums;
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Run the standard viewer pipeline (identical to main.ts)
  const pluginRenderer = createPluginRenderer(platform);
  startViewer({
    platform,
    pluginRenderer,
    themeConfigRenderer: platform.renderer,
  });

  if (typeof fragment === 'string' && fragment) {
    scrollToFragment(fragment);
  }

  // Resolve relative images via parent workspace
  if (fileDir !== undefined) {
    resolveWorkspaceImages(fileDir);
    setupWorkspaceFileReader();
  }
}

window.addEventListener('message', onMessage);

// ─── Resolve relative images via parent workspace ───
function isRelativeSrc(src: string): boolean {
  return !!src && !src.startsWith('http://') && !src.startsWith('https://') &&
    !src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('file:') &&
    !src.includes('://');
}

function resolveWorkspaceImages(fileDir: string) {
  let idCounter = 0;
  const pending = new Map<number, HTMLImageElement>();

  // Listen for resolved blob URLs from parent
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== 'IMAGE_RESOLVED') return;
    const img = pending.get(e.data.id);
    if (img) {
      img.src = e.data.url;
      pending.delete(e.data.id);
    }
  });

  function requestImage(img: HTMLImageElement) {
    const src = img.getAttribute('src');
    if (!src || !isRelativeSrc(src)) return;
    const id = ++idCounter;
    pending.set(id, img);
    window.parent.postMessage({ type: 'RESOLVE_IMAGE', src, id }, '*');
  }

  // Watch for img elements added by the rendering pipeline
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLImageElement) {
          requestImage(node);
        } else if (node instanceof HTMLElement) {
          for (const img of node.querySelectorAll<HTMLImageElement>('img')) {
            requestImage(img);
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also handle images already in the DOM
  for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
    requestImage(img);
  }
}

// ─── Workspace file reader (for readRelativeFile in workspace mode) ───
function setupWorkspaceFileReader() {
  const documentService = platform.document as import('../webview/api-impl').ChromeDocumentService;
  let idCounter = 0;
  const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== 'FILE_RESOLVED') return;
    const entry = pending.get(e.data.id);
    if (entry) {
      pending.delete(e.data.id);
      if (e.data.error) {
        entry.reject(new Error(e.data.error));
      } else {
        entry.resolve(e.data.content);
      }
    }
  });

  documentService.setWorkspaceFileReader((relativePath: string, binary: boolean) => {
    return new Promise((resolve, reject) => {
      const id = ++idCounter;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ type: 'RESOLVE_FILE', path: relativePath, id, binary }, '*');
    });
  });
}

// Notify parent that the viewer frame is ready to receive content
window.parent.postMessage({ type: 'VIEWER_READY' }, '*');
