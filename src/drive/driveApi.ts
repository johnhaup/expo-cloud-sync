/** Google Drive v3 REST over `fetch`, limited to the app's hidden appDataFolder (scope drive.appdata). */

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const RETRIES = 3;
const BACKOFF_MS = 1_000;

export type DriveFile = { id: string; name: string; version: string };

/** Android: AuthorizationClient in the native module. Fakes in tests. */
export type DriveAuth = {
  /** An access token for drive.appdata, or null when the user has not granted it. `interactive` may show Google's consent. */
  token(interactive: boolean): Promise<string | null>;
  /** Drops a token Drive refused, so the next `token` call fetches a fresh one. */
  clearToken(token: string): Promise<void>;
  /** Sign out: revoke this account's grant. */
  revoke(email: string): Promise<void>;
};

export type DriveErrorKind = "unauthorized" | "quota" | "retry" | "notFound" | "other";

export class DriveError extends Error {
  constructor(
    readonly kind: DriveErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

/** The part of `fetch` the API uses. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type DriveApiOptions = {
  auth: DriveAuth;
  fetch?: Fetch;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
};

const RATE_LIMITS = new Set(["userRateLimitExceeded", "rateLimitExceeded", "sharingRateLimitExceeded"]);

async function failure(response: Response, what: string) {
  let reason = "";
  try {
    const body = (await response.json()) as { error?: { errors?: { reason?: string }[]; message?: string } };
    reason = body.error?.errors?.[0]?.reason ?? body.error?.message ?? "";
  } catch {
    // Not JSON: the status says enough.
  }
  const { status } = response;
  const kind: DriveErrorKind =
    status === 401
      ? "unauthorized"
      : status === 403 && (reason === "storageQuotaExceeded" || reason === "quotaExceeded")
        ? "quota"
        : status === 429 || status >= 500 || (status === 403 && RATE_LIMITS.has(reason))
          ? "retry"
          : status === 404
            ? "notFound"
            : "other";
  return new DriveError(kind, `cloud-sync: Drive ${what} failed: ${status}${reason ? ` ${reason}` : ""}`);
}

export type DriveApi = ReturnType<typeof driveApi>;

export function driveApi({ auth, fetch: fetchFn = (url, init) => fetch(url, init), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: DriveApiOptions) {
  let token: string | null = null;

  /**
   * One call. A 401 clears the token, fetches a fresh one silently and tries once more; rate limits and 5xx are
   * retried with backoff (1 s, 2 s, 4 s). Throws a `DriveError` for anything else or when retries run out.
   */
  async function send(what: string, url: string, init: RequestInit = {}, retries = RETRIES): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; ) {
      token ??= await auth.token(false);
      if (!token) throw new DriveError("unauthorized", "cloud-sync: not signed in to Google");
      const response = await fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
      if (response.ok) return response;
      const error = await failure(response, what);
      if (error.kind === "unauthorized" && !refreshed) {
        refreshed = true;
        await auth.clearToken(token);
        token = null;
        continue;
      }
      if (error.kind === "unauthorized") token = null;
      if (error.kind !== "retry" || attempt >= retries) throw error;
      await sleep(BACKOFF_MS * 2 ** attempt++);
    }
  }

  const json = async <T>(response: Response) => (await response.json()) as T;

  return {
    /** Asks for a token (and consent when `interactive`); null when the user has not granted drive.appdata. */
    async authorize(interactive: boolean) {
      token = await auth.token(interactive);
      return token;
    },

    /** Forgets the token held here (sign out). */
    forget() {
      token = null;
    },

    /** Every file in appDataFolder, all pages. */
    async list(): Promise<DriveFile[]> {
      const files: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const url =
          `${API}/files?spaces=appDataFolder&pageSize=1000&fields=${encodeURIComponent("nextPageToken,files(id,name,version)")}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
        const page = await json<{ files?: DriveFile[]; nextPageToken?: string }>(await send("list", url));
        files.push(...(page.files ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return files;
    },

    async download(id: string): Promise<string> {
      return (await send("download", `${API}/files/${encodeURIComponent(id)}?alt=media`)).text();
    },

    /**
     * Creates (no `id`) or replaces a file with a resumable upload (multipart stops at 5 MB). A session that
     * fails or expires is started over, as a whole, up to the retry count.
     */
    async upload(name: string, body: string, id?: string): Promise<DriveFile> {
      const fields = encodeURIComponent("id,name,version");
      const url = id
        ? `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=resumable&fields=${fields}`
        : `${UPLOAD}/files?uploadType=resumable&fields=${fields}`;
      for (let attempt = 0; ; attempt++) {
        const session = await send("upload", url, {
          method: id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/json" },
          body: JSON.stringify(id ? {} : { name, parents: ["appDataFolder"] }),
        });
        const location = session.headers.get("Location");
        if (!location) throw new DriveError("other", "cloud-sync: Drive upload failed: no session URL");
        try {
          return await json<DriveFile>(await send("upload", location, { method: "PUT", headers: { "Content-Type": "application/json" }, body }, 0));
        } catch (error) {
          // The session URL itself answers 404 once it expires: start a new session, never treat it as a missing file.
          const restart = error instanceof DriveError && (error.kind === "retry" || error.kind === "notFound");
          if (!restart || attempt >= RETRIES) throw error instanceof DriveError && error.kind === "notFound" ? new DriveError("retry", error.message) : error;
          await sleep(BACKOFF_MS * 2 ** attempt);
        }
      }
    },

    /** Deletes a file; one already gone counts as deleted. */
    async remove(id: string) {
      try {
        await send("delete", `${API}/files/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (error) {
        if (!(error instanceof DriveError && error.kind === "notFound")) throw error;
      }
    },

    /** The signed-in user: `permissionId` is stable per account, `emailAddress` labels it. Works with drive.appdata. */
    async about() {
      const url = `${API}/about?fields=${encodeURIComponent("user(permissionId,emailAddress)")}`;
      return (await json<{ user: { permissionId: string; emailAddress: string } }>(await send("about", url))).user;
    },
  };
}
