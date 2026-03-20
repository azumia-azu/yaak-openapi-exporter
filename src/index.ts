import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Context,
  Folder,
  HttpRequest,
  HttpResponse,
  PluginDefinition,
  Workspace,
} from "@yaakapp/api";

type OpenApiDocument = {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
  };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
  };
  tags?: Array<{ name: string }>;
  "x-yaak-export"?: {
    requestCount: number;
    responseBackedOperationCount: number;
    generatedAt: string;
    duplicatePathMethodCount: number;
  };
};

type WorkspaceSchemaState = {
  schemas: Record<string, unknown>;
  bindings: Record<string, string>;
};

type SchemaRegistry = {
  version: 1;
  workspaces: Record<string, WorkspaceSchemaState>;
};

const SCHEMA_STORE_KEY = "openapi_exporter.schema_registry.v1";

export const plugin: PluginDefinition = {
  workspaceActions: [
    {
      label: "Export OpenAPI (JSON)",
      icon: "copy",
      async onSelect(ctx, args) {
        await exportOpenApi(ctx, args.workspace, null);
      },
    },
    {
      label: "Schema: Upsert",
      icon: "pin",
      async onSelect(ctx, args) {
        await upsertWorkspaceSchema(ctx, args.workspace.id);
      },
    },
    {
      label: "Schema: Delete",
      icon: "trash",
      async onSelect(ctx, args) {
        await deleteWorkspaceSchema(ctx, args.workspace.id);
      },
    },
    {
      label: "Schema: Copy Registry JSON",
      icon: "copy",
      async onSelect(ctx, args) {
        await copyWorkspaceSchemas(ctx, args.workspace.id);
      },
    },
  ],
  folderActions: [
    {
      label: "Export Folder OpenAPI (JSON)",
      icon: "copy",
      async onSelect(ctx, args) {
        await exportOpenApi(ctx, null, args.folder);
      },
    },
  ],
  httpRequestActions: [
    {
      label: "Schema: Bind to Request Body",
      icon: "pin",
      async onSelect(ctx, args) {
        await bindSchemaToRequest(ctx, args.httpRequest);
      },
    },
    {
      label: "Schema: Validate Request Body",
      icon: "check_circle",
      async onSelect(ctx, args) {
        await validateRequestBodyWithSchema(ctx, args.httpRequest);
      },
    },
  ],
};

async function exportOpenApi(
  ctx: Context,
  workspace: Workspace | null,
  folder: Folder | null
) {
  try {
    const folderList = await ctx.folder.list();
    const activeWorkspace = workspace ?? (await resolveWorkspaceById(ctx, folder?.workspaceId ?? ""));

    if (!activeWorkspace) {
      await ctx.toast.show({
        color: "danger",
        message: "Cannot resolve workspace for export",
      });
      return;
    }

    const requests = await listScopeRequests(ctx, folderList, folder);
    const folderPathById = buildFolderPathMap(folderList);
    const openapiDoc = await toOpenApi(ctx, requests, activeWorkspace, folderPathById);
    const content = JSON.stringify(openapiDoc, null, 2);

    const scopeName = folder?.name ?? activeWorkspace.name;
    const defaultFileName = `${sanitizeFileName(scopeName)}.json`;
    const targetPath = await promptOutputPath(ctx, defaultFileName);

    if (!targetPath) {
      await ctx.toast.show({ color: "notice", message: "OpenAPI export cancelled" });
      return;
    }

    await writeFile(targetPath, content, "utf8");
    await ctx.clipboard.copyText(content);
    await ctx.toast.show({
      color: "success",
      message: `Exported ${requests.length} requests to ${targetPath}`,
    });
  } catch (error) {
    await ctx.toast.show({
      color: "danger",
      message: `OpenAPI export failed: ${toErrorMessage(error)}`,
    });
  }
}

