import type { DriveAuth, Fetch } from "../drive/driveApi";

type StoredFile = { id: string; name: string; version: number; content: string };
type Failure = { status: number; reason?: string; method?: string; path?: string };

/**
 * For tests: Drive v3's appDataFolder as an in-memory `fetch`, with the calls the Drive transport makes
 * (list with paging, download, resumable create and update, delete, about) and Google's token handling.
 * Every device of one account shares one fake.
 */
export function createFakeDrive() {
  let ids = 0;
  let tokens = 0;
  let sessions = 0;
  const openSessions = new Map<string, { name?: string; id?: string }>();

  const drive = {
    files: new Map<string, StoredFile>(),
    /** The user granted drive.appdata. */
    granted: true,
    account: { permissionId: "perm-1", emailAddress: "test@example.com" },
    /** The token Google's client hands out, and the ones Drive accepts. */
    current: "token-0",
    valid: new Set(["token-0"]),
    /** Files per list page. */
    pageSize: 100,
    /** Uploads fail with storageQuotaExceeded while set. */
    quotaFull: false,
    /** The next matching requests fail with these, in order. */
    failures: [] as Failure[],
    /** Runs before an upload's content lands, with the file's name: lets a test read mid-write. */
    beforeWrite: undefined as ((name: string) => Promise<void>) | undefined,
    requests: [] as string[],
    slept: [] as number[],
    revoked: [] as string[],
    cleared: [] as string[],
  };

  return Object.assign(drive, {
    /** The current token stops working (an hour passed); the client keeps handing it out until it is cleared. */
    expireToken() {
      drive.valid.delete(drive.current);
    },
    byName(name: string) {
      return [...drive.files.values()].find((file) => file.name === name);
    },
    names() {
      return [...drive.files.values()].map((file) => file.name).sort();
    },
    auth: {
      token: async (interactive: boolean) => {
        if (!drive.granted && interactive) drive.granted = true;
        return drive.granted ? drive.current : null;
      },
      clearToken: async (token: string) => {
        drive.cleared.push(token);
        if (token === drive.current) {
          drive.current = `token-${++tokens}`;
          drive.valid.add(drive.current);
        }
      },
      // As on a real device (HAU-778): revoking leaves the grant in place, and silent requests still get a token.
      revoke: async (email: string) => {
        drive.revoked.push(email);
      },
    } satisfies DriveAuth,
    sleep: async (ms: number) => void drive.slept.push(ms),
    fetch: (async (input: string, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      drive.requests.push(`${method} ${url.pathname}`);
      const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
        new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });
      const error = (status: number, reason: string) => reply(status, { error: { code: status, errors: [{ reason }], message: reason } });

      const auth = new Headers(init.headers).get("Authorization");
      if (!auth || !drive.valid.has(auth.replace("Bearer ", ""))) return error(401, "authError");
      const failure = drive.failures.findIndex(
        (candidate: Failure) => (!candidate.method || candidate.method === method) && (!candidate.path || url.pathname.includes(candidate.path)),
      );
      if (failure >= 0) {
        const [{ status, reason }] = drive.failures.splice(failure, 1);
        return error(status, reason ?? "backendError");
      }

      const path = url.pathname;
      if (method === "GET" && path === "/drive/v3/about") return reply(200, { user: drive.account });
      if (method === "GET" && path === "/drive/v3/files") {
        if (url.searchParams.get("spaces") !== "appDataFolder") return error(400, "badRequest");
        const all = [...drive.files.values()];
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const page = all.slice(start, start + drive.pageSize);
        return reply(200, {
          files: page.map(({ id, name, version }) => ({ id, name, version: String(version) })),
          ...(start + drive.pageSize < all.length ? { nextPageToken: String(start + drive.pageSize) } : {}),
        });
      }
      const fileId = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path)?.[1];
      if (fileId && method === "GET") {
        const file = drive.files.get(fileId);
        return file && url.searchParams.get("alt") === "media" ? reply(200, file.content) : error(404, "notFound");
      }
      if (fileId && method === "DELETE") return drive.files.delete(fileId) ? reply(204) : error(404, "notFound");
      if (path.startsWith("/upload/drive/v3/files") && (method === "POST" || method === "PATCH")) {
        if (url.searchParams.get("uploadType") !== "resumable") return error(400, "badRequest");
        if (fileId && !drive.files.has(fileId)) return error(404, "notFound");
        const meta = JSON.parse(String(init.body)) as { name?: string; parents?: string[] };
        if (!fileId && meta.parents?.[0] !== "appDataFolder") return error(400, "badRequest");
        const session = `s${++sessions}`;
        openSessions.set(session, { name: meta.name, id: fileId });
        return reply(200, undefined, { Location: `https://www.googleapis.com/upload/session/${session}` });
      }
      const session = /^\/upload\/session\/(.+)$/.exec(path)?.[1];
      if (session && method === "PUT") {
        const open = openSessions.get(session);
        if (!open) return error(404, "notFound");
        if (drive.quotaFull) return error(403, "storageQuotaExceeded");
        const name = open.id ? drive.files.get(open.id)?.name : open.name;
        if (!name) return error(404, "notFound");
        await drive.beforeWrite?.(name);
        openSessions.delete(session);
        const existing = open.id ? drive.files.get(open.id) : undefined;
        const file = existing
          ? { ...existing, version: existing.version + 1, content: String(init.body) }
          : { id: `file-${++ids}`, name, version: 1, content: String(init.body) };
        drive.files.set(file.id, file);
        return reply(200, { id: file.id, name: file.name, version: String(file.version) });
      }
      return error(400, `unhandled ${method} ${path}`);
    }) as Fetch,
  });
}

export type FakeDrive = ReturnType<typeof createFakeDrive>;
