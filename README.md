# Cursor Remote — PC extension (WebSocket)

VS Code / Cursor extension: telefondan **WebSocket** (`8766`) ile `agent` komutları.

Fork: [jaloveeye/cursor-remote](https://github.com/jaloveeye/cursor-remote) `cursor-extension` (MIT).

## Kurulum

1. `npm install`
2. `npm run compile`
3. Cursor → **Extensions** → **Install from VSIX** veya F5 ile geliştirme.
4. `Ctrl+Shift+P` → **Cursor Remote: Start Server** (port 8766).
5. Tailscale + mobil uygulama (`alper_cursor_remote`).

## Auth PIN

`Ctrl+Shift+P` → **Cursor Remote: Generate 8-char auth PIN** → telefonda aynı PIN.

## İlgili repo

- Mobil: `alper_cursor_remote` (Flutter)