async function promptOutputPath(ctx: Context, defaultFileName: string) {
  const values = await ctx.prompt.form({
    id: "openapi_export_target",
    title: "Export OpenAPI",
    description: "Select a directory and file name",
    confirmText: "Export",
    cancelText: "Cancel",
    inputs: [
      {
        type: "file",
        name: "directory",
        label: "Directory",
        title: "Choose export directory",
        directory: true,
      },
      {
        type: "text",
        name: "fileName",
        label: "File name",
        defaultValue: defaultFileName,
        placeholder: "openapi.json",
      },
    ],
  });

  if (!values) return null;

  const directory = typeof values.directory === "string" ? values.directory.trim() : "";
  let fileName =
    typeof values.fileName === "string" && values.fileName.trim().length > 0
      ? values.fileName.trim()
      : defaultFileName;

  if (!fileName.toLowerCase().endsWith(".json")) {
    fileName = `${fileName}.json`;
  }

  if (!directory) return fileName;
  return join(directory, fileName);
}

async function upsertWorkspaceSchema(ctx: Context, workspaceId: string) {
  const values = await ctx.prompt.form({
    id: "schema_upsert",
    title: "Upsert JSON Schema",
    confirmText: "Save",
    cancelText: "Cancel",
    inputs: [
      {
        type: "text",
        name: "schemaName",
        label: "Schema name",
        placeholder: "UserCreateRequest",
      },
      {
        type: "editor",
        name: "schemaJson",
        label: "Schema JSON",
        language: "json",
        defaultValue: "{\n  \"type\": \"object\",\n  \"properties\": {}\n}",
      },
    ],
  });

  if (!values) return;
  const schemaName = typeof values.schemaName === "string" ? values.schemaName.trim() : "";
  const schemaJson = typeof values.schemaJson === "string" ? values.schemaJson.trim() : "";
  if (!schemaName || !schemaJson) {
    await ctx.toast.show({ color: "warning", message: "Schema name and JSON are required" });
    return;
  }

  try {
    const parsed = JSON.parse(schemaJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      await ctx.toast.show({ color: "warning", message: "Schema must be a JSON object" });
      return;
    }
    const state = await loadWorkspaceSchemaState(ctx, workspaceId);
    state.schemas[schemaName] = parsed;
    await saveWorkspaceSchemaState(ctx, workspaceId, state);
    await ctx.toast.show({ color: "success", message: `Schema '${schemaName}' saved` });
  } catch (error) {
    await ctx.toast.show({ color: "danger", message: `Invalid JSON: ${toErrorMessage(error)}` });
  }
}

async function deleteWorkspaceSchema(ctx: Context, workspaceId: string) {
  const state = await loadWorkspaceSchemaState(ctx, workspaceId);
  const schemaNames = Object.keys(state.schemas).sort();
  if (schemaNames.length === 0) {
    await ctx.toast.show({ color: "notice", message: "No schemas to delete" });
    return;
  }

  const values = await ctx.prompt.form({
    id: "schema_delete",
    title: "Delete JSON Schema",
    description: `Available: ${schemaNames.join(", ")}`,
    confirmText: "Delete",
    cancelText: "Cancel",
    inputs: [
      {
        type: "select",
        name: "schemaName",
        label: "Schema",
        options: schemaNames.map((name) => ({ label: name, value: name })),
      },
    ],
  });
  if (!values) return;
  const schemaName = typeof values.schemaName === "string" ? values.schemaName : "";
  if (!schemaName || !state.schemas[schemaName]) return;

  delete state.schemas[schemaName];
  for (const [requestId, boundSchema] of Object.entries(state.bindings)) {
    if (boundSchema === schemaName) delete state.bindings[requestId];
  }
  await saveWorkspaceSchemaState(ctx, workspaceId, state);
  await ctx.toast.show({ color: "success", message: `Schema '${schemaName}' deleted` });
}

async function copyWorkspaceSchemas(ctx: Context, workspaceId: string) {
  const state = await loadWorkspaceSchemaState(ctx, workspaceId);
  const payload = JSON.stringify(
    {
      schemas: state.schemas,
      bindings: state.bindings,
    },
    null,
    2
  );
  await ctx.clipboard.copyText(payload);
  await ctx.toast.show({
    color: "success",
    message: `Copied ${Object.keys(state.schemas).length} schema(s) to clipboard`,
  });
}

