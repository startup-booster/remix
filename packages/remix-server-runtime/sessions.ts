import type { CookieParseOptions, CookieSerializeOptions } from "cookie";

import type { Cookie, CookieOptions } from "./cookies";
import { createCookie, isCookie } from "./cookies";
import { warnOnce } from "./warnings";

/**
 * An object of name/value pairs to be used in the session.
 */
export interface SessionData {
  [name: string]: any;
}

/**
 * Session persists data across HTTP requests.
 */
export interface Session<SD = SessionData, FD = SD> {
  /**
   * A unique identifier for this session.
   *
   * Note: This will be the empty string for newly created sessions and
   * sessions that are not backed by a database (i.e. cookie-based sessions).
   */
  readonly id: string;

  /**
   * The raw data contained in this session.
   *
   * This is useful mostly for SessionStorage internally to access the raw
   * session data to persist.
   */
  readonly data: FlashSessionData<SD, FD>;

  /**
   * Returns `true` if the session has a value for the given `name`, `false`
   * otherwise.
   */
  has(name: (keyof SD | keyof FD) & string): boolean;

  /**
   * Returns the value for the given `name` in this session.
   */
  get<K extends (keyof SD | keyof FD) & string>(name: K): (
    | (K extends keyof SD ? SD[K] : undefined)
    | (K extends keyof FD ? FD[K] : undefined)
    | undefined
  );

  /**
   * Sets a value in the session for the given `name`.
   */
  set<K extends keyof SD & string>(name: K, value: SD[K]): void;

  /**
   * Sets a value in the session that is only valid until the next `get()`.
   * This can be useful for temporary values, like error messages.
   */
  flash<K extends keyof FD & string>(name: K, value: FD[K]): void;

  /**
   * Removes a value from the session.
   */
  unset(name: keyof SD & string): void;
}

export type FlashSessionData<SD, FD> = Partial<SD & {
  [K in keyof FD as FlashKey<K & string>]: FD[K];
}>
export type FlashKey<Name extends string> = `__flash_${Name}__`;
function flash<Name extends string>(name: Name): FlashKey<Name> {
  return `__flash_${name}__`;
}

/**
 * Creates a new Session object.
 *
 * Note: This function is typically not invoked directly by application code.
 * Instead, use a `SessionStorage` object's `getSession` method.
 */
export function createSession<SD = SessionData, FD = SD>(
  initialData: SD = {} as SD,
  id = ""
): Session<SD, FD> {
  const map = new Map(
    Object.entries(initialData)
  ) as Map<keyof SD | FlashKey<keyof FD & string>, any>;

  return {
    get id() {
      return id;
    },
    get data() {
      return Object.fromEntries(map) as SD;
    },
    has(name) {
      return map.has(name as keyof SD) ||
        map.has(flash(name as keyof FD & string));
    },
    get(name) {
      if (map.has(name as keyof SD)) return map.get(name as keyof SD);

      if (typeof name !== 'string') return undefined;

      let flashName = flash(name as keyof FD & string);
      if (map.has(flashName)) {
        let value = map.get(flashName);
        map.delete(flashName);
        return value;
      }

      return undefined;
    },
    set(name, value) {
      map.set(name, value);
    },
    flash(name, value) {
      map.set(flash(name), value);
    },
    unset(name) {
      map.delete(name);
    }
  };
}

export function isSession(object: any): object is Session {
  return (
    object != null &&
    typeof object.id === "string" &&
    typeof object.data !== "undefined" &&
    typeof object.has === "function" &&
    typeof object.get === "function" &&
    typeof object.set === "function" &&
    typeof object.flash === "function" &&
    typeof object.unset === "function"
  );
}

/**
 * SessionStorage stores session data between HTTP requests and knows how to
 * parse and create cookies.
 *
 * A SessionStorage creates Session objects using a `Cookie` header as input.
 * Then, later it generates the `Set-Cookie` header to be used in the response.
 */
export interface SessionStorage<SD = SessionData, FD = SD> {
  /**
   * Parses a Cookie header from a HTTP request and returns the associated
   * Session. If there is no session associated with the cookie, this will
   * return a new Session with no data.
   */
  getSession(
    cookieHeader?: string | null,
    options?: CookieParseOptions
  ): Promise<Session<SD, FD>>;

  /**
   * Stores all data in the Session and returns the Set-Cookie header to be
   * used in the HTTP response.
   */
  commitSession(
    session: Session<SD, FD>,
    options?: CookieSerializeOptions
  ): Promise<string>;

  /**
   * Deletes all data associated with the Session and returns the Set-Cookie
   * header to be used in the HTTP response.
   */
  destroySession(
    session: Session<SD, FD>,
    options?: CookieSerializeOptions
  ): Promise<string>;
}

/**
 * SessionIdStorageStrategy is designed to allow anyone to easily build their
 * own SessionStorage using `createSessionStorage(strategy)`.
 *
 * This strategy describes a common scenario where the session id is stored in
 * a cookie but the actual session data is stored elsewhere, usually in a
 * database or on disk. A set of create, read, update, and delete operations
 * are provided for managing the session data.
 */
export interface SessionIdStorageStrategy<SD = SessionData, FD = SD> {
  /**
   * The Cookie used to store the session id, or options used to automatically
   * create one.
   */
  cookie?: Cookie | (CookieOptions & { name?: string });

  /**
   * Creates a new record with the given data and returns the session id.
   */
  createData: (data: FlashSessionData<SD, FD>, expires?: Date) => Promise<string>;

  /**
   * Returns data for a given session id, or `null` if there isn't any.
   */
  readData: (id: string) => Promise<FlashSessionData<SD, FD> | null>;

  /**
   * Updates data for the given session id.
   */
  updateData: (
    id: string,
    data: FlashSessionData<SD, FD>,
    expires?: Date
  ) => Promise<void>;

  /**
   * Deletes data for a given session id from the data store.
   */
  deleteData: (id: string) => Promise<void>;
}

/**
 * Creates a SessionStorage object using a SessionIdStorageStrategy.
 *
 * Note: This is a low-level API that should only be used if none of the
 * existing session storage options meet your requirements.
 */
export function createSessionStorage<SD = SessionData, FD = SD>({
  cookie: cookieArg,
  createData,
  readData,
  updateData,
  deleteData
}: SessionIdStorageStrategy<SD, FD>): SessionStorage<SD, FD> {
  let cookie = isCookie(cookieArg)
    ? cookieArg
    : createCookie(cookieArg?.name || "__session", cookieArg);

  warnOnceAboutSigningSessionCookie(cookie);

  return {
    async getSession(cookieHeader, options) {
      let id = cookieHeader && (await cookie.parse(cookieHeader, options));
      let data = id && (await readData(id));
      return createSession(data || {}, id || "");
    },
    async commitSession(session, options) {
      let { id, data } = session;

      if (id) {
        await updateData(id, data, cookie.expires);
      } else {
        id = await createData(data, cookie.expires);
      }

      return cookie.serialize(id, options);
    },
    async destroySession(session, options) {
      await deleteData(session.id);
      return cookie.serialize("", {
        ...options,
        expires: new Date(0)
      });
    }
  };
}

export function warnOnceAboutSigningSessionCookie(cookie: Cookie) {
  warnOnce(
    cookie.isSigned,
    `The "${cookie.name}" cookie is not signed, but session cookies should be ` +
      `signed to prevent tampering on the client before they are sent back to the ` +
      `server. See https://remix.run/docs/en/v1/api/remix#signing-cookies ` +
      `for more information.`
  );
}
