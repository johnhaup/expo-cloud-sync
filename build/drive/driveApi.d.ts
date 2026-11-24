/** Google Drive v3 REST over `fetch`, limited to the app's hidden appDataFolder (scope drive.appdata). */
export type DriveFile = {
    id: string;
    name: string;
    version: string;
};
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
export declare class DriveError extends Error {
    readonly kind: DriveErrorKind;
    constructor(kind: DriveErrorKind, message: string);
}
/** The part of `fetch` the API uses. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type DriveApiOptions = {
    auth: DriveAuth;
    fetch?: Fetch;
    /** Waits between retries; tests pass one that does not wait. */
    sleep?: (ms: number) => Promise<void>;
};
export type DriveApi = ReturnType<typeof driveApi>;
export declare function driveApi({ auth, fetch: fetchFn, sleep }: DriveApiOptions): {
    /** Asks for a token (and consent when `interactive`); null when the user has not granted drive.appdata. */
    authorize(interactive: boolean): Promise<string | null>;
    /** Forgets the token held here (sign out). */
    forget(): void;
    /** Every file in appDataFolder, all pages. */
    list(): Promise<DriveFile[]>;
    download(id: string): Promise<string>;
    /**
     * Creates (no `id`) or replaces a file with a resumable upload (multipart stops at 5 MB). A session that
     * fails or expires is started over, as a whole, up to the retry count.
     */
    upload(name: string, body: string, id?: string): Promise<DriveFile>;
    /** Deletes a file; one already gone counts as deleted. */
    remove(id: string): Promise<void>;
    /** The signed-in user: `permissionId` is stable per account, `emailAddress` labels it. Works with drive.appdata. */
    about(): Promise<{
        permissionId: string;
        emailAddress: string;
    }>;
};