async function bindSchemaToRequest(ctx: Context, req: HttpRequest) {
  const state = await loadWorkspaceSchemaState(ctx, req.workspaceId);
  const schemaNames = Object.keys(state.schemas).sort();
  if (schemaNames.length === 0) {
    await ctx.toast.show({
      color: "notice",
      message: "No schemas found. Add schemas from Workspace > Schema: Upsert",
    });
    return;
  }

  const values = await ctx.prompt.form({
    id: "schema_bind_request",
    title: "Bind Schema to Request Body",
    description: `Request: ${req.name || req.id}`,
    confirmText: "Bind",
    cancelText: "Cancel",
    inputs: [
      {
        type: "select",
        name: "schemaName",
        label: "Schema",
        options: schemaNames.map((name) => ({ label: name, value: name })),
        defaultValue: state.bindings[req.id],
      },
    ],
  });

  if (!values) return;
  const schemaName = typeof values.schemaName === "string" ? values.schemaName : "";
  if (!schemaName || !state.schemas[schemaName]) return;

  state.bindings[req.id] = schemaName;
  await saveWorkspaceSchemaState(ctx, req.workspaceId, state);
  await ctx.toast.show({
    color: "success",
    message: `Bound '${schemaName}' to request '${req.name || req.id}'`,
  });
}

async function validateRequestBodyWithSchema(ctx: Context, req: HttpRequest) {
  const state = await loadWorkspaceSchemaState(ctx, req.workspaceId);
  const schemaNames = Object.keys(state.schemas).sort();
  if (schemaNames.length === 0) {
    await ctx.toast.show({
      color: "notice",
      message: "No schemas found. Add schemas from Workspace > Schema: Upsert",
    });
    return;
  }

  const values = await ctx.prompt.form({
    id: "schema_validate_request",
    title: "Validate Request Body",
    description: `Request: ${req.name || req.id}`,
    confirmText: "Validate",
    cancelText: "Cancel",
    inputs: [
      {
        type: "select",
        name: "schemaName",
        label: "Schema",
        options: schemaNames.map((name) => ({ label: name, value: name })),
        defaultValue: state.bindings[req.id],
      },
    ],
  });
  if (!values) return;
  const schemaName = typeof values.schemaName === "string" ? values.schemaName : "";
  const schema = state.schemas[schemaName];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    await ctx.toast.show({ color: "danger", message: "Selected schema is invalid" });
    return;
  }

  const bodyData = extractRequestBodyData(req);
  const errors = validateJsonSchemaLike(schema as Record<string, unknown>, bodyData, "$");
  if (errors.length === 0) {
    await ctx.toast.show({
      color: "success",
      message: `Validation passed with schema '${schemaName}'`,
    });
    return;
  }

  await ctx.toast.show({
    color: "danger",
    message: `Validation failed (${errors.length}): ${errors.slice(0, 2).join(" | ")}`,
  });
}

async function loadWorkspaceSchemaState(ctx: Context, workspaceId: string) {
  const registry = await loadSchemaRegistry(ctx);
  return registry.workspaces[workspaceId] ?? { schemas: {}, bindings: {} };
}

async function saveWorkspaceSchemaState(
  ctx: Context,
  workspaceId: string,
  state: WorkspaceSchemaState
) {
  const registry = await loadSchemaRegistry(ctx);
  registry.workspaces[workspaceId] = state;
  await ctx.store.set(SCHEMA_STORE_KEY, registry);
}

async function loadSchemaRegistry(ctx: Context): Promise<SchemaRegistry> {
  const saved = await ctx.store.get<SchemaRegistry>(SCHEMA_STORE_KEY);
  if (!saved || saved.version !== 1 || typeof saved.workspaces !== "object") {
    return { version: 1, workspaces: {} };
  }
  return saved;
}

function extractRequestBodyData(req: HttpRequest) {
  const candidate = pickBodyExample(req.body);
  if (typeof candidate === "string") {
    try {
      return JSON.parse(candidate);
    } catch {
      return candidate;
    }
  }
  return candidate;
}

