# openapi-exporter

Yaak plugin: export current Workspace or Folder as OpenAPI JSON.

## Features

- Export from `Workspace` context menu
- Export from `Folder` context menu (includes subfolders)
- Workspace schema management:
  - `Schema: Upsert`
  - `Schema: Delete`
  - `Schema: Copy Registry JSON`
- Request-level schema operations:
  - `Schema: Bind to Request Body`
  - `Schema: Validate Request Body`
- Resolve URL templates with current environment values before generating path
- Use latest request response history (if available) to build OpenAPI `responses`
  - status code from latest response
  - content-type from response headers
  - response body example from `bodyPath` (when readable and text-based)
- Export writes `components.schemas` and `requestBody.$ref` when request-schema binding exists
- Preserve Chinese file names and sanitize invalid filename characters
- Save flow supports creating new files (choose directory + input filename)

## Requirements

- Yaak version with plugin APIs from `@yaakapp/api >= 0.8.x`
- Node.js (for plugin build/dev)

## Install & Run

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## Usage

1. In Yaak sidebar, right-click a `Workspace` or `Folder`.
2. Click:
   - `Export OpenAPI (JSON)` for workspace
   - `Export Folder OpenAPI (JSON)` for folder
3. In export dialog:
   - Select output directory
   - Input file name (auto appends `.json` if missing)
4. Plugin writes file and also copies generated JSON to clipboard.

### Manage Schemas

1. Right-click workspace:
   - `Schema: Upsert` to add/update a JSON schema by name
   - `Schema: Delete` to remove a schema
2. Right-click request:
   - `Schema: Bind to Request Body` to bind one schema
   - `Schema: Validate Request Body` to validate body against schema

## Output Notes

- OpenAPI version: `3.1.0`
- Adds metadata:
  - `x-yaak-export.requestCount`
  - `x-yaak-export.responseBackedOperationCount`
  - `x-yaak-export.duplicatePathMethodCount`
- If duplicate `path + method` exists, only first one is kept.

## Limitations

- If a request has no response history, exporter falls back to a default `200` response.
- Binary response bodies are not embedded as examples.
