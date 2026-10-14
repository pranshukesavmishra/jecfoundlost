const crypto = require('crypto');
const config = require('./config');

/**
 * Builds /theme.css from config.themes, so a new theme only needs an entry in src/config.js.
 * Each theme overrides the brand tokens defined in public/css/style.css.
 */
function vars(t, primary, onPrimary = '#ffffff') {
  return `--primary: ${primary}; --primary-2: color-mix(in srgb, ${primary} 80%, #fff); --on-primary: ${onPrimary}; --navy: ${t.hero};`
    + ` --glow-1: ${t.glow[0]}; --glow-2: ${t.glow[1]}; --glow-3: ${t.glow[2]};`;
}

function buildThemeCss() {
  return config.themes.map((t) => {
    const sel = `:root[data-theme="${t.id}"]`;
    return `${sel} { ${vars(t, t.primary)} }\n`
      + `@media (prefers-color-scheme: dark) { ${sel}:not([data-mode="light"]) { ${vars(t, t.primaryDark, t.onDark)} } }\n`
      + `${sel}[data-mode="dark"] { ${vars(t, t.primaryDark, t.onDark)} }\n`;
  }).join('\n');
}

const css = buildThemeCss();
const version = crypto.createHash('sha1').update(css).digest('hex').slice(0, 8);

module.exports = { css, version };