function validateJsonSchemaLike(
  schema: Record<string, unknown>,
  value: unknown,
  path: string
): string[] {
  const errors: string[] = [];

  const expectedType = typeof schema.type === "string" ? schema.type : undefined;
  if (expectedType && !matchesType(value, expectedType)) {
    errors.push(`${path}: expected ${expectedType}`);
    return errors;
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : null;
  if (enumValues && !enumValues.some((v) => deepEqual(v, value))) {
    errors.push(`${path}: value not in enum`);
  }

  if (expectedType === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in obj)) errors.push(`${path}.${key}: required`);
    }

    const properties =
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in obj)) continue;
      if (!childSchema || typeof childSchema !== "object" || Array.isArray(childSchema)) continue;
      errors.push(
        ...validateJsonSchemaLike(
          childSchema as Record<string, unknown>,
          obj[key],
          `${path}.${key}`
        )
      );
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) errors.push(`${path}.${key}: additional property not allowed`);
      }
    }
  }

  if (expectedType === "array" && Array.isArray(value)) {
    const itemSchema =
      schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
        ? (schema.items as Record<string, unknown>)
        : null;
    if (itemSchema) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchemaLike(itemSchema, item, `${path}[${index}]`));
      });
    }
  }

  return errors;
}

function matchesType(value: unknown, type: string) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function resolveWorkspaceById(
  ctx: Context,
  workspaceId: string
) {
  const workspaces = await ctx.workspace.list();
  const match = workspaces.find((w) => w.id === workspaceId);
  if (!match) return null;
  return {
    model: "workspace",
    id: match.id,
    name: match.name,
  } as Workspace;
}

async function listScopeRequests(
  ctx: Context,
  folders: Folder[],
  rootFolder: Folder | null
) {
  if (!rootFolder) {
    return ctx.httpRequest.list();
  }

  const descendantIds = collectDescendantFolderIds(rootFolder.id, folders);
  const result = await Promise.all(
    Array.from(descendantIds).map((folderId) => ctx.httpRequest.list({ folderId }))
  );

  const deduped = new Map<string, HttpRequest>();
  for (const reqList of result) {
    for (const req of reqList) deduped.set(req.id, req);
  }
  return Array.from(deduped.values());
}

function collectDescendantFolderIds(rootId: string, folders: Folder[]) {
  const byParent = new Map<string | null, string[]>();
  for (const folder of folders) {
    const key = folder.folderId ?? null;
    const arr = byParent.get(key) ?? [];
    arr.push(folder.id);
    byParent.set(key, arr);
  }

  const ids = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const childId of byParent.get(current) ?? []) {
      if (ids.has(childId)) continue;
      ids.add(childId);
      queue.push(childId);
    }
  }
  return ids;
}

function buildFolderPathMap(folders: Folder[]) {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  const cache = new Map<string, string>();

  const pathFor = (folderId: string): string => {
    if (cache.has(folderId)) return cache.get(folderId)!;
    const seen = new Set<string>();
    const parts: string[] = [];
    let current = byId.get(folderId) ?? null;
    while (current) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      parts.unshift(current.name);
      current = current.folderId ? (byId.get(current.folderId) ?? null) : null;
    }
    const path = parts.join(" / ");
    cache.set(folderId, path);
    return path;
  };

  for (const f of folders) pathFor(f.id);
  return cache;
}

