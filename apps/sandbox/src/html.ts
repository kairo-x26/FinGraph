export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --ink:#1b2a32; --paper:#f3f5f4; --line:#c9d1cf; --accent:#0e5e6f; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e3e9e8; --paper:#142026; --line:#33454c; --accent:#5fb3c4; } }
  body { margin:0; font: 15px/1.5 system-ui, sans-serif; background: var(--paper); color: var(--ink); }
  main { max-width: 420px; margin: 10vh auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .note { margin: 0 0 24px; opacity: .7; font-size: 13px; }
  form { display: grid; gap: 14px; }
  label { display: grid; gap: 4px; font-size: 13px; }
  input, select { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 4px; background: transparent; color: inherit; }
  .row { display: flex; gap: 8px; }
  button { font: inherit; padding: 8px 14px; border-radius: 4px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: var(--accent); }
  .consent { border-left: 3px solid var(--accent); padding-left: 10px; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p class="note">Local development sandbox. Not a real identity provider.</p>${body}</main></body>
</html>`;
}
