# opencode-attachment-materialize

An [opencode](https://opencode.ai) v1 plugin that makes GUI-attached files usable by the agent's tools.

## The problem

When you attach a file through the opencode web GUI, it reaches the model as an inline base64 part. The model can *see* the content, but no file exists on the server's disk — so `read`, `bash`, and every other tool fail the moment the agent tries to open, copy, grep, or convert it. This is fine for an image the model only needs to look at, and useless for a CSV it should parse or a zip it should extract.

## What the plugin does

On each incoming user message, the plugin finds file parts carrying `data:` URLs, writes their decoded bytes to a per-session directory under opencode's data dir, and appends a text part to the same turn:

```
Attached file saved to: /home/you/.local/share/opencode/v1-attachments/ses_abc123/report.csv (text/csv, 18432 bytes)
```

The original media part stays in the message, so providers that support native images or PDFs still receive them. Parts with `file:` URLs (TUI `@file` mentions — already real paths) and non-file parts are left untouched.

## Install

Copy or symlink `attachment-materialize.ts` into one of opencode's plugin directories, then restart opencode:

- global: `${XDG_CONFIG_HOME:-~/.config}/opencode/plugin/`
- per project: `<project>/.opencode/plugin/`

Both scopes also discover a `plugins/` directory. No build step and no dependencies — the plugin's only import from `@opencode-ai/plugin` is type-only.

## Behavior details

- Files are stored at `<opencode data dir>/v1-attachments/<sessionID>/<name>`. The data dir respects `XDG_DATA_HOME`. Set `OPENCODE_ATTACHMENT_DIR` to use a different root. Relative values for either environment variable resolve against the opencode server's working directory, and the appended path is always absolute.
- Filenames are sanitized: directory components are stripped, Unicode is NFC-normalized, bidi and control characters are removed, Windows device names are neutralized, and length is capped. An empty result falls back to a generated name. Name collisions within one message and different-length collisions get `-2`, `-3`, … suffixes. After 1,000 numeric collisions, the plugin uses a short random suffix. A later attachment with the same sanitized name and byte length reuses the existing path as the retry heuristic.
- Each file is capped at 25 MiB. The decoder accepts padded or unpadded base64, the standard or URL-safe alphabet, ASCII whitespace, and metadata such as `;charset=utf-8` before `;base64`. A data URL without the `;base64` marker is not decoded. Oversized or undecodable attachments are skipped with an explanatory text part instead of failing the turn. A plugin failure never breaks a message.
- There is no quota or automatic cleanup. You can delete the `v1-attachments` directory when no turn is using its files, but deletion makes paths recorded in older messages stop resolving.

## Development

```sh
bun install
bun test        # behavioral tests against the real filesystem
bun run typecheck
```

## License

MIT