async function toOpenApi(
  ctx: Context,
  requests: HttpRequest[],
  workspace: Pick<Workspace, "id" | "name">,
  folderPathById: Map<string, string>
): Promise<OpenApiDocument> {
  const paths: OpenApiDocument["paths"] = {};
  const tags = new Set<string>();
  const servers = new Set<string>();
  let duplicatePathMethodCount = 0;
  let responseBackedOperationCount = 0;
  const schemaState = await loadWorkspaceSchemaState(ctx, workspace.id);
  const componentSchemas = { ...schemaState.schemas };

  for (const req of requests) {
    const method = req.method.toLowerCase();
    if (!isHttpMethod(method)) continue;

    const renderedUrl = await renderTemplateString(ctx, req.url);
    const { path, server } = splitPathAndServer(renderedUrl);
    if (server) servers.add(server);

    const pathItem = (paths[path] ??= {});
    if (pathItem[method]) {
      duplicatePathMethodCount += 1;
      continue;
    }

    const responses = await buildResponsesFromHistory(ctx, req);
    if (responses.source === "history") responseBackedOperationCount += 1;

    const operation: Record<string, unknown> = {
      summary: req.name || undefined,
      description: req.description || undefined,
      parameters: buildParameters(req, path),
      responses: responses.value,
      "x-yaak-request-id": req.id,
      "x-yaak-body-type": req.bodyType,
    };

    if (req.folderId && folderPathById.get(req.folderId)) {
      const tag = folderPathById.get(req.folderId)!;
      operation.tags = [tag];
      tags.add(tag);
    }

    const boundSchemaName = schemaState.bindings[req.id];
    const requestBody = buildRequestBody(req, boundSchemaName && componentSchemas[boundSchemaName]
      ? boundSchemaName
      : undefined);
    if (requestBody) operation.requestBody = requestBody;

    pathItem[method] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${workspace.name} API`,
      version: "1.0.0",
    },
    servers: Array.from(servers).map((url) => ({ url })),
    paths,
    components:
      Object.keys(componentSchemas).length > 0
        ? {
            schemas: componentSchemas,
          }
        : undefined,
    tags: Array.from(tags).sort().map((name) => ({ name })),
    "x-yaak-export": {
      requestCount: requests.length,
      responseBackedOperationCount,
      generatedAt: new Date().toISOString(),
      duplicatePathMethodCount,
    },
  };
}

async function renderTemplateString(ctx: Context, value: string) {
  try {
    const rendered = await ctx.templates.render({
      purpose: "preview",
      data: value,
    });
    return typeof rendered === "string" ? rendered : value;
  } catch {
    return value;
  }
}

async function buildResponsesFromHistory(ctx: Context, req: HttpRequest) {
  const fallback = {
    source: "fallback" as const,
    value: {
      "200": { description: "Successful response" },
    },
  };

  try {
    const history = await ctx.httpResponse.find({ requestId: req.id, limit: 1 });
    const latest = history[0];
    if (!latest) return fallback;

    const status = String(latest.status || 200);
    const contentType = inferResponseContentType(latest) ?? "application/json";
    const example = await tryReadResponseBodyExample(latest.bodyPath, contentType);

    return {
      source: "history" as const,
      value: {
        [status]: {
          description: latest.statusReason || `HTTP ${status}`,
          headers: toResponseHeaderSchema(latest),
          content: {
            [contentType]: {
              schema: schemaFromExample(example),
              example,
            },
          },
        },
      },
    };
  } catch {
    return fallback;
  }
}

async function tryReadResponseBodyExample(bodyPath: string | null, contentType: string) {
  if (!bodyPath) return undefined;
  if (!isTextContentType(contentType)) return undefined;
  try {
    const content = await readFile(bodyPath, "utf8");
    const trimmed = content.trim();
    if (!trimmed) return undefined;
    if (contentType.includes("json")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    return trimmed.slice(0, 4000);
  } catch {
    return undefined;
  }
}

function toResponseHeaderSchema(response: HttpResponse) {
  const result: Record<string, { schema: { type: "string" }; example?: string }> = {};
  for (const header of response.headers) {
    if (!header.name) continue;
    const key = header.name.toLowerCase();
    if (result[key]) continue;
    result[key] = {
      schema: { type: "string" },
      example: header.value || undefined,
    };
  }
  return result;
}

function inferResponseContentType(response: HttpResponse) {
  for (const header of response.headers) {
    if (header.name.toLowerCase() !== "content-type") continue;
    const raw = header.value.split(";")[0] ?? header.value;
    return raw.trim().toLowerCase();
  }
  return null;
}

function isTextContentType(contentType: string) {
  if (contentType.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-www-form-urlencoded",
  ].some((v) => contentType.includes(v));
}

function schemaFromExample(example: unknown) {
  if (example == null) return { type: "string" };
  if (Array.isArray(example)) return { type: "array" };
  if (typeof example === "object") return { type: "object" };
  if (typeof example === "number") return { type: "number" };
  if (typeof example === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function buildParameters(req: HttpRequest, path: string) {
  const pathParams = new Set<string>();
  for (const match of path.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)) {
    const param = match[1];
    if (param) pathParams.add(param);
  }

  const params: Array<Record<string, unknown>> = [];
  for (const name of pathParams) {
    params.push({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }

  for (const qp of req.urlParameters ?? []) {
    if (qp.enabled === false || !qp.name) continue;
    params.push({
      name: qp.name,
      in: "query",
      required: false,
      schema: { type: "string" },
      example: qp.value || undefined,
    });
  }

  for (const header of req.headers ?? []) {
    if (header.enabled === false || !header.name) continue;
    params.push({
      name: header.name,
      in: "header",
      required: false,
      schema: { type: "string" },
      example: header.value || undefined,
    });
  }

  return params;
}

function buildRequestBody(req: HttpRequest, schemaRefName?: string) {
  if (["get", "delete", "head", "options"].includes(req.method.toLowerCase())) {
    return undefined;
  }

  const contentType = inferContentType(req.bodyType, req.headers);
  const example = pickBodyExample(req.body);
  return {
    required: false,
    content: {
      [contentType]: {
        schema: schemaRefName
          ? { $ref: `#/components/schemas/${escapeJsonPointerToken(schemaRefName)}` }
          : contentType === "application/json"
            ? { type: "object" }
            : { type: "string" },
        example,
      },
    },
  };
}

