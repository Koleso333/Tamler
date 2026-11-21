# Tamler

Plugins for Claude Desktop. Tamler hooks into the running app and lets you load your own JS and CSS into it: themes, fonts, layout tweaks, whatever you want. It doesn't touch the EXE, ASAR or MSIX, so Claude updates normally.

Works on Windows x64 (Claude Desktop 6.28899.6, Electron 45.3.3). The build also supports Electron 45.2.1 and 44.9.3. macOS is in beta.

> Unofficial, not affiliated with Anthropic. It relies on Claude's internals, so any Claude update can break it. Use at your own risk.

## How it works

- **Windows:** a small native DLL is injected into Claude's main process and boots a JS core inside it. The core can be hot-swapped without restarting Claude.
- **macOS:** no DLL. A Node helper relaunches Claude through its built-in React DevTools loading path and talks to it over a local bridge.
- The core injects plugins into Claude's pages. No `eval`, CSP stays intact.
- The plugin manager lives in **Settings → Customize → Tamler**. Turn plugins on and off, change their settings, delete them.

## Run it

You need Node.js. To build the DLL yourself you also need Visual Studio with the x64 C++ tools.

```powershell
npm run build      # build the DLL (close Claude first)
npm run attach     # inject into the running Claude
npm run autostart -- enable   # auto-attach whenever Claude starts
```

On a Mac:

```bash
node scripts/mac.cjs start               # status | refresh | stop
node scripts/mac-autostart.cjs enable    # start with macOS
```

## Writing a plugin

A plugin is a folder in `plugins/` with a `plugin.json`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "main": "index.js",
  "css": "theme.css",
  "matches": ["https://claude.ai/*"],
  "settings": [
    { "key": "greeting", "type": "string", "label": "Greeting", "default": "Hi" }
  ]
}
```

```js
module.exports.start = ({ mount, addStyle, storage }) => {
  addStyle('body { letter-spacing: .01em; }');
  mount('h1', el => {
    const old = el.textContent;
    el.textContent = storage.get('greeting');
    return () => { el.textContent = old; };   // undo when the plugin stops
  });
};
```

Plugins are CommonJS and run inside the page. The `start(api)` function receives:
- the page's `document` and `window`;
- DOM helpers `mount`, `observe`, `on`, `addStyle`, `asset`;
- Claude's own React components through `ui()` and `render()`;
- `storage` and `files` for saving data;
- `request(url)` for network calls (allowed hosts are listed in `"hosts"`);
- `options` to supply choices for settings;
- `signal` and `cleanup` for shutdown.

Setting types: `boolean`, `string`, `number`, `select`, `list`, `files`, `color`. Any setting may have a `section`: the manager shows the section title before the first setting of each section.

A plugin can also patch Claude's own scripts with `"patches": [{ "url", "find", "replace", "flags"? }]`: when a script whose address matches `url` loads, the core replaces the regular expression `find` with `replace` before the page runs it. Patches apply on the next page load: restart Claude after enabling the plugin (at launch the core reloads the Claude page once so the patches catch every script). The `status` control command shows which patches matched (`patched`). See `plugins/context-return`.

The bundled plugins in `plugins/` are the best reference.

If a plugin crashes, only that plugin is disabled, and the error shows up in the manager.

## Repo layout

| Folder | What's inside |
| --- | --- |
| `native/` | Injector and loader DLL (C++). |
| `runtime/` | JS core, plugin runtime, manager UI, settings store, Mac adapter. |
| `scripts/` | Build, attach, autostart, control pipe, Claude source dump. |
| `plugins/` | Bundled plugins. |
| `installer/` | Inno Setup script. |
| `tests/` | `npm test`, `npm run test:renderer`, `npm run test:native`. |

Runtime data (settings, plugin storage, logs) goes to `data/` and `build/`. Neither is committed.

## License

[MIT](LICENSE)