function inferContentType(
  bodyType: string | null,
  headers: Array<{ name: string; value: string; enabled?: boolean }>
) {
  const header = headers.find(
    (h) => h.enabled !== false && h.name.toLowerCase() === "content-type"
  );
  if (header?.value) {
    const raw = header.value.split(";")[0] ?? header.value;
    return raw.trim().toLowerCase();
  }
  const normalized = (bodyType ?? "").toLowerCase();
  if (normalized.includes("json")) return "application/json";
  if (normalized.includes("xml")) return "application/xml";
  if (normalized.includes("form")) return "application/x-www-form-urlencoded";
  return "text/plain";
}

function pickBodyExample(body: Record<string, unknown>) {
  if (!body || typeof body !== "object") return undefined;

  const keys = ["text", "value", "raw", "content"] as const;
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) return value;
  }

  const jsonCandidate = body.json;
  if (typeof jsonCandidate === "string") {
    try {
      return JSON.parse(jsonCandidate);
    } catch {
      return jsonCandidate;
    }
  }
  if (jsonCandidate && typeof jsonCandidate === "object") return jsonCandidate;
  return body;
}

function splitPathAndServer(rawUrl: string) {
  let url = rawUrl.trim();
  if (!url) return { path: "/", server: null as string | null };

  // Replace template expressions to make URL parser more resilient.
  url = url.replace(/\{\{\s*([^}]+?)\s*\}\}/g, "_var_$1");

  try {
    const parsed = new URL(url);
    const path = normalizeOpenApiPath(parsed.pathname);
    return {
      path,
      server: parsed.origin,
    };
  } catch {
    const withoutHost = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+/, "");
    return {
      path: normalizeOpenApiPath(withoutHost || "/"),
      server: null,
    };
  }
}

function normalizeOpenApiPath(path: string) {
  const cleaned = (path.split("?")[0] || "/")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, "{$1}");
  if (!cleaned.startsWith("/")) return `/${cleaned}`;
  return cleaned || "/";
}

function toOperationId(req: HttpRequest) {
  const base = `${req.method}_${req.name || req.id}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || `operation_${req.id}`;
}

function sanitizeFileName(name: string) {
  const sanitized = name
    .normalize("NFC")
    .trim()
    // Remove characters invalid on Windows/macOS/Linux file systems.
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .replace(/^-+|-+$/g, "");

  return sanitized || "openapi";
}

function escapeJsonPointerToken(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isHttpMethod(method: string): method is
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options"
  | "trace" {
  return [
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
    "trace",
  ].includes(method);
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
